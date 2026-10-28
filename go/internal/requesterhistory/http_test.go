package requesterhistory

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOptionalCredentialPresence(t *testing.T) {
	h := Handler{Service: &Service{}}
	for _, path := range []string{"/v2/requester-history/query", "/v2/requester-history/facts"} {
		r := httptest.NewRequest("POST", path, strings.NewReader("{}"))
		r.Header.Set("Authorization", "")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("supplied empty credential %s: %d", path, w.Code)
		}
	}
}
