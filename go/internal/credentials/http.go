package credentials

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Handler is the existing official-account intake. Imported credentials never
// authenticate this request; device/binding credentials have no fallback here.
type Handler struct {
	Service  *Service
	Pool     *pgxpool.Pool
	Identity accounts.HTTPIdentity
	Next     http.Handler
}

var credentialPath = regexp.MustCompile(`^/v1/account/external-credentials/([0-9a-f-]{36})(/recheck)?$`)

const credentialBase = "/v1/account/external-credentials"

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != credentialBase && !strings.HasPrefix(r.URL.Path, credentialBase+"/") {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	request := uuid.NewString()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Request-ID", request)
	status, result, e := h.dispatch(r)
	if e != nil {
		w.WriteHeader(fault.Status(e))
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": request})
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func credentialBody(r *http.Request, keys []string, max int64) ([]byte, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > max {
		return nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, fault.New("invalid_json", 400)
	}
	var object Object
	if json.Unmarshal(raw, &object) != nil || object == nil || len(object) != len(keys) {
		return nil, fault.New("invalid_request", 400)
	}
	for _, k := range keys {
		if _, ok := object[k]; !ok {
			return nil, fault.New("invalid_request", 400)
		}
	}
	return raw, nil
}
func (h Handler) dispatch(r *http.Request) (int, Object, error) {
	unavailable := fault.New("external_credentials_unavailable", 503)
	if h.Service == nil || h.Pool == nil || h.Identity == nil {
		return 0, nil, unavailable
	}
	if _, present := r.Header["Authorization"]; present {
		return 0, nil, fault.New("access_denied", 401)
	}
	account, authority, e := h.Identity.Account(r, r.Method != "GET")
	if e != nil {
		return 0, nil, e
	}
	if authority == nil {
		return 0, nil, unavailable
	}
	match := credentialPath.FindStringSubmatch(r.URL.Path)
	action := ""
	id := ""
	status := 200
	raw := []byte(`{}`)
	if r.URL.Path == credentialBase && r.Method == "GET" {
		query, queryError := url.ParseQuery(r.URL.RawQuery)
		if queryError != nil {
			return 0, nil, invalid()
		}
		for k, v := range query {
			if k != "after" || len(v) > 1 {
				return 0, nil, invalid()
			}
		}
		p := Object{}
		if values, yes := query["after"]; yes {
			p["after"] = values[0]
		}
		raw, e = protocol.Encode(p)
		if e != nil {
			return 0, nil, e
		}
		action = "list"
	} else if r.URL.Path == credentialBase && r.Method == "POST" && r.URL.RawQuery == "" {
		action = "import"
		status = 201
		raw, e = credentialBody(r, []string{"credential"}, 196608)
		if e != nil {
			return 0, nil, e
		}
	} else if match != nil && r.URL.RawQuery == "" {
		id = match[1]
		switch {
		case r.Method == "GET" && match[2] == "":
			action = "get"
		case r.Method == "POST" && match[2] != "":
			action = "recheck"
			if _, e = credentialBody(r, []string{}, 32768); e != nil {
				return 0, nil, e
			}
		case r.Method == "DELETE" && match[2] == "":
			action = "withdraw"
			length := r.Header.Get("Content-Length")
			if length != "" && length != "0" || len(r.TransferEncoding) > 0 || r.Header.Get("Transfer-Encoding") != "" || r.ContentLength > 0 {
				return 0, nil, invalid()
			}
		}
	}
	if action == "" {
		return 0, nil, fault.New("not_found", 404)
	}
	result, e := postgres.InTx(r.Context(), h.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authority.Account(r.Context(), tx, h.Service.Endpoint, account); e != nil {
			return nil, e
		}
		var result Object
		var e error
		switch action {
		case "list":
			result, e = h.Service.ListWithin(r.Context(), tx, account, raw)
		case "get":
			result, e = h.Service.GetWithin(r.Context(), tx, account, id)
		case "import":
			result, e = h.Service.ImportWithin(r.Context(), tx, account, raw)
		case "recheck":
			result, e = h.Service.RecheckWithin(r.Context(), tx, account, id)
		case "withdraw":
			result, e = h.Service.WithdrawWithin(r.Context(), tx, account, id)
		}
		if e != nil {
			return nil, e
		}
		if e = authority.Account(r.Context(), tx, h.Service.Endpoint, account); e != nil {
			return nil, e
		}
		return result, nil
	})
	return status, result, e
}
