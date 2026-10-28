package servicemetadata

import (
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	known := r.URL.Path == "/.well-known/galaxy-network.json" || r.URL.Path == "/.well-known/galaxy-signing-keys.json" || r.URL.Path == "/v1/policy" || r.URL.Path == "/v1/signing-keys/status"
	if !known || r.Method != "GET" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	var result any
	var e error
	if h.Service == nil {
		e = fault.New("service_unavailable", 503)
	} else {
		s := h.Service
		switch r.URL.Path {
		case "/.well-known/galaxy-signing-keys.json":
			result = s.c.Keyring
		case "/v1/policy":
			result = s.data["policy"]
		case "/v1/signing-keys/status":
			keys := s.c.KeyStatuses()
			if keys == nil {
				keys = []KeyStatus{}
			}
			result = map[string]any{"keys": keys, "trustSource": "client-pinned-configuration", "checkedAt": s.c.Now().Unix()}
		case "/.well-known/galaxy-network.json":
			var etag string
			result, etag, e = s.manifest(r.Context())
			if e == nil {
				w.Header().Set("ETag", etag)
				w.Header().Set("Cache-Control", "public, max-age=60, must-revalidate")
				if r.Header.Get("If-None-Match") == etag {
					w.WriteHeader(304)
					return
				}
			}
		}
	}
	if e != nil {
		w.WriteHeader(fault.Status(e))
		result = map[string]any{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(result)
}
