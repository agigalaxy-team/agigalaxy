package httpboundary

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccountCommentPortalBoundary(t *testing.T) {
	origin := "https://web.example.invalid"
	token := strings.Repeat("A", 43)
	routes := []struct{ path, category string }{
		{"/v2/account-comments/events", "submission"},
		{"/v2/account-comments/query", "query"},
		{"/v2/account-comments/receipt", "query"},
		{"/v2/account-comments/get", "query"},
		{"/v2/account-comment-governance/events", "submission"},
		{"/v2/account-comment-governance/query", "query"},
		{"/v2/account-comment-governance/receipt", "query"},
	}
	for _, route := range routes {
		t.Run(route.path, func(t *testing.T) {
			request := httptest.NewRequest("POST", route.path, nil)
			request.Header.Set("Cookie", "__Host-galaxy-account="+token)
			request.Header.Set("Origin", origin)
			if got := WebsiteQuotaCredential(request, route.path); got != token {
				t.Fatal("portal credential not identified")
			}
			if got := Category("POST", route.path, true, true); got != route.category {
				t.Fatalf("verified category %q want %q", got, route.category)
			}
			expectedUnauth := "anonymous"
			if route.category == "submission" {
				expectedUnauth = "submission"
			}
			if got := Category("POST", route.path, false, false); got != expectedUnauth {
				t.Fatalf("unverified category %q", got)
			}
			response := httptest.NewRecorder()
			done, err := ApplyBrowserPolicy(request, response, []string{origin})
			if err != nil || done || response.Header().Get("Access-Control-Allow-Credentials") != "true" || response.Header().Get("Access-Control-Allow-Origin") != origin {
				t.Fatalf("request CORS: %v %v %v", done, err, response.Header())
			}
			pre := httptest.NewRequest("OPTIONS", route.path, nil)
			pre.Header.Set("Origin", origin)
			pre.Header.Set("Access-Control-Request-Method", "POST")
			pre.Header.Set("Access-Control-Request-Headers", "content-type, x-galaxy-account-id, x-galaxy-account-csrf")
			w := httptest.NewRecorder()
			done, err = ApplyBrowserPolicy(pre, w, []string{origin})
			if err != nil || !done || w.Code != 204 || w.Header().Get("Access-Control-Allow-Credentials") != "true" {
				t.Fatalf("preflight %v %v %d %v", done, err, w.Code, w.Header())
			}
			headers := w.Header().Get("Access-Control-Allow-Headers")
			if !strings.Contains(headers, "X-Galaxy-Account-ID") || !strings.Contains(headers, "X-Galaxy-Account-CSRF") {
				t.Fatal(headers)
			}
			duplicate := httptest.NewRequest("POST", route.path, nil)
			duplicate.Header.Set("Cookie", "__Host-galaxy-account="+token+"; galaxy-account-fixture="+token)
			if WebsiteQuotaCredential(duplicate, route.path) != "" {
				t.Fatal("duplicate session cookies accepted")
			}
			wrongMethod := httptest.NewRequest("GET", route.path, nil)
			wrongMethod.Header.Set("Cookie", "__Host-galaxy-account="+token)
			wrongMethod.Header.Set("Origin", origin)
			if WebsiteQuotaCredential(wrongMethod, route.path) != "" {
				t.Fatal("wrong method got account credential")
			}
			wrongResponse := httptest.NewRecorder()
			_, err = ApplyBrowserPolicy(wrongMethod, wrongResponse, []string{origin})
			if err != nil || wrongResponse.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatalf("wrong method got account CORS: %v %v", err, wrongResponse.Header())
			}
			request.Header.Set("Authorization", "Bearer ignored")
			if WebsiteQuotaCredential(request, route.path) != "" {
				t.Fatal("cookie used alongside bearer")
			}
		})
	}
	for _, path := range []string{"/v2/account-comments/unknown", "/v2/account-comments/query/extra", "/v2/account-comment-governance/get", "/v2/account-comment-governance/events/extra", "/v2/account-other/query"} {
		t.Run("unknown:"+path, func(t *testing.T) {
			req := httptest.NewRequest("POST", path, nil)
			req.Header.Set("Cookie", "__Host-galaxy-account="+token)
			req.Header.Set("Origin", origin)
			if WebsiteQuotaCredential(req, path) != "" {
				t.Fatal("unknown path got portal credential")
			}
			w := httptest.NewRecorder()
			_, e := ApplyBrowserPolicy(req, w, []string{origin})
			if e != nil || w.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatalf("unknown request CORS %v %v", e, w.Header())
			}
			pre := httptest.NewRequest("OPTIONS", path, nil)
			pre.Header.Set("Origin", origin)
			pre.Header.Set("Access-Control-Request-Method", "POST")
			pre.Header.Set("Access-Control-Request-Headers", "x-galaxy-account-id, x-galaxy-account-csrf")
			w = httptest.NewRecorder()
			done, e := ApplyBrowserPolicy(pre, w, []string{origin})
			if e == nil || done || w.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatalf("unknown preflight admitted %v %v %v", done, e, w.Header())
			}
		})
	}
}
