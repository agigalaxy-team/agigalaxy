package native

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func interactionTestStore(t *testing.T) *Store {
	t.Helper()
	s, _ := NewStore(t.TempDir(), "https://galaxy.invalid")
	if _, e := s.Initialize(context.Background(), InitializationInput{Profile: "minimal"}, true, nil); e != nil {
		t.Fatal(e)
	}
	return s
}
func interactionChoice(t *testing.T, b *BrowserChoices, input BrowserChoiceInput, run choiceAction) map[string]any {
	t.Helper()
	result, e := b.Review(context.Background(), input, run)
	if e != nil {
		t.Fatal(e)
	}
	return initializationMap(result)
}
func interactionPost(t *testing.T, raw, origin, body string, headers map[string]string) int {
	t.Helper()
	request, e := http.NewRequest("POST", raw, strings.NewReader(body))
	if e != nil {
		t.Fatal(e)
	}
	request.Header.Set("Origin", origin)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range headers {
		if k == "Host" {
			request.Host = v
		} else {
			request.Header.Set(k, v)
		}
	}
	response, e := http.DefaultClient.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}
func waitForInteractionResult(t *testing.T, location, expected string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		response, err := http.Get(location)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), expected) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("review page did not show %q", expected)
}

func TestInteractionBrowserExactChoiceAndOriginalOperationOnce(t *testing.T) {
	ctx := context.Background()
	s := interactionTestStore(t)
	scope, _ := s.ChoiceScope(ctx)
	enabled := true
	args := ArchiveInput{Enabled: &enabled, Sessions: []ArchiveSession{{Host: "opencode", SessionID: "selected-session"}}}
	browser := NewBrowserChoices(s, nil)
	defer browser.Close()
	input := BrowserChoiceInput{Name: "galaxy_local_archive_configure", Input: args, Message: "保存所选会话 selected-session，不上传。<script>untrusted()</script>", Scope: scope}
	var calls atomic.Int64
	run := func(ctx context.Context, scope *ChoiceScope) (any, error) {
		calls.Add(1)
		return s.configureArchive(ctx, args, scope)
	}
	requestCtx, endRequest := context.WithCancel(ctx)
	value, err := browser.Review(requestCtx, input, run)
	endRequest()
	if err != nil {
		t.Fatal(err)
	}
	first := initializationMap(value)
	if first["state"] != "user-choice-needs-browser" || calls.Load() != 0 {
		t.Fatal(first)
	}
	again := interactionChoice(t, browser, input, run)
	if again["url"] != first["url"] {
		t.Fatal("pending choice token changed")
	}
	raw := text(first["url"])
	parsed, _ := url.Parse(raw)
	origin := parsed.Scheme + "://" + parsed.Host
	response, e := http.Get(raw)
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if strings.Contains(string(body), "<script>") || !strings.Contains(string(body), "&lt;script&gt;") {
		t.Fatal("choice content was interpreted as markup")
	}
	if !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") || response.Header.Get("Referrer-Policy") != "same-origin" {
		t.Fatal(response.Header)
	}
	if status := interactionPost(t, raw, "https://unrelated.invalid", "action=allow", nil); status != 403 {
		t.Fatal(status)
	}
	if status := interactionPost(t, raw, origin, "action=allow", map[string]string{"Sec-Fetch-Site": "cross-site"}); status != 403 {
		t.Fatal(status)
	}
	if status := interactionPost(t, raw, origin, "action=allow", map[string]string{"Host": "localhost"}); status != 403 {
		t.Fatal(status)
	}
	if status := interactionPost(t, raw, origin, "action=allow&action=decline", nil); status != 400 {
		t.Fatal(status)
	}
	if status := interactionPost(t, raw, origin, "action="+strings.Repeat("a", 201), nil); status != 413 {
		t.Fatal(status)
	}
	if status := interactionPost(t, raw, origin, "action=allow", nil); status != 200 {
		t.Fatal(status)
	}
	waitForInteractionResult(t, raw, "设置已保存。")
	saved := interactionChoice(t, browser, input, run)
	if saved["settings"] == nil || calls.Load() != 1 {
		t.Fatal(saved, calls.Load())
	}
	same(t, saved, interactionChoice(t, browser, input, run))
	if calls.Load() != 1 {
		t.Fatal("original operation ran again")
	}
	actual, e := s.ArchiveSettings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, saved["settings"], initializationMap(actual)["settings"])
	if e = browser.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e = http.Get(raw); e == nil {
		t.Fatal("closed review listener is still reachable")
	}
}

func TestClientConnectionProgressFollowsOnlyItsOwnFirstDevice(t *testing.T) {
	ctx := context.Background()
	store := interactionTestStore(t)
	original, _ := store.ChoiceScope(ctx)
	browser := NewBrowserChoices(store, nil)
	defer browser.Close()
	input := BrowserChoiceInput{Name: "galaxy_native_account_connect", Scope: original, FirstUseSelectionDigest: "original-selection", Input: map[string]any{}}
	interactionChoice(t, browser, input, func(context.Context, *ChoiceScope) (any, error) { return nil, nil })
	device := "093c482c-8aef-47e9-9267-6990b58a3461"
	if err := store.With(ctx, true, func(dir string) error {
		return uploadNativeRecordWithin(dir, "native-first-connect:"+original.Endpoint+":"+original.Owner, map[string]any{
			"selectionDigest": "original-selection", "scope": original,
			"request": map[string]any{"subjectId": original.Owner, "kind": "bootstrap", "newDevice": map[string]any{"deviceId": device}},
		})
	}); err != nil {
		t.Fatal(err)
	}
	next := original
	next.DeviceID, next.Revision = device, original.Revision+1
	if browser.accountProgress(ctx, next) == nil {
		t.Fatal("first-device transition lost its original connection")
	}
	next.DeviceID = "2f6dc03e-b94d-4d50-a87a-1f2a09f1669d"
	if browser.accountProgress(ctx, next) != nil {
		t.Fatal("another device inherited the connection operation")
	}
	next.DeviceID, next.Owner = device, "another-identity"
	if browser.accountProgress(ctx, next) != nil {
		t.Fatal("another identity inherited the connection operation")
	}
}
func TestInteractionBrowserCancellationExpiryAndScopeCannotApprove(t *testing.T) {
	ctx := context.Background()
	s := interactionTestStore(t)
	scope, _ := s.ChoiceScope(ctx)
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	browser := NewBrowserChoices(s, func() time.Time { return time.UnixMilli(clock.Load()) })
	defer browser.Close()
	input := BrowserChoiceInput{Name: "galaxy_native_connect", Input: map[string]any{}, Message: "仅连接当前设备", Scope: scope}
	calls := 0
	run := func(_ context.Context, _ *ChoiceScope) (any, error) {
		calls++
		return map[string]any{"connected": true}, nil
	}
	first := interactionChoice(t, browser, input, run)
	raw := text(first["url"])
	parsed, _ := url.Parse(raw)
	origin := parsed.Scheme + "://" + parsed.Host
	if status := interactionPost(t, raw, origin, "action=decline", nil); status != 200 {
		t.Fatal(status)
	}
	declined := interactionChoice(t, browser, input, run)
	if declined["state"] != "declined" || calls != 0 {
		t.Fatal(declined)
	}
	next := interactionChoice(t, browser, input, run)
	if next["url"] == raw {
		t.Fatal("delivered cancellation was reused")
	}
	response, e := http.Get(raw)
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if !strings.Contains(string(body), "已取消。") {
		t.Fatal(string(body))
	}
	currentRaw := text(next["url"])
	clock.Add(int64((6 * time.Minute) / time.Millisecond))
	response, e = http.Get(currentRaw)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("expired page still active", response.StatusCode)
	}
	fresh := interactionChoice(t, browser, input, run)
	freshRaw := text(fresh["url"])
	other, e := initializationNew("organization")
	if e != nil {
		t.Fatal(e)
	}
	var identity map[string]any
	if e = protocol.Decode(other.Identity, &identity); e != nil {
		t.Fatal(e)
	}
	if e = s.With(ctx, true, func(dir string) error { return writeJSON(filepath.Join(dir, "galaxy-id.json"), identity) }); e != nil {
		t.Fatal(e)
	}
	if status := interactionPost(t, freshRaw, origin, "action=allow", nil); status != 409 {
		t.Fatal(status)
	}
	if _, e = browser.Review(ctx, input, run); fault.Code(e) != "native_choice_binding_changed" {
		t.Fatal(e)
	}
	if calls != 0 {
		t.Fatal("cancelled/stale/expired choice ran an operation")
	}
}

func TestInteractionBrowserActualIsolatedHeadlessChoiceAndWindowClose(t *testing.T) {
	ctx := context.Background()
	store := interactionTestStore(t)
	scope, _ := store.ChoiceScope(ctx)
	browser := NewBrowserChoices(store, nil)
	defer browser.Close()
	var calls atomic.Int64
	for _, action := range []string{"allow", "decline", "window-close"} {
		t.Run(action, func(t *testing.T) {
			enabled := true
			selection := ArchiveInput{Enabled: &enabled, Sessions: []ArchiveSession{{Host: "opencode", SessionID: action}}}
			input := BrowserChoiceInput{Name: "galaxy_local_archive_configure", Input: selection, Message: "仅保存在这台设备：" + action, Scope: scope}
			run := func(ctx context.Context, scope *ChoiceScope) (any, error) {
				calls.Add(1)
				return store.configureArchive(ctx, selection, scope)
			}
			pending := interactionChoice(t, browser, input, run)
			before := calls.Load()
			script := `import {chromium} from 'playwright';const browser=await chromium.launch({headless:true});try{const context=await browser.newContext();const page=await context.newPage();await page.goto(process.argv[1]);const action=process.argv[2];if(action==='window-close'){await page.close();}else{await page.getByRole('button',{name:action==='allow'?'设置会话保存':'取消',exact:true}).click();await page.getByText(action==='allow'?'设置已保存。':'已取消。',{exact:true}).waitFor();}await context.close();console.log(JSON.stringify({isolatedHeadless:true,action}));}finally{await browser.close();}`
			result := initializationNode(t, script, text(pending["url"]), action)
			if result["isolatedHeadless"] != true {
				t.Fatal(result)
			}
			next := interactionChoice(t, browser, input, run)
			switch action {
			case "allow":
				if calls.Load() != before+1 || next["settings"] == nil {
					t.Fatal(next)
				}
			case "decline":
				if calls.Load() != before || next["state"] != "declined" {
					t.Fatal(next)
				}
			case "window-close":
				if calls.Load() != before || next["state"] != "user-choice-needs-browser" || next["url"] != pending["url"] {
					t.Fatal("closing the window granted approval", next)
				}
			}
		})
	}
}
