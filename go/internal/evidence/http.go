package evidence

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

type DeviceIdentity interface {
	Authenticate(context.Context, string, string) (deviceauth.Actor, error)
}
type Handler struct {
	Evidence *Service
	Proofs   *ProofService
	Devices  DeviceIdentity
	Next     http.Handler
}

var verificationPath = regexp.MustCompile(`^/v1/verifications/([0-9a-f-]{36})$`)
var proofPath = regexp.MustCompile(`^/v1/proofs/([0-9a-f-]{36})(/(status|revoke))?$`)

func body(r *http.Request, keys []string) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
	if e != nil {
		return nil, e
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var o Object
	if json.Unmarshal(raw, &o) != nil || !exact(o, keys, nil) {
		return nil, fault.New("invalid_request", 400)
	}
	return raw, nil
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	matched := r.Method == "POST" && (path == "/v1/evidence-submissions" || path == "/v1/proof-previews" || path == "/v1/proofs") || r.Method == "GET" && verificationPath.MatchString(path) || (r.Method == "POST" || r.Method == "GET") && proofPath.MatchString(path)
	if !matched {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", id)
	out, status, e := h.dispatch(r, id)
	if e != nil {
		status = fault.Status(e)
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) actor(r *http.Request, scope string, optional bool) (*deviceauth.Actor, error) {
	header, provided := r.Header["Authorization"]
	if optional && !provided {
		return nil, nil
	}
	if h.Devices == nil || len(header) == 0 || !strings.HasPrefix(header[0], "Bearer ") {
		return nil, fault.New("access_denied", 401)
	}
	a, e := h.Devices.Authenticate(r.Context(), strings.TrimPrefix(header[0], "Bearer "), scope)
	return &a, e
}
func (h Handler) dispatch(r *http.Request, id string) (Object, int, error) {
	proof := r.URL.Path != "/v1/evidence-submissions" && !verificationPath.MatchString(r.URL.Path)
	scope := "evidence"
	if proof {
		scope = "proof"
	}
	a, e := h.actor(r, scope, proof)
	if e != nil {
		return nil, 0, e
	}
	if !proof {
		if h.Evidence == nil {
			return nil, 0, fault.New("evidence_service_unavailable", 503)
		}
		if match := verificationPath.FindStringSubmatch(r.URL.Path); match != nil {
			v, e := h.Evidence.Get(r.Context(), *a, match[1])
			return v, 200, e
		}
		raw, e := body(r, []string{"consentId", "payloadJson"})
		if e != nil {
			return nil, 0, e
		}
		v, e := h.Evidence.Submit(r.Context(), *a, raw, id)
		return v, 202, e
	}
	if h.Proofs == nil {
		return nil, 0, fault.New("proof_service_unavailable", 503)
	}
	match := proofPath.FindStringSubmatch(r.URL.Path)
	if r.Method == "GET" && match != nil && match[3] != "revoke" {
		v, e := h.Proofs.Get(r.Context(), a, match[1], match[3] == "status")
		return v, 200, e
	}
	if a == nil {
		return nil, 0, fault.New("access_denied", 401)
	}
	switch r.URL.Path {
	case "/v1/proof-previews":
		raw, e := body(r, []string{"id", "evidenceId"})
		if e != nil {
			return nil, 0, e
		}
		v, e := h.Proofs.Preview(r.Context(), *a, raw)
		return v, 200, e
	case "/v1/proofs":
		raw, e := body(r, []string{"consentId", "payloadJson"})
		if e != nil {
			return nil, 0, e
		}
		v, e := h.Proofs.Publish(r.Context(), *a, raw, id)
		return v, 200, e
	}
	if r.Method == "POST" && match != nil && match[3] == "revoke" {
		if _, e := body(r, []string{}); e != nil {
			return nil, 0, e
		}
		v, e := h.Proofs.Revoke(r.Context(), *a, match[1], id)
		return v, 200, e
	}
	return nil, 0, fault.New("not_found", 404)
}
