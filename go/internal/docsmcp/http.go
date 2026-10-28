package docsmcp

import (
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NewHandler consumes the same reviewed bundle as the old docs MCP server.
// The API's shared HTTP boundary owns its configured browser-origin policy.
func NewHandler(endpoint string, catalog *Catalog, next http.Handler) (http.Handler, error) {
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && u.Scheme != "http" || catalog == nil {
		return nil, invalidCatalog()
	}
	// The API normally listens on loopback behind the existing reverse proxy.
	// Its exact configured public Host is checked below before reaching the SDK;
	// the SDK's loopback-only Host heuristic would reject that valid deployment.
	transport := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return catalog.server() }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 32768, PropagateRequestCancellation: true, DisableLocalhostProtection: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp/docs" {
			if next != nil {
				next.ServeHTTP(w, r)
			} else {
				http.NotFound(w, r)
			}
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		status, code := 0, ""
		if r.Host != u.Host {
			status, code = 403, "invalid_host"
		} else if r.Method != "POST" {
			status, code = 405, "method_not_allowed"
		}
		if status != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "requestId": uuid.NewString()})
			return
		}
		transport.ServeHTTP(w, r)
	}), nil
}
