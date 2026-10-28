package deviceauth

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var controlPath = regexp.MustCompile(`^/v2/identity/control/(challenges|commit|status|cancel)$`)
var controlStatePath = regexp.MustCompile(`^/v2/identity/(GUID[0-9A-Z]{28})/control$`)
var consentRevokePath = regexp.MustCompile(`^/v1/consents/([0-9a-f-]{36})/revoke$`)

type Handler struct {
	Service *Service
	Next    http.Handler
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if controlPath.FindStringSubmatch(r.URL.Path) == nil && controlStatePath.FindStringSubmatch(r.URL.Path) == nil && consentRevokePath.FindStringSubmatch(r.URL.Path) == nil && r.URL.Path != "/v1/consents" && r.URL.Path != "/v2/consents/receipt" && r.URL.Path != "/v2/receipt-status/challenges" && r.URL.Path != "/v2/receipt-status/query" && r.URL.Path != "/v1/session-challenges" && r.URL.Path != "/v1/sessions" && r.URL.Path != "/v2/binding-challenges" && r.URL.Path != "/v1/binding-challenges" && r.URL.Path != "/v1/bindings" {
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
	result, e := h.dispatch(r, id)
	status := 201
	if r.URL.Path == "/v2/binding-challenges" || controlPath.MatchString(r.URL.Path) || controlStatePath.MatchString(r.URL.Path) || consentRevokePath.MatchString(r.URL.Path) || r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" || r.URL.Path == "/v2/receipt-status/query" {
		status = 200
	}
	if e != nil {
		status = fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		result = map[string]any{"error": fault.Code(e), "requestId": id}
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func (h Handler) dispatch(r *http.Request, id string) (any, error) {
	if h.Service == nil || h.Service.Pool == nil {
		return nil, fault.New("service_unavailable", 503)
	}
	if state := controlStatePath.FindStringSubmatch(r.URL.Path); state != nil {
		if r.Method != "GET" || r.URL.RawQuery != "" {
			return nil, fault.New("not_found", 404)
		}
		return h.Service.ControlPublicState(r.Context(), state[1])
	}
	if r.URL.Path == "/v1/consents" && r.Method == "GET" {
		actor, e := h.bearer(r, "consent")
		if e != nil {
			return nil, e
		}
		var after *string
		q := r.URL.Query()
		if values, ok := q["after"]; ok {
			after = &values[0]
		}
		return h.Service.ListConsents(r.Context(), actor, after)
	}
	if r.Method != "POST" || r.URL.RawQuery != "" {
		return nil, fault.New("not_found", 404)
	}
	var consentActor *Actor
	if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" || consentRevokePath.MatchString(r.URL.Path) {
		actor, e := h.bearer(r, "consent")
		if e != nil {
			return nil, e
		}
		consentActor = &actor
	}
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
	if !utf8.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	if route := controlPath.FindStringSubmatch(r.URL.Path); route != nil {
		if route[1] == "challenges" {
			return h.Service.ControlChallenge(r.Context(), raw)
		}
		var input ControlCommit
		if e = protocol.Decode(raw, &input); e != nil {
			return nil, controlInvalid()
		}
		keys := []string{"operationId", "controllerSignature"}
		var m map[string]json.RawMessage
		_ = json.Unmarshal(raw, &m)
		if m["newDeviceProof"] != nil {
			if string(m["newDeviceProof"]) == "null" {
				return nil, controlInvalid()
			}
			keys = append(keys, "newDeviceProof")
		}
		if !exactJSON(raw, keys...) {
			return nil, controlInvalid()
		}
		switch route[1] {
		case "commit":
			return h.Service.ControlCommit(r.Context(), input)
		case "status":
			return h.Service.ControlStatus(r.Context(), input)
		default:
			return h.Service.ControlCancel(r.Context(), input)
		}
	}
	if r.URL.Path == "/v2/receipt-status/challenges" {
		var input ReceiptChallengeInput
		if !exactJSON(raw, "subjectId", "control", "operation", "clientNonce") || protocol.Decode(raw, &input) != nil {
			return nil, fault.New("invalid_receipt_status_request", 400)
		}
		return h.Service.ReceiptChallenge(r.Context(), input)
	}
	if r.URL.Path == "/v2/receipt-status/query" {
		var input ReceiptQueryInput
		if !exactJSON(raw, "challenge", "signature") || protocol.Decode(raw, &input) != nil {
			return nil, fault.New("invalid_receipt_status_request", 400)
		}
		return h.Service.ReceiptQuery(r.Context(), input)
	}
	if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" || consentRevokePath.MatchString(r.URL.Path) {
		actor := *consentActor
		if r.URL.Path == "/v1/consents" {
			var input struct {
				SignedIntent *string `json:"signedIntent"`
			}
			if !exactJSON(raw, "signedIntent") || protocol.Decode(raw, &input) != nil || input.SignedIntent == nil {
				return nil, consentError()
			}
			return postgres.InTx(r.Context(), h.Service.Pool, func(tx pgx.Tx) (ConsentCapture, error) {
				return h.Service.CaptureConsentWithin(r.Context(), tx, actor, *input.SignedIntent, ConsentOptions{HTTPRequestID: &id})
			})
		}
		if r.URL.Path == "/v2/consents/receipt" {
			var input struct {
				ConsentID string `json:"consentId"`
			}
			if !exactJSON(raw, "consentId") || protocol.Decode(raw, &input) != nil {
				return nil, fault.New("invalid_request", 400)
			}
			return h.Service.ConsentReceipt(r.Context(), actor, input.ConsentID)
		}
		if !exactJSON(raw) {
			return nil, fault.New("invalid_request", 400)
		}
		return h.Service.RevokeConsent(r.Context(), actor, consentRevokePath.FindStringSubmatch(r.URL.Path)[1], &id)
	}
	if r.URL.Path == "/v1/binding-challenges" || r.URL.Path == "/v2/binding-challenges" {
		keys := []string{"subjectId", "genesisProof", "installationId", "scopes"}
		v2 := r.URL.Path == "/v2/binding-challenges"
		if v2 {
			keys = append(keys, "control")
		}
		if !exactJSON(raw, keys...) {
			return nil, fault.New("invalid_request", 400)
		}
		var input BindingInput
		if e = protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		return h.Service.BindingChallenge(r.Context(), input, v2)
	}
	if r.URL.Path == "/v1/bindings" {
		if !exactJSON(raw, "challenge", "signature", "clientSession") {
			return nil, fault.New("invalid_request", 400)
		}
		var input BindInput
		if e = protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		return h.Service.Bind(r.Context(), input, &id)
	}
	if r.URL.Path == "/v1/session-challenges" {
		if !exactJSON(raw, "bindingId", "credentialHash") {
			return nil, fault.New("invalid_request", 400)
		}
		var input ChallengeInput
		if e = protocol.Decode(raw, &input); e != nil {
			return nil, e
		}
		return h.Service.Challenge(r.Context(), input)
	}
	if !exactJSON(raw, "challenge", "signature") {
		return nil, fault.New("invalid_request", 400)
	}
	var input ActivateInput
	if e = protocol.Decode(raw, &input); e != nil {
		return nil, e
	}
	return h.Service.Activate(r.Context(), input, &id)
}

func (h Handler) bearer(r *http.Request, scope string) (Actor, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return Actor{}, denied()
	}
	return h.Service.Authenticate(r.Context(), strings.TrimPrefix(values[0], "Bearer "), scope)
}
