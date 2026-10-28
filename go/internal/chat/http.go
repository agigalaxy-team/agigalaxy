package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
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
type Handler struct {
	Service  *Service
	Identity HTTPIdentity
	Next     http.Handler
}

var globals = map[string]bool{"rooms/create": true, "rooms/query": false, "rooms/directory": false, "accounts/query": false, "invitations/query": false, "export/owned": false}
var roomActions = map[string]bool{"read": false, "history": false, "decisions": false, "propose": true, "vote": true, "accept": true, "leave": true, "dismiss": true, "send": true, "receipt": false, "operation-receipt": false, "cursor": true, "join-preview": false, "join": true, "agent-grants": false, "agent-participants": false, "agent-grant": true, "agent-revoke": true}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v2/chat/"), "/")
	path := strings.Join(parts, "/")
	write, global := globals[path]
	room, message, action := "", "", ""
	matched := global
	if len(parts) == 3 && parts[0] == "rooms" && validID(parts[1]) {
		write, matched = roomActions[parts[2]]
		room, action = parts[1], parts[2]
	}
	if len(parts) == 5 && parts[0] == "rooms" && validID(parts[1]) && parts[2] == "messages" && validID(parts[3]) && has([]string{"edit", "retract", "hide", "context"}, parts[4]) {
		room, message, action = parts[1], parts[3], parts[4]
		write = action != "context"
		matched = true
	}
	if r.Method != "POST" || !strings.HasPrefix(r.URL.Path, "/v2/chat/") || !matched {
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
	out, e := h.dispatch(r, path, room, message, action, write)
	status := 200
	if e != nil {
		status = fault.Status(e)
		out = Object{"error": fault.Code(e), "requestId": id}
		if details := publicwrites.Details(e); details != nil {
			if details["quota"] != nil {
				out["quota"] = details["quota"]
			}
			if fault.Code(e) == "community_restricted" {
				out["restrictionReason"] = details["restrictionReason"]
			}
			if retry, ok := details["retryAfterSeconds"].(int64); ok && retry > 0 {
				w.Header().Set("Retry-After", strconv.FormatInt(retry, 10))
			}
		}
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatch(r *http.Request, path, room, message, action string, write bool) (Object, error) {
	s := h.Service
	if s == nil {
		return nil, fail("chat_service_unavailable", 503)
	}
	a, e := h.actor(r, write)
	if e != nil {
		return nil, e
	}
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
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fail("invalid_json", 400)
	}
	var body Object
	if json.Unmarshal(raw, &body) != nil || body == nil {
		return nil, fail("invalid_request")
	}
	ctx := r.Context()
	switch path {
	case "rooms/create":
		return s.Create(ctx, a, raw)
	case "rooms/query":
		return s.List(ctx, a, raw)
	case "rooms/directory":
		return s.Directory(ctx, a, raw)
	case "accounts/query":
		return s.People(ctx, a, raw)
	case "invitations/query":
		return s.Invitations(ctx, a)
	case "export/owned":
		return s.ExportOwned(ctx, a, raw)
	}
	switch action {
	case "agent-grants":
		return s.QueryAgentGrants(ctx, a, room, raw)
	case "agent-participants":
		return s.QueryAgentParticipants(ctx, a, room, raw)
	case "agent-grant":
		return s.GrantAgent(ctx, a, room, raw)
	case "agent-revoke":
		return s.RevokeAgent(ctx, a, room, raw)
	case "join-preview":
		return s.JoinPreview(ctx, a, room)
	case "join":
		return s.Join(ctx, a, room, raw)
	case "read":
		return s.Get(ctx, a, room)
	case "history":
		return s.History(ctx, a, room, raw)
	case "decisions":
		return s.Decisions(ctx, a, room)
	case "propose":
		return s.Propose(ctx, a, room, raw)
	case "vote":
		return s.Vote(ctx, a, room, raw)
	case "accept":
		return s.Accept(ctx, a, room, raw)
	case "leave":
		return s.Leave(ctx, a, room)
	case "dismiss":
		return s.Dismiss(ctx, a, room)
	case "send":
		return s.Send(ctx, a, room, raw)
	case "receipt":
		return s.MessageStatus(ctx, a, room, raw)
	case "operation-receipt":
		return s.OperationStatus(ctx, a, room, raw)
	case "cursor":
		return s.Cursor(ctx, a, room, raw)
	case "edit":
		return s.Edit(ctx, a, room, message, raw)
	case "retract":
		return s.Retract(ctx, a, room, message)
	case "context":
		return s.Context(ctx, a, room, message, raw)
	case "hide":
		var input Object
		if json.Unmarshal(raw, &input) != nil || input == nil {
			return nil, fail("invalid_chat_request", 400)
		}
		hidden := true
		if v, ok := input["hidden"]; ok {
			hidden, ok = v.(bool)
			if !ok {
				return nil, fail("invalid_chat_request", 400)
			}
		}
		return s.Hide(ctx, a, room, message, hidden)
	}
	return nil, fail("not_found", 404)
}

func (h Handler) actor(r *http.Request, write bool) (Actor, error) {
	s := h.Service
	if s == nil {
		return Actor{}, fail("chat_service_unavailable", 503)
	}
	a := Actor{}
	var e error
	if _, provided := r.Header["Authorization"]; provided {
		header := r.Header.Get("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			return Actor{}, fail("access_denied", 401)
		}
		if s.Devices == nil {
			return Actor{}, fail("chat_authority_unavailable", 503)
		}
		actor, e := s.Devices.Authenticate(r.Context(), strings.TrimPrefix(header, "Bearer "), "binding")
		if e != nil {
			return Actor{}, e
		}
		a.Device = &actor
		if targets, present := r.Header["X-Galaxy-Account-Id"]; present {
			if len(targets) != 1 || !accountPattern.MatchString("account:"+targets[0]) {
				return Actor{}, fail("invalid_account_target", 400)
			}
			a.AccountID = targets[0]
		}
	} else {
		if h.Identity == nil {
			return Actor{}, fail("official_account_unavailable", 503)
		}
		a.AccountID, a.Authority, e = h.Identity.Account(r, write)
		if e != nil {
			return Actor{}, e
		}
	}
	return a, nil
}
