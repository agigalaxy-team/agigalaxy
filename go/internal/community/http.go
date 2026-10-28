package community

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

type HTTPIdentity interface {
	Account(*http.Request, bool) (string, Authorization, error)
}

// ReadIdentity is optional. It implements the original readActorFor rules:
// invalid ID credentials may read anonymously, never as a different Cookie ID.
type ReadIdentity interface {
	ReadAccount(*http.Request) (string, Authorization, error)
}
type Handler struct {
	Service      *Service
	Identity     HTTPIdentity
	ReadIdentity ReadIdentity
	Next         http.Handler
}

func readBody(r *http.Request, max int64) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fail("unsupported_media_type", 415)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(b)) > max {
		return nil, fail("request_too_large", 413)
	}
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, fail("invalid_json", 400)
	}
	return b, nil
}
func route(r *http.Request) bool {
	p := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/community/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/v2/community/") {
		return false
	}
	if r.Method == "POST" {
		switch strings.Join(p, "/") {
		case "posts", "replies", "posts/query", "posts/owned", "replies/query", "receipt", "posts/withdraw", "versions/withdraw", "replies/withdraw", "sections", "sections/query", "notifications/query", "notifications/read", "reports", "reports/withdraw", "reports/config", "reports/query", "affected-events/query", "accounts/query":
			return true
		}
		return len(p) == 3 && validID(p[1]) && (p[0] == "posts" && p[2] == "versions" || p[0] == "sections" && p[2] == "classification" || p[0] == "reports" && (p[2] == "events" || p[2] == "appeal"))
	}
	if r.Method == "GET" {
		if len(p) == 1 && (p[0] == "sections" || p[0] == "quotas" || p[0] == "topics" || p[0] == "access-options") {
			return true
		}
		if len(p) == 2 && (p[0] == "sections" || p[0] == "reports" || p[0] == "permissions") && validID(p[1]) {
			return true
		}
		return len(p) == 2 && (p[0] == "posts" || p[0] == "replies") && validID(p[1]) || len(p) == 3 && (p[0] == "posts" || p[0] == "replies") && validID(p[1]) && p[2] == "owned" || len(p) == 4 && p[0] == "posts" && p[2] == "versions" && validID(p[1]) && validID(p[3])
	}
	return false
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !route(r) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	requestID := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", requestID)
	result, e := h.dispatch(r, requestID)
	status := 200
	if e != nil {
		status = fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		result = Object{"error": fault.Code(e), "requestId": requestID}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatch(r *http.Request, requestID string) (Object, error) {
	if h.Service == nil {
		return nil, fail("forum_service_unavailable", 503)
	}
	s := *h.Service
	s.RequestID = requestID
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/community/"), "/")
	path := strings.Join(parts, "/")
	write := r.Method == "POST" && (path == "posts" || path == "replies" || path == "sections" || path == "reports" || strings.HasSuffix(path, "/withdraw") || len(parts) == 3 && ((parts[0] == "reports" && (parts[2] == "events" || parts[2] == "appeal")) || parts[0] == "sections" && parts[2] == "classification"))
	required := write || path == "receipt" || path == "quotas" || strings.HasPrefix(path, "reports/") || strings.HasPrefix(path, "permissions/") || path == "affected-events/query" || strings.HasPrefix(path, "notifications/") || path == "posts/owned" || strings.HasSuffix(path, "/owned")
	account := ""
	var e error
	if r.Header.Get("Authorization") != "" {
		if s.DeviceAuth == nil {
			if required {
				return nil, fail("forum_identity_authorization_unavailable", 503)
			}
		} else {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				if required {
					return nil, fail("access_denied", 401)
				}
			} else {
				scope := "binding"
				if required {
					scope = "assistance"
				}
				if len(parts) == 3 && parts[0] == "sections" && parts[2] == "classification" {
					scope = "moderation"
				}
				actor, err := s.DeviceAuth.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
				if err != nil && fault.Code(err) == "access_denied" && (path == "receipt" || path == "quotas" || strings.HasPrefix(path, "reports/") || strings.HasPrefix(path, "permissions/") || path == "affected-events/query") {
					scope = "moderation"
					actor, err = s.DeviceAuth.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), scope)
				}
				if err != nil {
					if required || fault.Code(err) != "access_denied" {
						return nil, err
					}
				} else {
					s = *s.ForIdentity(actor, scope, "")
					account = r.Header.Get("X-Galaxy-Account-ID")
					if account != "" && !validID(account) {
						return nil, fail("invalid_account_target", 400)
					}
				}
			}
		}
	} else if required {
		if h.Identity == nil {
			return nil, fail("official_account_unavailable", 503)
		}
		account, s.Authority, e = h.Identity.Account(r, r.Method != "GET")
		if e != nil {
			return nil, e
		}
	} else if h.ReadIdentity != nil {
		account, s.Authority, e = h.ReadIdentity.ReadAccount(r)
		if e != nil {
			return nil, e
		}
	} else if r.Header.Get("X-Galaxy-Account-ID") != "" && r.Header.Get("Authorization") == "" {
		if h.Identity == nil {
			return nil, fail("official_account_unavailable", 503)
		}
		account, s.Authority, e = h.Identity.Account(r, false)
		if e != nil {
			return nil, e
		}
	}
	if r.Method == "GET" {
		if len(parts) == 2 && parts[0] == "permissions" {
			return s.PermissionDetail(r.Context(), account, parts[1])
		}
		if len(parts) == 2 && parts[0] == "reports" {
			return s.GetReport(r.Context(), account, parts[1])
		}
		if path == "topics" {
			return s.Topics(), nil
		}
		if path == "access-options" {
			return s.AccessOptions(), nil
		}
		if path == "quotas" {
			q := Object{}
			for k, v := range r.URL.Query() {
				if len(v) != 1 {
					return nil, invalid()
				}
				q[k] = v[0]
			}
			return s.Quotas(r.Context(), account, encode(q))
		}
		if parts[0] == "sections" {
			if len(parts) == 2 {
				return s.GetSection(r.Context(), account, parts[1])
			}
			q := Object{}
			for k, v := range r.URL.Query() {
				if len(v) != 1 || k != "after" && k != "limit" {
					return nil, invalid()
				}
				if k == "limit" {
					n, e := strconv.ParseInt(v[0], 10, 64)
					if e != nil {
						return nil, invalid()
					}
					q[k] = n
				} else {
					q[k] = v[0]
				}
			}
			return s.Sections(r.Context(), account, encode(q))
		}
		if len(parts) == 3 && parts[2] == "owned" {
			if parts[0] == "posts" {
				return s.OwnedPost(r.Context(), account, parts[1])
			}
			return s.OwnedReply(r.Context(), account, parts[1])
		}
		if len(parts) == 4 {
			return s.GetVersion(r.Context(), account, parts[1], parts[3])
		}
		if parts[0] == "posts" {
			return s.GetPost(r.Context(), account, parts[1])
		}
		return s.GetReply(r.Context(), account, parts[1])
	}
	max := int64(32768)
	if write {
		max = num(s.policy(), "maxPayloadBytes")*2 + 20480
	}
	raw, e := readBody(r, max)
	if e != nil {
		return nil, e
	}
	// The original HTTP boundary charges supplied pagination before the domain
	// validates its cursor; an empty supplied cursor is still a page request.
	if !write && (path == "accounts/query" || path == "sections/query" || path == "notifications/query" || path == "posts/query" || path == "replies/query" || path == "posts/owned" || path == "reports/query" || path == "affected-events/query" || len(parts) == 3 && parts[0] == "posts" && parts[2] == "versions") {
		var input Object
		if protocol.Decode(raw, &input) == nil && input != nil {
			value, present := input["after"]
			// Only the post/reply/version branch used nullish fallback in JS.
			if (path == "posts/query" || path == "replies/query" || len(parts) == 3 && parts[0] == "posts" && parts[2] == "versions") && value == nil {
				value, present = input["afterVersion"]
			}
			if present {
				cursor, _ := value.(string)
				kind, id := "anonymous", ""
				if s.actor != nil {
					kind, id = "subject", s.actor.actor.SubjectID
				} else if account != "" {
					kind, id = "account", account
				}
				if e := httpboundary.ConsumeSearchPage(r.Context(), &cursor, kind, id); e != nil {
					return nil, e
				}
			}
		}
	}
	if write {
		var fields Object
		if protocol.Decode(raw, &fields) != nil {
			return nil, invalid()
		}
		if _, present := fields["signedIntent"]; present && s.actor == nil {
			return nil, invalid()
		}
		var envelope struct {
			PayloadJSON  *string `json:"payloadJson"`
			SignedIntent *string `json:"signedIntent,omitempty"`
		}
		if protocol.Decode(raw, &envelope) != nil || envelope.PayloadJSON == nil || (s.actor == nil && envelope.SignedIntent != nil) || (s.actor != nil && (envelope.SignedIntent == nil || len(*envelope.SignedIntent) < 1 || len(*envelope.SignedIntent) > 16384)) {
			return nil, invalid()
		}
		if s.actor != nil {
			s.actor.signedIntent = *envelope.SignedIntent
		}
		if path == "reports" {
			return s.Report(r.Context(), account, *envelope.PayloadJSON)
		}
		if path == "reports/withdraw" || len(parts) == 3 && parts[0] == "reports" {
			var event Object
			if decodeObject(*envelope.PayloadJSON, &event) != nil {
				return nil, fail("invalid_forum_payload", 400)
			}
			kind := str(event, "kind")
			id := str(event, "reportId")
			if path == "reports/withdraw" && kind != "withdraw" || len(parts) == 3 && parts[2] == "appeal" && kind != "appeal" || len(parts) == 3 && parts[2] == "events" && kind != "supplement" && kind != "resolve" {
				return nil, fail("forum_event_route_mismatch", 400)
			}
			if len(parts) == 3 {
				id = parts[1]
			}
			return s.ReportEvent(r.Context(), account, id, *envelope.PayloadJSON)
		}
		if len(parts) == 3 && parts[0] == "sections" && parts[2] == "classification" {
			return s.ClassifySection(r.Context(), parts[1], *envelope.PayloadJSON)
		}
		if path == "posts" {
			return s.Publish(r.Context(), account, *envelope.PayloadJSON)
		}
		if path == "replies" {
			return s.CreateReply(r.Context(), account, *envelope.PayloadJSON)
		}
		if path == "sections" {
			return s.SaveSection(r.Context(), account, *envelope.PayloadJSON)
		}
		kind := "withdraw-post"
		if parts[0] == "versions" {
			kind = "withdraw-version"
		}
		if parts[0] == "replies" {
			kind = "withdraw-reply"
		}
		return s.Withdraw(r.Context(), account, kind, *envelope.PayloadJSON)
	}
	switch path {
	case "accounts/query":
		return s.AccountChoices(r.Context(), account, raw)
	case "reports/config":
		return s.ReportConfig(r.Context(), account, raw)
	case "reports/query":
		return s.Reports(r.Context(), account, raw, false)
	case "affected-events/query":
		return s.Reports(r.Context(), account, raw, true)
	case "sections/query":
		return s.Sections(r.Context(), account, raw)
	case "notifications/query":
		return s.Notifications(r.Context(), account, raw)
	case "notifications/read":
		return s.MarkNotificationRead(r.Context(), account, raw)
	case "posts/owned":
		return s.Owned(r.Context(), account, raw)
	case "posts/query":
		return s.Query(r.Context(), account, raw)
	case "replies/query":
		return s.Replies(r.Context(), account, raw)
	case "receipt":
		return s.Receipt(r.Context(), account, raw)
	}
	return s.Versions(r.Context(), account, parts[1], raw)
}
