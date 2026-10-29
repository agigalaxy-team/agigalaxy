package httpboundary

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type boundaryCase struct {
	Method        string            `json:"method"`
	URL           string            `json:"url"`
	Headers       map[string]string `json:"headers,omitempty"`
	RemoteAddress string            `json:"remoteAddress,omitempty"`
	Proxies       []string          `json:"proxies,omitempty"`
}
type originalDecision struct {
	Address, AddressError, URL, URLError, Category, WebsiteCategory string
	HasCredential, WebsiteCredential, Preflight                     bool
	BrowserError                                                    string
	Headers                                                         map[string]string
	Status                                                          int
}

func TestOriginalHTTPBoundaryDecisions(t *testing.T) {
	endpoint := "https://api.example.invalid"
	origins := []string{"https://web.example.invalid", "https://admin.example.invalid"}
	id := "11111111-1111-4111-8111-111111111111"
	guid := "GUID15" + strings.Repeat("A", 26)
	token := strings.Repeat("A", 43)
	paths := []string{"/v1/account/session?after=", "/v1/account/login?mode=register&returnTo=%2Fapp%2Faccount", "/v1/account/callback?code=x&state=y", "/v1/account/callback?state=x&state=y", "/v1/account/settings?extra=1", "/v1/account/follows/status", "/v1/account/feedback/operations/" + id, "/v1/account/data/feedback/exports/" + id + "?after=0&limit=50", "/v1/account/data/feedback/exports/" + id + "?after=00", "/v1/account/public/" + id + "/posts?after=fp1.abc&limit=20", "/v1/account/public/" + id + "/ids?limit=20", "/v1/account/public/by-id/" + guid + "?after=x", "/v1/web-events?cursor=0&topics=account,feedback&stream=true", "/v1/web-events?topics=bad_topic", "/v1/operations/web-events?cursor=01", "/v1/operations/permissions/catalog/lease?version=" + strings.Repeat("a", 64), "/v1/operations/login?returnTo=%2Fadmin", "/v1/operations/feedback?historyAfter=x", "/v1/operations/feedback?query=搜索&days=all", "/v1/operations/feedback/" + id + "?historyAfter=x", "/v1/operations/files?kind=a&issue=b", "/v1/operations/files?resourceId=bad", "/v1/operations/registered-users?page=1&participation=x", "/v1/operations/management-accounts?enabled=true", "/v1/operations/users?subjectType=person", "/v1/operations/users?subjectType=person&queue=x", "/v1/operations/audit?day=x&sort=y", "/v1/operations/users/" + id + "/audit?resourceId=x", "/v1/operations/autonomy/tasks?page=1&mode=x", "/v1/operations/maintenance/logs?component=a&before=b", "/v1/operations/messaging/runs/" + id + "/recipients?channel=x&state=y", "/v1/operations/summary?publicActivity=deferred", "/v1/operations/summary?publicActivity=no", "/v1/discovery/search?q=a&topic=b", "/v1/discovery/recommendations?mode=x", "/v2/community/posts/" + id, "/v2/community/posts/" + id + "/withdraw", "/v2/community/posts/query", "/v2/community/quotas?postId=" + id, "/v2/community/quotas?postId=" + id + "&replyId=" + id, "/v2/chat/rooms/" + id + "/messages/" + id + "/context", "/v2/chat/attachments/" + id + "/export-content", "/v2/chat/attachments/" + id + "/upload", "/v2/account-archives/status", "/v1/consents?after=" + id, "/v1/consents?after=a&after=b", "/v1/bindings/" + id + "/revoke", "/v1/session-challenges", "/v2/identity/control/challenges", "/v2/target-governance/events", "/v1/data-exports/page", "/.well-known/galaxy-network.json", "/v1/unknown?x=1", "/app/%2e%2e/v1/service-status"}
	cases := []boundaryCase{}
	for _, path := range paths {
		for _, method := range []string{"GET", "POST", "OPTIONS"} {
			for _, credential := range []string{"", "Bearer fixture"} {
				headers := map[string]string{"Origin": origins[0]}
				if credential != "" {
					headers["Authorization"] = credential
				}
				if method == "OPTIONS" {
					headers["Access-Control-Request-Method"] = "GET"
					headers["Access-Control-Request-Headers"] = "Authorization, Content-Type"
				}
				cases = append(cases, boundaryCase{Method: method, URL: path, Headers: headers})
			}
		}
	}
	for _, path := range []string{"/v1/account/settings", "/v1/account/logout", "/v1/operations/session", "/v1/discovery/search?q=test", "/v2/community/posts/query", "/v2/chat/attachments/" + id + "/upload", "/v2/account-archives/status", "/v1/account/external-credentials/" + id, "/v1/account/feedback/operations/" + id} {
		for _, requested := range []string{"GET", "POST", "PUT", "DELETE"} {
			for _, headers := range []string{"X-Galaxy-Account-ID, X-Galaxy-Account-CSRF", "X-Galaxy-Operator-CSRF", "X-Galaxy-Discovery-CSRF", "X-Unsafe"} {
				cases = append(cases, boundaryCase{Method: "OPTIONS", URL: path, Headers: map[string]string{"Origin": origins[0], "Access-Control-Request-Method": requested, "Access-Control-Request-Headers": headers}})
			}
		}
	}
	for _, cookie := range []string{"__Host-galaxy-account=" + token, "__Host-galaxy-account=" + token + "; galaxy-account-fixture=" + token, "__Host-galaxy-operator=" + token, "__Host-galaxy-account=bad"} {
		for _, path := range []string{"/v1/account/settings", "/v1/account/login", "/v1/operations/session", "/v1/discovery/search", "/v2/community/posts/query", "/v2/chat/rooms/directory"} {
			cases = append(cases, boundaryCase{Method: "POST", URL: path, Headers: map[string]string{"Cookie": cookie}})
		}
	}
	cases = append(cases, boundaryCase{Method: "GET", URL: "https://API.EXAMPLE.INVALID:443/v1/service-status"}, boundaryCase{Method: "GET", URL: "https://elsewhere.invalid/v1/service-status"}, boundaryCase{Method: "GET", URL: "/v1/service-status", Headers: map[string]string{"Origin": "https://elsewhere.invalid"}}, boundaryCase{Method: "GET", URL: "/v1/service-status", RemoteAddress: "::ffff:127.0.0.1"}, boundaryCase{Method: "GET", URL: "/v1/service-status", RemoteAddress: "127.0.0.1", Proxies: []string{"127.0.0.1", "10.0.0.1"}, Headers: map[string]string{"X-Forwarded-For": "198.51.100.1, 10.0.0.1"}}, boundaryCase{Method: "GET", URL: "/v1/service-status", RemoteAddress: "127.0.0.1", Proxies: []string{"127.0.0.1"}, Headers: map[string]string{"X-Forwarded-For": "forged, 198.51.100.1"}}, boundaryCase{Method: "GET", URL: "/v1/service-status", RemoteAddress: "198.51.100.2", Proxies: []string{"127.0.0.1"}, Headers: map[string]string{"X-Forwarded-For": "forged"}})
	output, e := os.ReadFile("testdata/http-decisions.json")
	if e != nil {
		t.Fatal(e)
	}
	var original struct{ Requests []originalDecision }
	if e = json.Unmarshal(output, &original); e != nil {
		t.Fatal(e)
	}
	for i, c := range cases {
		r := &http.Request{Method: c.Method, RequestURI: c.URL, Header: make(http.Header), RemoteAddr: c.RemoteAddress}
		if r.RemoteAddr == "" {
			r.RemoteAddr = "127.0.0.1"
		}
		for k, v := range c.Headers {
			r.Header.Set(k, v)
		}
		want := original.Requests[i]
		reader, e := NewAddressReader(c.Proxies)
		if e != nil {
			t.Fatal(e)
		}
		address, e := reader.Read(r)
		code := ""
		if e != nil {
			code = fault.Code(e)
		}
		if address != want.Address || code != want.AddressError {
			t.Fatalf("address %d %+v: %q/%q want %q/%q", i, c, address, code, want.Address, want.AddressError)
		}
		u, e := RequestURL(r, endpoint, origins)
		code = ""
		if e != nil {
			code = fault.Code(e)
		}
		if code != want.URLError {
			t.Fatalf("URL %d %s %s: %q want %q", i, c.Method, c.URL, code, want.URLError)
		}
		if e != nil {
			continue
		}
		if u.String() != want.URL {
			t.Fatalf("URL bytes %d: %q want %q", i, u.String(), want.URL)
		}
		r.URL = u
		path := u.EscapedPath()
		if HasRequestCredential(r, path) != want.HasCredential || (WebsiteQuotaCredential(r, path) != "") != want.WebsiteCredential || Category(c.Method, path, HasRequestCredential(r, path), false) != want.Category || Category(c.Method, path, true, true) != want.WebsiteCategory {
			t.Fatalf("credential category %d %+v", i, c)
		}
		w := httptest.NewRecorder()
		done, e := ApplyBrowserPolicy(r, w, origins)
		code = ""
		if e != nil {
			code = fault.Code(e)
		}
		headers := map[string]string{}
		for key, values := range w.Header() {
			headers[strings.ToLower(key)] = strings.Join(values, ", ")
		}
		if code != want.BrowserError || done != want.Preflight || !reflect.DeepEqual(headers, want.Headers) {
			t.Fatalf("CORS %d %s %s: done=%v code=%s headers=%v want=%+v", i, c.Method, c.URL, done, code, headers, want)
		}
	}
	t.Logf("original HTTP boundary parity: %d request/header cases", len(cases))
}
