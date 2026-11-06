package communitygrowth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

// Handler uses the existing portal and management identities. Public responses
// come from separate projections; assessment results never enter this surface.
type Handler struct {
	Service      *Service
	Assessment   *AssessmentService
	Accounts     accounts.HTTPIdentity
	LegacyHonors func(context.Context, string, int, string) (Object, error)
	Next         http.Handler
}

var publicRoute = regexp.MustCompile(`^/v2/community/growth/accounts/([0-9a-f-]{36})(/(?:contributions|legacy-honors))?$`)
var ownerRoute = regexp.MustCompile(`^/v2/community/growth/me(/(?:contributions|legacy-honors))?$`)

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m := publicRoute.FindStringSubmatch(r.URL.Path)
	if own := ownerRoute.FindStringSubmatch(r.URL.Path); own != nil {
		m = []string{own[0], "me", own[1]}
	}
	admin := strings.HasPrefix(r.URL.Path, "/v1/operations/community-growth/")
	scoped := strings.HasPrefix(r.URL.Path, "/v2/community/growth/recognitions/")
	if m == nil && !admin && !scoped {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	out, e := h.dispatch(r, m, admin, requestID)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		out = Object{"error": fault.Code(e), "requestId": requestID}
	}
	json.NewEncoder(w).Encode(out)
}

func readInput(r *http.Request) (Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	// Three independently editable 16000-character explanations must fit in UTF-8.
	const maximumInputBytes = 256 * 1024
	raw, e := io.ReadAll(io.LimitReader(r.Body, maximumInputBytes+1))
	if e != nil {
		return nil, e
	}
	if len(raw) > maximumInputBytes {
		return nil, fault.New("request_too_large", 413)
	}
	var input Object
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, invalid()
	}
	return input, nil
}

func (h Handler) dispatch(r *http.Request, m []string, admin bool, requestID string) (Object, error) {
	s := h.Service
	if s == nil || s.Pool == nil {
		return nil, fault.New("community_growth_unavailable", 503)
	}
	if m != nil {
		if r.Method != "GET" {
			return nil, fault.New("not_found", 404)
		}
		q := r.URL.Query()
		limit := 0
		for k, v := range q {
			if len(v) != 1 || m[2] == "" || (k != "limit" && k != "after") {
				return nil, invalid()
			}
		}
		if q.Has("limit") {
			var e error
			limit, e = strconv.Atoi(q.Get("limit"))
			if e != nil || limit < 1 {
				return nil, invalid()
			}
		}
		if m[1] == "me" {
			if h.Accounts == nil {
				return nil, fault.New("official_account_login_required", 401)
			}
			account, authority, e := h.Accounts.Account(r, false)
			if e != nil {
				return nil, e
			}
			if m[2] == "/legacy-honors" {
				if h.LegacyHonors == nil {
					return nil, fault.New("community_growth_source_unavailable", 503)
				}
				return h.LegacyHonors(r.Context(), account, limit, q.Get("after"))
			}
			if m[2] != "" {
				return s.OwnerContributions(r.Context(), account, authority, limit, q.Get("after"))
			}
			return s.OwnerOverview(r.Context(), account, authority)
		}
		if m[2] == "/legacy-honors" {
			if h.LegacyHonors == nil {
				return nil, fault.New("community_growth_source_unavailable", 503)
			}
			return h.LegacyHonors(r.Context(), m[1], limit, q.Get("after"))
		}
		if m[2] != "" {
			return s.PublicContributions(r.Context(), "", m[1], limit, q.Get("after"))
		}
		return s.PublicOverview(r.Context(), "", m[1])
	}
	if r.Method != "POST" || r.URL.RawQuery != "" {
		return nil, fault.New("not_found", 404)
	}
	method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	if !admin {
		if h.Accounts == nil {
			return nil, fault.New("official_account_login_required", 401)
		}
		if method != "command" && method != "receipt" && method != "status" && method != "query" {
			return nil, fault.New("not_found", 404)
		}
		account, authority, e := h.Accounts.Account(r, method == "command")
		if e != nil {
			return nil, e
		}
		input, e := readInput(r)
		if e != nil {
			return nil, e
		}
		if method == "command" {
			return s.ScopedRecognitionCommand(r.Context(), account, authority, input)
		}
		if method == "status" {
			return s.ScopedRecognitionStatus(r.Context(), account, authority, str(input, "objectKind"), str(input, "objectId"))
		}
		if method == "query" {
			limit := int64(0)
			if value, present := input["limit"]; present {
				var valid bool
				limit, valid = integer(value)
				if !valid || limit < 1 || limit > 100 {
					return nil, invalid()
				}
			}
			return s.ScopedRecognitionQuery(r.Context(), account, authority, str(input, "objectKind"), str(input, "objectId"), int(limit), str(input, "after"))
		}
		return s.ScopedRecognitionReceipt(r.Context(), account, authority, str(input, "operationId"))
	}
	if s.Authority == nil {
		return nil, fault.New("operations_authorization_unavailable", 503)
	}
	write := method == "command" || method == "assessment-config-command"
	switch method {
	case "query", "command", "receipt", "assessment-config", "assessment-config-command", "assessment-config-receipt", "weights":
	default:
		return nil, fault.New("not_found", 404)
	}
	a, e := s.Authority.AuthorizeOperations(r, write, "")
	if e != nil {
		return nil, e
	}
	a.RequestID = &requestID
	input, e := readInput(r)
	if e != nil {
		return nil, e
	}
	switch method {
	case "query":
		return s.Query(r.Context(), a, input)
	case "command":
		return s.Command(r.Context(), a, input)
	case "receipt":
		return s.Receipt(r.Context(), a, input)
	}
	if h.Assessment == nil {
		return nil, assessmentNotConnected()
	}
	switch method {
	case "assessment-config":
		return h.Assessment.Configuration(r.Context(), a)
	case "assessment-config-command":
		return h.Assessment.SaveConfiguration(r.Context(), a, input)
	case "assessment-config-receipt":
		return h.Assessment.ConfigurationReceipt(r.Context(), a, str(input, "operationId"))
	case "weights":
		return h.Assessment.QueryWeights(r.Context(), a, input)
	}
	return nil, fault.New("not_found", 404)
}
