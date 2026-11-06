package taskmaterials

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/uuid"
)

// Account replies use the same portal session as other ordinary community work.
// They never acquire a synthetic signed-device identity.
type AccountCommentHandler struct {
	Service    *CommentService
	Governance *CommentGovernance
	Identity   accounts.HTTPIdentity
	Next       http.Handler
}

func (h AccountCommentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	method, matched := strings.CutPrefix(r.URL.Path, "/v2/account-comments/")
	governing := false
	if !matched {
		method, matched = strings.CutPrefix(r.URL.Path, "/v2/account-comment-governance/")
		governing = matched
	}
	if !matched || method != "events" && method != "receipt" && method != "query" && method != "get" {
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
	out, err := dispatchAccountComment(h.Service, h.Governance, h.Identity, r, method, governing)
	if err != nil {
		w.WriteHeader(fault.Status(err))
		value := map[string]any{"error": fault.Code(err), "requestId": requestID}
		for key, detail := range publicwrites.Details(err) {
			value[key] = detail
		}
		out = value
	}
	_ = json.NewEncoder(w).Encode(out)
}

func dispatchAccountComment(service *CommentService, governance *CommentGovernance, identity accounts.HTTPIdentity, r *http.Request, method string, governing bool) (any, error) {
	if r.Method != http.MethodPost {
		return nil, fault.New("not_found", 404)
	}
	if service == nil || identity == nil || governing && governance == nil {
		return nil, fault.New("comment_account_service_unavailable", 503)
	}
	if _, present := r.Header["Authorization"]; present {
		return nil, fault.New("access_denied", 401)
	}
	accountID, authority, err := identity.Account(r, method == "events")
	if err != nil {
		return nil, err
	}
	if authority == nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 32769))
	if err != nil {
		return nil, err
	}
	if len(raw) > 32768 {
		return nil, fault.New("request_too_large", 413)
	}
	actor := AccountCommentActor{AccountID: accountID, Authority: authority}
	if method == "events" && !governing {
		return service.SubmitAccount(r.Context(), actor, string(raw))
	}
	var input map[string]any
	if protocol.Decode(raw, &input) != nil || input == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if governing {
		switch method {
		case "query":
			return governance.QueryAccount(r.Context(), actor, input)
		case "events":
			reportID, ok := input["reportId"].(string)
			if !ok {
				return nil, fault.New("invalid_request", 400)
			}
			return governance.EventAccount(r.Context(), actor, reportID, string(raw))
		case "receipt":
			id, ok := input["id"].(string)
			hash, hashOK := input["payloadHash"].(string)
			if !ok || !hashOK || len(input) != 2 {
				return nil, fault.New("invalid_comment_receipt", 400)
			}
			return governance.ReceiptAccount(r.Context(), actor, id, hash)
		}
		return nil, fault.New("not_found", 404)
	}
	switch method {
	case "query":
		return service.QueryAccount(r.Context(), actor, input)
	case "get":
		id, ok := input["id"].(string)
		if !ok || len(input) != 1 {
			return nil, fault.New("invalid_request", 400)
		}
		return service.GetAccount(r.Context(), actor, id)
	case "receipt":
		id, ok := input["id"].(string)
		hash, hashOK := input["payloadHash"].(string)
		if !ok || !hashOK || len(input) != 2 {
			return nil, fault.New("invalid_comment_receipt", 400)
		}
		return service.ReceiptAccount(r.Context(), actor, id, hash)
	}
	return nil, fault.New("not_found", 404)
}
