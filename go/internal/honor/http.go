package honor

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

var statusRoute = regexp.MustCompile(`^/v([12])/honor/(GUID[0-9A-Z]{28})/([a-z0-9][a-z0-9._-]{0,79})/([0-9]+(?:\.[0-9]+){0,2})$`)

func honorRoute(path string) bool {
	switch path {
	case "/v1/honor/rules", "/v1/honor/rule-history", "/v1/honor/ranking", "/v1/honor/query", "/v2/honor/query", "/v2/honor/ranking":
		return true
	}
	return statusRoute.MatchString(path)
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !honorRoute(r.URL.Path) {
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
	v, e := h.dispatch(r, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		v = Object{"error": fault.Code(e), "requestId": id}
	}
	_ = json.NewEncoder(w).Encode(v)
}
func (h Handler) dispatch(r *http.Request, id string) (Object, error) {
	match := statusRoute.FindStringSubmatch(r.URL.Path)
	if len(match) > 0 && r.Method != "GET" || len(match) == 0 && r.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	s := h.Service
	if s == nil {
		return nil, fail("honor_unavailable", 503)
	}
	v2 := strings.HasPrefix(r.URL.Path, "/v2/")
	metadata := !v2 && (strings.HasSuffix(r.URL.Path, "/rules") || strings.HasSuffix(r.URL.Path, "/rule-history") || strings.HasSuffix(r.URL.Path, "/ranking"))
	var actor *Actor
	if !metadata && len(r.Header.Values("Authorization")) > 0 {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			return nil, fail("access_denied", 401)
		}
		if s.Devices == nil {
			return nil, fail("honor_authority_unavailable", 503)
		}
		a, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(auth, "Bearer "), "history")
		if e != nil {
			return nil, e
		}
		actor = &Actor{Actor: a, HTTPRequestID: &id}
	}
	var q Object
	if len(match) > 0 {
		q = Object{"subjectId": match[2], "ruleId": match[3], "ruleVersion": match[4]}
	} else {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fail("unsupported_media_type", 415)
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
		if e != nil {
			return nil, e
		}
		if len(raw) > 32768 {
			return nil, fail("request_too_large", 413)
		}
		if !utf8.Valid(raw) || !json.Valid(raw) || json.Unmarshal(raw, &q) != nil || q == nil {
			return nil, fail("invalid_json", 400)
		}
	}
	switch r.URL.Path {
	case "/v1/honor/rules":
		if len(q) != 0 {
			return nil, fail("invalid_request", 400)
		}
		return s.List(r.Context())
	case "/v1/honor/rule-history":
		return s.RuleHistory(r.Context(), q)
	case "/v1/honor/ranking":
		return s.Ranking(r.Context(), q)
	case "/v2/honor/ranking":
		return s.RankingV2(r.Context(), q)
	}
	if v2 {
		return s.QueryV2(r.Context(), actor, q)
	}
	return s.Query(r.Context(), actor, q)
}
