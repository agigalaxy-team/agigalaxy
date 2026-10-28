package operationscommunity

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

type Handler struct {
	Service *Service
	Next    http.Handler
}

const routeID = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

var route = regexp.MustCompile(`^/v1/operations/community/(sections|posts|reports)(?:/(` + routeID + `)(?:/(classification|visibility|resolve)|/operations/(` + routeID + `))?)?$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if contentMatches(r.URL.Path) {
		h.contentHTTP(w, r)
		return
	}
	m := route.FindStringSubmatch(r.URL.Path)
	if m == nil {
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
	out, e := h.dispatch(r, m, id)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": id}
	}
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, m []string, requestID string) (Object, error) {
	s := h.Service
	if s == nil || s.Authority == nil {
		return nil, fail("business_admin_unavailable", 503)
	}
	write := m[3] != ""
	method := "GET"
	if write {
		method = "POST"
	}
	if r.Method != method || write && r.URL.RawQuery != "" || m[4] != "" && r.URL.RawQuery != "" {
		return nil, fail("not_found", 404)
	}
	if m[1] == "posts" && (write || m[4] != "") || m[1] == "sections" && m[3] == "resolve" || m[1] == "reports" && has([]string{"classification", "visibility"}, m[3]) {
		return nil, fail("not_found", 404)
	}
	required := map[string]string{"sections": "sections.read", "posts": "content.read", "reports": "cases.read"}[m[1]]
	if write {
		required = ""
		if m[3] == "classification" {
			required = "sections.classify"
		}
		if m[3] == "resolve" {
			required = "cases.resolve"
		}
	}
	a, e := s.Authority.AuthorizeOperations(r, write, required)
	if e != nil {
		return nil, e
	}
	a.RequestID = &requestID
	if m[4] != "" {
		family := "section"
		if m[1] == "reports" {
			family = "case"
		}
		return s.CommandResult(r.Context(), a, family, m[2], m[4])
	}
	input := Object{}
	if write {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			return nil, fail("unsupported_media_type", 415)
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 16385))
		if e != nil {
			return nil, e
		}
		if len(raw) > 16384 {
			return nil, fail("request_too_large", 413)
		}
		if e = protocol.Decode(raw, &input); e != nil || input == nil {
			return nil, fail("invalid_json", 409)
		}
	} else {
		if m[2] != "" && r.URL.RawQuery != "" {
			return nil, invalid()
		}
		q, e := url.ParseQuery(r.URL.RawQuery)
		if e != nil {
			return nil, invalid()
		}
		for k, v := range q {
			if len(v) != 1 {
				return nil, invalid()
			}
			if k == "limit" {
				n, err := strconv.ParseFloat(v[0], 64)
				if err != nil {
					return nil, invalid()
				}
				input[k] = n
			} else {
				input[k] = v[0]
			}
		}
	}
	ctx := r.Context()
	switch m[1] {
	case "sections":
		if m[2] == "" {
			return s.Sections(ctx, a, input)
		}
		switch m[3] {
		case "classification":
			return s.Classify(ctx, a, m[2], input)
		case "visibility":
			return s.SectionVisibility(ctx, a, m[2], input)
		}
		return s.Section(ctx, a, m[2])
	case "posts":
		if m[2] == "" {
			return s.Posts(ctx, a, input)
		}
		return s.Post(ctx, a, m[2])
	default:
		if m[2] == "" {
			return s.Reports(ctx, a, input)
		}
		if write {
			return s.Resolve(ctx, a, m[2], input)
		}
		return s.Report(ctx, a, m[2])
	}
}
