package discovery

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
)

type Handler struct {
	Runtime                      *Runtime
	Quality                      *SearchQuality
	Recommendations              *Recommendations
	Authority                    operationspermissions.Authority
	Accounts                     accounts.HTTPIdentity
	CurrentAccount               func(*http.Request) (bool, error)
	WebsiteOrigin, VisitorSecret string
	SecureCookies                *bool
	Next                         http.Handler
}

func (h Handler) owns(path string) bool {
	return strings.HasPrefix(path, "/v1/discovery/") || path == "/v1/operations/discovery/analytics" || path == "/v1/operations/search-quality" || strings.HasPrefix(path, "/v1/operations/search-quality/") || path == "/v1/operations/recommendation" || strings.HasPrefix(path, "/v1/operations/recommendation/")
}
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.owns(r.URL.EscapedPath()) {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	id := w.Header().Get("X-Request-ID")
	if !validID(id) {
		id = uuid.NewString()
		w.Header().Set("X-Request-ID", id)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	result, status, e := h.dispatch(w, r, id)
	if e != nil {
		status = 500
		var known *fault.Error
		if errors.As(e, &known) {
			status = known.Status
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(Object{"error": fault.Code(e), "requestId": id})
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}
func queryParameters(r *http.Request, code string, max int, allowed ...string) (Object, error) {
	if max > 0 && len(r.URL.RawQuery)+1 > max {
		return nil, qualityFailure(code, 400)
	}
	values, e := url.ParseQuery(r.URL.RawQuery)
	if e != nil {
		return nil, qualityFailure(code, 400)
	}
	out := Object{}
	for key, list := range values {
		if !containsString(allowed, key) || len(list) != 1 {
			return nil, qualityFailure(code, 400)
		}
		out[key] = list[0]
	}
	return out, nil
}

var decimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func jsNumber(raw string) float64 {
	s := strings.TrimFunc(raw, jsSpace)
	if s == "" {
		return 0
	}
	if s == "Infinity" || s == "+Infinity" {
		return math.Inf(1)
	}
	if s == "-Infinity" {
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			n, e := strconv.ParseUint(s[2:], base, 64)
			if e != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if !decimalNumber.MatchString(s) {
		return math.NaN()
	}
	n, e := strconv.ParseFloat(s, 64)
	if e != nil && !math.IsInf(n, 0) {
		return math.NaN()
	}
	return n
}
func numericQuery(input Object, keys ...string) Object {
	for _, key := range keys {
		if value, present := input[key]; present {
			input[key] = jsNumber(value.(string))
		}
	}
	return input
}
func requestBody(r *http.Request, limit int) (Object, error) {
	if len(r.Header.Values("Content-Type")) != 1 || r.Header.Get("Content-Type") != "application/json" || len(r.Header.Values("Content-Encoding")) > 1 || r.Header.Get("Content-Encoding") != "" {
		return nil, qualityFailure("unsupported_media_type", 415)
	}
	raw, e := io.ReadAll(io.LimitReader(r.Body, int64(limit)+1))
	if e != nil || !utf8.Valid(raw) {
		return nil, qualityFailure("invalid_json", 400)
	}
	if len(raw) > limit {
		return nil, qualityFailure("request_too_large", 413)
	}
	var value any
	if e = decode(raw, &value); e != nil {
		return nil, qualityFailure("invalid_json", 400)
	}
	out := object(value)
	if out == nil {
		return nil, qualityFailure("invalid_request", 400)
	}
	return out, nil
}
func (h Handler) actor(r *http.Request, id, action string) (Actor, error) {
	authority := h.Authority
	if authority == nil && h.Runtime != nil && h.Runtime.Authority != nil {
		authority = h.Runtime.Authority
	}
	if authority == nil && h.Quality != nil && h.Quality.Authority != nil {
		authority = h.Quality.Authority
	}
	if authority == nil && h.Recommendations != nil && h.Recommendations.Authority != nil {
		authority = h.Recommendations.Authority
	}
	if authority == nil {
		return Actor{}, qualityFailure("operations_authorization_unavailable", 503)
	}
	actor, e := authority.AuthorizeOperations(r, r.Method == http.MethodPost, action)
	if e == nil {
		actor.RequestID = &id
	}
	return actor, e
}
func (h Handler) sign(value string) string {
	mac := hmac.New(sha256.New, []byte(h.VisitorSecret))
	_, _ = mac.Write([]byte(value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func secureEqual(a, b string) bool { return len(a) == len(b) && hmac.Equal([]byte(a), []byte(b)) }

var visitorCookieID = regexp.MustCompile(`^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

func (h Handler) visitor(w http.ResponseWriter, r *http.Request) (string, error) {
	if len(h.VisitorSecret) < 32 || h.WebsiteOrigin == "" {
		return "", fail("discovery_not_connected")
	}
	const name = "galaxy-discovery-visitor"
	for _, part := range strings.Split(strings.Join(r.Header.Values("Cookie"), "; "), ";") {
		value := strings.TrimFunc(part, jsSpace)
		if !strings.HasPrefix(value, name+"=") {
			continue
		}
		signed := strings.Split(strings.TrimPrefix(value, name+"="), ".")
		if len(signed) >= 2 && visitorCookieID.MatchString(signed[0]) && secureEqual(signed[1], h.sign(signed[0])) {
			return signed[0], nil
		}
		break
	}
	id := uuid.NewString()
	cookie := name + "=" + id + "." + h.sign(id) + "; Path=/v1/discovery; HttpOnly; SameSite=Lax"
	if h.SecureCookies == nil || *h.SecureCookies {
		cookie += "; Secure"
	}
	w.Header().Add("Set-Cookie", cookie)
	return id, nil
}
func (h Handler) usageIdentity(r *http.Request, visitor string, write bool) (UsageIdentity, error) {
	if len(r.Header.Values("Authorization")) > 0 {
		return UsageIdentity{}, qualityFailure("discovery_identity_required", 401)
	}
	identity := UsageIdentity{VisitorID: visitor}
	if len(r.Header.Values("X-Galaxy-Account-ID")) > 0 {
		if len(r.Header.Values("X-Galaxy-Account-ID")) != 1 {
			return identity, qualityFailure("official_account_changed", 409)
		}
		if h.Accounts == nil {
			return identity, fail("official_account_unavailable")
		}
		id, authorization, e := h.Accounts.Account(r, write)
		if e != nil {
			return identity, e
		}
		identity.AccountID = id
		identity.Authorization = authorization
		return identity, nil
	}
	if h.CurrentAccount != nil {
		current, e := h.CurrentAccount(r)
		if e != nil {
			return identity, e
		}
		if current {
			return identity, qualityFailure("official_account_changed", 409)
		}
	} else if h.Accounts != nil {
		return identity, fail("official_account_unavailable")
	}
	return identity, nil
}
func (h Handler) dispatch(w http.ResponseWriter, r *http.Request, id string) (Object, int, error) {
	path := r.URL.EscapedPath()
	if path == "/v1/operations/search-quality" || strings.HasPrefix(path, "/v1/operations/search-quality/") {
		result, e := h.qualityHTTP(r, id)
		return result, 200, e
	}
	if path == "/v1/operations/recommendation" || strings.HasPrefix(path, "/v1/operations/recommendation/") {
		result, e := h.recommendationHTTP(r, id)
		return result, 200, e
	}
	if h.Runtime == nil {
		return nil, 0, fail("discovery_not_connected")
	}
	if path == "/v1/operations/discovery/analytics" {
		if r.Method != "GET" {
			return nil, 0, qualityFailure("not_found", 404)
		}
		input, e := queryParameters(r, "invalid_discovery_request", 0, "kind", "days", "scope", "accountId")
		if e != nil {
			return nil, 0, e
		}
		numericQuery(input, "days")
		actor, e := h.actor(r, id, "analytics.read")
		if e != nil {
			return nil, 0, e
		}
		result, e := h.Runtime.Analytics(r.Context(), actor, input)
		return result, 200, e
	}
	visitor, e := h.visitor(w, r)
	if e != nil {
		return nil, 0, e
	}
	switch {
	case r.Method == "GET" && path == "/v1/discovery/config":
		if _, e = queryParameters(r, "invalid_discovery_request", 0); e != nil {
			return nil, 0, e
		}
		return Object{"csrfToken": h.sign("csrf:" + visitor), "pageKeys": []string{"home", "community", "find", "account", "help", "download"}, "events": []string{"pageview", "content-view", "content-click", "content-exposure", "content-bookmark", "content-participate", "search", "search-click", "not-interested"}, "engines": Object{"search": h.Runtime.Meili != nil, "recommendations": h.Runtime.Gorse != nil, "analytics": h.Runtime.OpenPanel != nil}, "state": "configured", "purposes": []string{"site-usage-analytics", "public-community-recommendation"}}, 200, nil
	case r.Method == "POST" && path == "/v1/discovery/events":
		if _, e = queryParameters(r, "invalid_discovery_request", 0); e != nil {
			return nil, 0, e
		}
		if len(r.Header.Values("Origin")) != 1 || len(r.Header.Values("X-Galaxy-Discovery-CSRF")) != 1 || r.Header.Get("Origin") != h.WebsiteOrigin || !secureEqual(r.Header.Get("X-Galaxy-Discovery-CSRF"), h.sign("csrf:"+visitor)) {
			return nil, 0, qualityFailure("discovery_csrf_invalid", 403)
		}
		identity, e := h.usageIdentity(r, visitor, true)
		if e != nil {
			return nil, 0, e
		}
		input, e := requestBody(r, 2048)
		if e != nil {
			return nil, 0, e
		}
		result, e := h.Runtime.RecordUsage(r.Context(), identity, input, r.Header.Get("User-Agent"))
		return result, 202, e
	case r.Method == "GET" && path == "/v1/discovery/search":
		params, e := queryParameters(r, "invalid_discovery_request", 0, "q", "topic", "after", "limit")
		if e != nil {
			return nil, 0, e
		}
		input := Object{"query": params["q"]}
		for _, key := range []string{"topic", "after", "limit"} {
			if value, present := params[key]; present && (key != "topic" || value != "") {
				input[key] = value
			}
		}
		numericQuery(input, "after", "limit")
		identity, e := h.usageIdentity(r, visitor, false)
		if e != nil {
			return nil, 0, e
		}
		owner, e := h.Runtime.identity(r.Context(), identity)
		if e != nil {
			return nil, 0, e
		}
		result, e := h.Runtime.SearchForProfile(r.Context(), input, str(owner, "profileId"))
		return result, 200, e
	case r.Method == "GET" && path == "/v1/discovery/recommendations":
		params, e := queryParameters(r, "invalid_discovery_request", 0, "mode", "topic", "limit")
		if e != nil {
			return nil, 0, e
		}
		for _, key := range []string{"mode", "topic"} {
			if params[key] == "" {
				delete(params, key)
			}
		}
		numericQuery(params, "limit")
		identity, e := h.usageIdentity(r, visitor, false)
		if e != nil {
			return nil, 0, e
		}
		result, e := h.Runtime.Recommend(r.Context(), identity, params)
		return result, 200, e
	}
	return nil, 0, qualityFailure("not_found", 404)
}

var qualityOperation = regexp.MustCompile(`^operations/([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$`)
var recommendationOperation = regexp.MustCompile(`^operations/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`)

func (h Handler) qualityHTTP(r *http.Request, id string) (Object, error) {
	part := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/operations/search-quality/")
	write := r.Method == "POST"
	operation := qualityOperation.FindStringSubmatch(part)
	keys := []string{}
	if part == "overview" {
		keys = []string{"days", "query", "issue", "after", "limit"}
	} else if part == "history" {
		keys = []string{"after", "limit"}
	}
	action := "search-quality.read"
	valid := r.Method == "GET" && (part == "overview" || part == "history" || operation != nil)
	if write && (part == "draft" || part == "apply" || part == "restore") {
		valid = true
		action = qualityAction(part)
	}
	if !valid {
		return nil, qualityFailure("not_found", 404)
	}
	if write && r.URL.RawQuery != "" {
		return nil, settingsInvalid()
	}
	input, e := queryParameters(r, "invalid_search_quality_request", 4096, keys...)
	if e != nil {
		return nil, e
	}
	numericQuery(input, "days", "limit")
	if h.Quality == nil {
		return nil, fail("discovery_search_quality_not_connected")
	}
	actor, e := h.actor(r, id, action)
	if e != nil {
		return nil, e
	}
	if write {
		input, e = requestBody(r, 32768)
		if e != nil {
			return nil, e
		}
		return h.Quality.Command(r.Context(), actor, part, input)
	}
	if operation != nil {
		return h.Quality.Operation(r.Context(), actor, operation[1])
	}
	if part == "history" {
		return h.Quality.History(r.Context(), actor, input)
	}
	return h.Quality.Overview(r.Context(), actor, input)
}
func (h Handler) recommendationHTTP(r *http.Request, id string) (Object, error) {
	part := strings.TrimPrefix(r.URL.EscapedPath(), "/v1/operations/recommendation/")
	write := r.Method == "POST"
	operation := recommendationOperation.FindStringSubmatch(part)
	keys := []string{}
	if part == "overview" {
		keys = []string{"days", "query"}
	} else if part == "history" {
		keys = []string{"after", "limit"}
	}
	valid := r.Method == "GET" && (part == "overview" || part == "history" || operation != nil) || write && (part == "policy" || part == "themes")
	if !valid {
		return nil, qualityFailure("not_found", 404)
	}
	if write && r.URL.RawQuery != "" {
		return nil, recommendationInvalid()
	}
	input, e := queryParameters(r, "invalid_recommendation_request", 2048, keys...)
	if e != nil {
		return nil, e
	}
	numericQuery(input, "days", "limit")
	if h.Recommendations == nil {
		return nil, fail("discovery_recommendation_operations_not_connected")
	}
	action := "recommendations.read"
	if write {
		action = "recommendations.configure"
	}
	actor, e := h.actor(r, id, action)
	if e != nil {
		return nil, e
	}
	if write {
		input, e = requestBody(r, 16384)
		if e != nil {
			return nil, e
		}
		if part == "themes" {
			return h.Recommendations.SaveTheme(r.Context(), actor, input)
		}
		return h.Recommendations.SavePolicy(r.Context(), actor, input, nil)
	}
	if operation != nil {
		return h.Recommendations.CommandResult(r.Context(), actor, operation[1])
	}
	if part == "history" {
		return h.Recommendations.History(r.Context(), actor, input)
	}
	return h.Recommendations.Overview(r.Context(), actor, input)
}
