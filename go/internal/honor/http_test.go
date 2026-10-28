package honor

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOptionalCredentialPresence(t *testing.T) {
	h := Handler{Service: &Service{}}
	for _, path := range []string{"/v1/honor/query", "/v2/honor/query", "/v2/honor/ranking"} {
		r := httptest.NewRequest("POST", path, strings.NewReader("{}"))
		r.Header.Set("Authorization", "")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("supplied empty credential %s: %d", path, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/v1/honor/rules", strings.NewReader("{}"))
	r.Header.Set("Authorization", "invalid")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("original public metadata credential independence %d", w.Code)
	}
}
