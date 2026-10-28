package accountarchive

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

const jsSpace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var decimalQuery = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// The original GET adapter uses Number(searchParams.get('limit')); retain its
// decimal/exponent and 0x/0o/0b conversion before the domain integer bound.
func archiveQueryNumber(value string) (float64, error) {
	value = strings.Trim(value, jsSpace)
	if value == "" {
		return 0, nil
	}
	if len(value) > 2 && value[0] == '0' {
		base := 0
		switch value[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			n, e := strconv.ParseUint(value[2:], base, 64)
			return float64(n), e
		}
	}
	if !decimalQuery.MatchString(value) {
		return 0, fault.New("invalid_account_data", 400)
	}
	n, e := strconv.ParseFloat(value, 64)
	if e != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, fault.New("invalid_account_data", 400)
	}
	return n, nil
}
func portalArchiveBody(r *http.Request, max int64) ([]byte, Object, error) {
	if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
		return nil, nil, fault.New("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, max+1))
	if e != nil {
		return nil, nil, e
	}
	if int64(len(raw)) > max {
		return nil, nil, fault.New("request_too_large", 413)
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return nil, nil, fault.New("invalid_json", 400)
	}
	var object Object
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, nil, fault.New("invalid_request", 400)
	}
	return raw, object, nil
}
func (h Handler) dispatchPortalArchives(r *http.Request, request string) (Object, error) {
	if h.Service == nil || h.Identity == nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	list := r.URL.Path == "/v1/account/archives" && r.Method == "GET"
	var raw []byte
	var listInput Object
	action := strings.TrimPrefix(r.URL.Path, "/v1/account/archives/")
	if list {
		query, e := url.ParseQuery(r.URL.RawQuery)
		if e != nil {
			return nil, fault.New("invalid_archive_cursor", 400)
		}
		listInput = Object{}
		for k, v := range query {
			if k != "after" && k != "limit" || len(v) != 1 {
				return nil, fault.New("invalid_archive_cursor", 400)
			}
			listInput[k] = v[0]
		}
		action = "list"
	} else {
		allowed := map[string]bool{"create": true, "chunk": true, "complete": true, "export": true, "delete": true, "cleanup": true, "status": true}
		if r.Method != "POST" || r.URL.RawQuery != "" || !allowed[action] {
			return nil, fault.New("not_found", 404)
		}
	}
	if _, present := r.Header["Authorization"]; present {
		return nil, fault.New("access_denied", 401)
	}
	id, authorization, e := h.Identity.Account(r, !list)
	if e != nil {
		return nil, e
	}
	if authorization == nil {
		return nil, fault.New("official_account_unavailable", 503)
	}
	a := Actor{AccountID: id, RequestID: request, Official: true, Endpoint: h.Service.Endpoint, AuthorizeAccount: authorization.Account}
	if list {
		if limit, ok := listInput["limit"].(string); ok {
			n, e := archiveQueryNumber(limit)
			if e != nil {
				return nil, fault.New("invalid_account_data", 400)
			}
			listInput["limit"] = n
		}
		raw = encoded(listInput)
	}
	if !list {
		max := int64(32768)
		if action == "chunk" {
			max = 1572864
		}
		var p Object
		raw, p, e = portalArchiveBody(r, max)
		if e != nil {
			return nil, e
		}
		if action == "cleanup" && len(p) != 0 {
			return nil, fault.New("invalid_request", 400)
		}
	}
	return h.Service.Archive(r.Context(), a, action, raw)
}
