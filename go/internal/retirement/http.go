package retirement

import (
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

// Handler is placed after normal CORS/probe handling and before business routes.
// Allowed routes still execute all original authentication/object checks.
func (c *Controller) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && (r.URL.Path == "/healthz" || r.URL.Path == "/readyz") {
			next.ServeHTTP(w, r)
			return
		}
		e := c.AssertRoute(r.Method, r.URL.EscapedPath())
		if e != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(fault.Status(e))
			_ = json.NewEncoder(w).Encode(map[string]any{"error": fault.Code(e), "requestId": uuid.NewString()})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/v1/service-status" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(c.Snapshot())
			return
		}
		next.ServeHTTP(w, r)
	})
}
