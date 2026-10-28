package community

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForumHTTPPaginationOriginalPresence(t *testing.T) {
	limit := int64(1)
	boundary, e := httpboundary.New(httpboundary.Config{Endpoint: "https://community.example.invalid", SearchPageLimit: &limit})
	if e != nil {
		t.Fatal(e)
	}
	h := boundary.Handler(Handler{Service: &Service{Endpoint: "https://community.example.invalid"}})
	send := func(path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "https://community.example.invalid/v2/community/"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	// Ordinary after:null is explicitly supplied, charged before its invalid
	// cursor is rejected. A missing after never consumes this second quota.
	for range 2 {
		if w := send("accounts/query", `{"limit":0}`); w.Code == 429 {
			t.Fatal("absent cursor charged")
		}
	}
	if w := send("accounts/query", `{"after":null,"limit":0}`); w.Code == 429 {
		t.Fatal("first null page rejected")
	}
	if w := send("accounts/query", `{"after":null,"limit":0}`); w.Code != 429 || w.Header().Get("X-Galaxy-Quota-Category") != "search-pagination" {
		t.Fatalf("supplied null skipped: %d %s", w.Code, w.Body.String())
	}
	if w := send("posts/query", `{"after":null,"limit":0}`); w.Code == 429 {
		t.Fatal("nullish fallback charged undefined afterVersion")
	}
	if w := send("posts/11111111-1111-4111-8111-111111111111/versions", `{"afterVersion":0,"limit":0}`); w.Code != 429 {
		t.Fatal("numeric zero version cursor skipped quota")
	}
}
