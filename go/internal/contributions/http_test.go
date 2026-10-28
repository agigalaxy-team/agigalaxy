package contributions

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOptionalCredentialPresence(t *testing.T) {
	h := Handler{Service: &Service{Devices: &deviceauth.Service{}}}
	r := httptest.NewRequest("POST", "/v2/contributions/read", strings.NewReader("{}"))
	r.Header.Set("Authorization", "")
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("supplied empty credential %d", w.Code)
	}
}
