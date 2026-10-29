package identityreturn

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func node(t *testing.T, script string, args ...string) map[string]json.RawMessage {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	cmd := exec.Command("node", append([]string{"--input-type=module", "-e", script}, args...)...)
	cmd.Dir = root
	raw, e := cmd.Output()
	if e != nil {
		if failed, ok := e.(*exec.ExitError); ok {
			t.Fatalf("isolated Node check: %v: %s", e, failed.Stderr)
		}
		t.Fatal(e)
	}
	var result map[string]json.RawMessage
	if e = json.Unmarshal(raw, &result); e != nil {
		t.Fatalf("invalid check output: %v", e)
	}
	return result
}
func TestOriginalHTMLBytesCSPAndAcceptNegotiation(t *testing.T) {
	vectors := []map[string]string{{}, {"accept": "application/json"}, {"accept": "text/html"}, {"accept": "text/html;q=0,application/json"}, {"accept": "text/html;q=.5,application/json;q=1"}, {"accept": "text/html;q=.5,application/json;q=.4"}, {"accept": "text/html;q=1,application/json;q=1"}, {"accept": "text/html,application/xhtml+xml;q=.9,*/*;q=.8"}, {"accept": "text/html", "sec-fetch-mode": "cors"}, {"accept": "text/html", "sec-fetch-mode": "navigate"}, {"accept": "text/html;q=Infinity"}, {"accept": "text/html;q=2"}, {"accept": "text/html;q=0x1,application/json;q=0"}, {"accept": "text/html;q=1,text/html;q=0"}, {"accept": "text/html ;q=1"}, {"accept": "text/html;q="}, {"accept": "text/html;q=.5;q=0"}}
	raw, e := os.ReadFile("testdata/original-page.json")
	if e != nil {
		t.Fatal(e)
	}
	var original map[string]json.RawMessage
	if e = json.Unmarshal(raw, &original); e != nil {
		t.Fatal(e)
	}
	var pages []string
	_ = json.Unmarshal(original["pages"], &pages)
	variants := []struct {
		success              bool
		status               int
		association, expired bool
	}{{true, 200, true, false}, {false, 409, true, false}, {false, 500, true, false}, {false, 404, true, true}, {false, 400, false, false}, {false, 503, false, false}}
	var styleHash, scriptHash string
	json.Unmarshal(original["styleHash"], &styleHash)
	json.Unmarshal(original["scriptHash"], &scriptHash)
	for i, variant := range variants {
		if got := string(pageBytes(variant.success, variant.status, variant.association, variant.expired)); got != pages[i] {
			t.Fatalf("original HTML bytes changed for variant %d", i)
		}
		w := httptest.NewRecorder()
		htmlResponse(w, variant.success, variant.status, variant.association, variant.expired)
		csp := w.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "'sha256-"+styleHash+"'") || variant.association && !strings.Contains(csp, "'sha256-"+scriptHash+"'") || strings.Contains(csp, "unsafe-inline") || strings.Contains(csp, "unsafe-eval") {
			t.Fatal(csp)
		}
		if !variant.association && strings.Contains(w.Body.String(), "<script") {
			t.Fatal("navigation error unexpectedly includes script")
		}
	}
	var expected []bool
	json.Unmarshal(original["negotiation"], &expected)
	for i, headers := range vectors {
		r := httptest.NewRequest("GET", "https://official.invalid/v1/identity/callback/account", nil)
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		if got := AcceptsHTML(r); got != expected[i] {
			t.Fatalf("Accept contract changed for %v: %v != %v", headers, got, expected[i])
		}
	}
}

type callbackFixture struct {
	handler   *Handler
	server    *httptest.Server
	clock     atomic.Int64
	calls     atomic.Int64
	nextCalls atomic.Int64
	mu        sync.Mutex
	failures  []struct {
		status int
		code   string
	}
}

func fixture(t *testing.T) *callbackFixture {
	t.Helper()
	f := &callbackFixture{}
	f.clock.Store(time.Now().UnixMilli())
	handler, e := New(Options{Endpoint: "https://official.invalid", Now: func() time.Time { return time.UnixMilli(f.clock.Load()) }, Callback: func(ctx context.Context, provider, returned string) (string, error) {
		f.calls.Add(1)
		if !strings.HasPrefix(returned, "https://official.invalid/v1/identity/callback/") {
			t.Error("callback used request Host instead of configured endpoint")
		}
		switch provider {
		case "ready":
			return "awaiting-local-signature", nil
		case "rejected":
			return "", fault.New("identity_login_failed", 401)
		case "inactive":
			return "", fault.New("identity_login_unavailable", 409)
		case "unexpected":
			return "not-the-existing-callback-state", nil
		case "badstatus":
			return "", fault.New("invalid_status", 399)
		default:
			return "", errors.New("PRIVATE UPSTREAM MUST NEVER BE SHOWN")
		}
	}, Next: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.nextCalls.Add(1)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if strings.Contains(r.URL.Path, "/rejected") {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":"identity_login_failed","requestId":"original-json-contract"}`)
			return
		}
		io.WriteString(w, `{"state":"awaiting-local-signature","galaxyAuthorization":false}`)
	}), RecordFailure: func(ctx context.Context, status int, code string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.failures = append(f.failures, struct {
			status int
			code   string
		}{status, code})
	}})
	if e != nil {
		t.Fatal(e)
	}
	f.handler = handler
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(f.server.Close)
	return f
}
func request(t *testing.T, raw, accept string) *http.Response {
	t.Helper()
	r, e := http.NewRequest("GET", raw, nil)
	if e != nil {
		t.Fatal(e)
	}
	r.Header.Set("Accept", accept)
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	return response
}
func responseText(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	raw, e := io.ReadAll(response.Body)
	if e != nil {
		t.Fatal(e)
	}
	return string(raw)
}
func TestActualHTTPCallbackCleanTicketsErrorsExpiryAndJSONContract(t *testing.T) {
	f := fixture(t)
	for _, provider := range []string{"ready", "rejected", "inactive", "unknown", "unexpected", "badstatus"} {
		t.Run(provider, func(t *testing.T) {
			before := f.calls.Load()
			response := request(t, f.server.URL+"/v1/identity/callback/"+provider+"?code=DO-NOT-REFLECT-CODE&state=DO-NOT-REFLECT-STATE", "text/html")
			if response.StatusCode != 303 || responseText(t, response) != "" {
				t.Fatal("callback was not an empty 303")
			}
			path := response.Header.Get("Location")
			if !returnPath.MatchString(path) || strings.Contains(path, "?") {
				t.Fatal(path)
			}
			if response.Header.Get("Content-Type") != "" || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Fatal(response.Header)
			}
			returned := request(t, f.server.URL+path, "text/html")
			body := responseText(t, returned)
			expected := map[string]int{"ready": 200, "rejected": 401, "inactive": 409, "unknown": 500, "unexpected": 500, "badstatus": 500}[provider]
			if returned.StatusCode != expected || strings.Contains(body, "DO-NOT-REFLECT") || strings.Contains(body, "PRIVATE UPSTREAM") || strings.Contains(body, "identity_login_") {
				t.Fatal("callback state or confidentiality changed", returned.StatusCode)
			}
			if returned.Header.Get("Vary") != "Origin, Accept" || returned.Header.Get("X-Frame-Options") != "DENY" {
				t.Fatal(returned.Header)
			}
			refresh := request(t, f.server.URL+path, "text/html")
			if refresh.StatusCode != expected {
				t.Fatal(refresh.StatusCode)
			}
			refresh.Body.Close()
			if f.calls.Load() != before+1 {
				t.Fatal("return refresh executed callback again")
			}
			appended := request(t, f.server.URL+path+"?code=discard&state=discard", "text/html")
			appended.Body.Close()
			if appended.StatusCode != 303 || appended.Header.Get("Location") != path {
				t.Fatal("callback query was not stripped")
			}
		})
	}
	if len(f.failures) != 5 {
		t.Fatal("failure audit count", len(f.failures))
	}
	if f.failures[0].status != 401 || f.failures[0].code != "identity_login_failed" {
		t.Fatal(f.failures)
	}
	before := f.calls.Load()
	for _, accept := range []string{"application/json", "text/html;q=0,application/json", "text/html;q=.5,application/json;q=1"} {
		response := request(t, f.server.URL+"/v1/identity/callback/ready?code=json-contract", accept)
		if response.StatusCode != 200 || responseText(t, response) != `{"state":"awaiting-local-signature","galaxyAuthorization":false}` || response.Header.Get("Location") != "" {
			t.Fatal("JSON callback contract changed")
		}
	}
	if f.calls.Load() != before || f.nextCalls.Load() != 3 {
		t.Fatal("wrapper consumed JSON callback instead of delegating")
	}
	rejected := request(t, f.server.URL+"/v1/identity/callback/rejected", "application/json")
	if rejected.StatusCode != 401 || !strings.Contains(responseText(t, rejected), "original-json-contract") {
		t.Fatal("original JSON error was replaced")
	}
	path := f.handler.remember(true, 200)
	f.clock.Add(returnLifetime.Milliseconds())
	expired := request(t, f.server.URL+path, "text/html")
	if expired.StatusCode != 404 || !strings.Contains(responseText(t, expired), "链接已过期") {
		t.Fatal("expired ticket was presented as success")
	}
	for i := 0; i < returnLimit; i++ {
		f.handler.remember(true, 200)
	}
	f.handler.mu.Lock()
	defer f.handler.mu.Unlock()
	if len(f.handler.tickets) != returnLimit {
		t.Fatal("display ticket bound was not preserved")
	}
}
func TestAccountNavigationErrorUsesSameOriginalTemplateAndLeavesJSONAlone(t *testing.T) {
	f := fixture(t)
	for _, err := range []error{fault.New("invalid_account_return", 400), fault.New("official_account_unavailable", 503)} {
		r := httptest.NewRequest("GET", "https://official.invalid/v1/account/login?returnTo=DO-NOT-REFLECT", nil)
		r.Header.Set("Accept", "text/html")
		w := httptest.NewRecorder()
		if !f.handler.NavigationError(w, r, err) {
			t.Fatal("navigation error not handled")
		}
		if !strings.Contains(w.Body.String(), "银河在线账户") || strings.Contains(w.Body.String(), "<script") || strings.Contains(w.Body.String(), "DO-NOT-REFLECT") {
			t.Fatal("navigation UI changed")
		}
		r.Header.Set("Accept", "application/json")
		w = httptest.NewRecorder()
		if f.handler.NavigationError(w, r, err) || w.Body.Len() != 0 {
			t.Fatal("JSON route was overwritten")
		}
	}
}
func TestActualIsolatedHeadlessReturnWindow(t *testing.T) {
	f := fixture(t)
	script := `import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {chromium} from 'playwright';
const base=process.argv[1];
const get=url=>new Promise((resolve,reject)=>{const request=httpRequest(url,{headers:{accept:'text/html','sec-fetch-mode':'navigate'}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));});request.on('error',reject);request.end();});
const browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
try{
 const context=await browser.newContext(),errors=[],paths=[];
 const originHtml='<!doctype html><button id="open">Open return window</button><script>window.messages=[];addEventListener("message",event=>messages.push({data:event.data,origin:event.origin}));document.querySelector("button").onclick=()=>open(window.returnPath,"galaxy-return");</script>';
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin===base){await route.continue();return;}
  if(url.origin!=='https://agigalaxy.org'){await route.abort();return;}
  if(url.pathname==='/synthetic-origin'){await route.fulfill({contentType:'text/html',body:originHtml});return;}
  if(!/^\/v1\/identity\/return\/[0-9a-f-]{36}$/.test(url.pathname)||url.search){await route.abort();return;}
  const response=await get(base+url.pathname);assert.ok([200,401].includes(response.status));paths.push(url.pathname);
  const headers={...response.headers};delete headers['transfer-encoding'];delete headers['content-length'];
  await route.fulfill({status:response.status,headers,body:response.body});
 });
 const plain=await context.newPage();plain.on('pageerror',e=>errors.push(e.message));
 await plain.goto(base+'/v1/identity/callback/ready?code=DO-NOT-REFLECT-CODE&state=DO-NOT-REFLECT-STATE');
 assert.match(plain.url(),/\/v1\/identity\/return\/[0-9a-f-]{36}$/);
 assert.equal(await plain.locator('h1').textContent(),'继续关联账户');assert.equal(await plain.locator('#return-to-origin').isHidden(),true);
 for(const width of [390,1366]){await plain.setViewportSize({width,height:800});assert.equal(await plain.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}await plain.close();
 const opener=await context.newPage();opener.on('pageerror',e=>errors.push(e.message));await opener.goto('https://agigalaxy.org/synthetic-origin');
 for(const provider of ['ready','rejected']){
  const response=await get(base+'/v1/identity/callback/'+provider+'?code=DO-NOT-REFLECT-CODE&state=DO-NOT-REFLECT-STATE');
  assert.equal(response.status,303);assert.equal(response.body.length,0);assert.match(response.headers.location,/^\/v1\/identity\/return\/[0-9a-f-]{36}$/);
  await opener.evaluate(path=>{window.messages=[];window.returnPath=path;},response.headers.location);
  const popupPromise=opener.waitForEvent('popup');await opener.click('#open');const popup=await popupPromise;
  await opener.waitForFunction(()=>messages.length===1,null,{timeout:5000}).catch(async()=>{throw Error(JSON.stringify({provider,popupClosed:popup.isClosed(),popupPath:popup.isClosed()?null:new URL(popup.url()).pathname,popupTitle:popup.isClosed()?null:await popup.title(),seen:await opener.evaluate(()=>window.messages),errors}));});
  assert.deepEqual(await opener.evaluate(()=>messages),[{data:{type:'galaxy:identity-account-return'},origin:'https://agigalaxy.org'}]);
  if(provider==='ready'){if(!popup.isClosed())await popup.waitForEvent('close');}
  else{await popup.locator('h1').waitFor();assert.equal(await popup.locator('h1').textContent(),'登录未完成');assert.equal(popup.isClosed(),false);assert.equal(await popup.locator('#return-to-origin').isVisible(),true);assert.ok(!await popup.locator('body').textContent().then(text=>text.includes('DO-NOT-REFLECT')));await popup.close();}
 }
 assert.equal(paths.length,2);assert.deepEqual(errors,[]);await context.close();
 console.log(JSON.stringify({isolatedHeadless:true,clean303:true,successReturnedAndClosed:true,failureRemainsReadable:true,fixedOriginHintOnly:true,noHorizontalOverflow:true}));
}finally{await browser.close();}`
	result := node(t, script, f.server.URL)
	for key, value := range result {
		if string(value) != "true" {
			t.Fatal(key, string(value))
		}
	}
	if f.calls.Load() != 3 {
		t.Fatal("browser repeated callback", f.calls.Load())
	}
}
