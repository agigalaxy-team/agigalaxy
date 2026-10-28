package feedback

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func (h Handler) ownerDataHTTP(w http.ResponseWriter, r *http.Request, p []string, requestID string) {
	out, file, status, e := h.dispatchOwnerData(r, p, requestID)
	if e != nil {
		status = fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		out = Object{"error": fault.Code(e), "requestId": requestID}
		file = nil
	}
	if file != nil {
		writeAttachmentContent(w, *file)
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}
func (h Handler) dispatchOwnerData(r *http.Request, p []string, requestID string) (Object, *AttachmentContent, int, error) {
	missing := func() (Object, *AttachmentContent, int, error) { return nil, nil, 404, fault.New("not_found", 404) }
	intent := len(p) == 4 && (p[3] == "export" || p[3] == "delete")
	receipt := len(p) == 5 && p[3] == "operations" && uuidPattern.MatchString(p[4])
	page := len(p) == 5 && p[3] == "exports" && uuidPattern.MatchString(p[4])
	binary := len(p) == 8 && p[3] == "exports" && uuidPattern.MatchString(p[4]) && p[5] == "attachments" && uuidPattern.MatchString(p[6]) && p[7] == "content"
	write := intent || binary
	method := "GET"
	if write {
		method = "POST"
	}
	if !intent && !receipt && !page && !binary || r.Method != method || !page && r.URL.RawQuery != "" {
		return missing()
	}
	after, limit := "0", 50
	if page {
		for key, values := range r.URL.Query() {
			if key != "after" && key != "limit" || len(values) != 1 {
				return nil, nil, 400, ownerDataInvalid()
			}
			if key == "after" {
				after = values[0]
			} else {
				n, e := strconv.ParseFloat(strings.TrimSpace(values[0]), 64)
				if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 1 || n > 50 {
					return nil, nil, 400, ownerDataInvalid()
				}
				limit = int(n)
			}
		}
	}
	if h.Service == nil || h.Identity == nil {
		return nil, nil, 503, fault.New("official_account_unavailable", 503)
	}
	if _, ok := r.Header["Authorization"]; ok {
		return nil, nil, 401, fault.New("official_account_login_required", 401)
	}
	account, authority, e := h.Identity.Account(r, write)
	if e != nil {
		return nil, nil, fault.Status(e), e
	}
	s := *h.Service
	s.Authority = authority
	s.RequestID = requestID
	if intent {
		raw, e := body(r, 4096)
		if e != nil {
			return nil, nil, 400, e
		}
		out, e := s.OwnerDataBegin(r.Context(), account, raw, p[3])
		status := 201
		if out["replayed"] == true {
			status = 200
		}
		return out, nil, status, e
	}
	if receipt {
		out, e := s.OwnerDataOperation(r.Context(), account, p[4])
		return out, nil, 200, e
	}
	if page {
		out, e := s.OwnerDataExportPage(r.Context(), account, p[4], after, limit)
		return out, nil, 200, e
	}
	raw, e := body(r, 4096)
	if e != nil {
		return nil, nil, 400, e
	}
	var empty map[string]any
	if json.Unmarshal(raw, &empty) != nil || len(empty) != 0 {
		return nil, nil, 400, fault.New("invalid_request", 400)
	}
	file, e := s.OwnerDataContent(r.Context(), account, p[4], p[6], func() (string, Authorization, error) { return h.Identity.Account(r, true) })
	return nil, &file, 200, e
}
