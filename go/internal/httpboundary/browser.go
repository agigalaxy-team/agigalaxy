package httpboundary

import (
	"net/http"
	"regexp"
	"strings"
	"sync"
)

const id = `[0-9a-f-]{36}`

var regexCache sync.Map

func match(pattern, value string) bool {
	if r, ok := regexCache.Load(pattern); ok {
		return r.(*regexp.Regexp).MatchString(value)
	}
	r := regexp.MustCompile(pattern)
	actual, _ := regexCache.LoadOrStore(pattern, r)
	return actual.(*regexp.Regexp).MatchString(value)
}
func followMethod(path string) string {
	m := regexp.MustCompile(`^/v1/account/follows/(status|query|command|receipt)$`).FindStringSubmatch(path)
	if m == nil {
		return ""
	}
	return m[1]
}
func accountChat(path string) bool {
	return match(`^/v2/chat/(?:rooms/(?:create|query|directory)|invitations/query|export/owned|accounts/query)$`, path) || match(`^/v2/chat/rooms/`+id+`/(?:read|history|decisions|propose|vote|accept|leave|dismiss|send|receipt|operation-receipt|cursor|join-preview|join)$`, path) || match(`^/v2/chat/rooms/`+id+`/messages/`+id+`/(?:edit|retract|hide|context)$`, path) || match(`^/v2/chat/attachments/(?:config|prepare|read|query|revoke)$`, path)
}
func accountBinary(path string) bool {
	return match(`^/v2/chat/attachments/`+id+`/(?:upload|content|export-content)$`, path) || match(`^/v2/community/attachments/`+id+`/(?:upload|content)$`, path) || match(`^/v1/account/feedback/attachments/`+id+`/upload$`, path) || match(`^/v1/account/data/feedback/exports/`+id+`/attachments/`+id+`/content$`, path)
}
func feedbackOperation(path string) bool {
	return match(`(?i)^/v1/account/feedback/operations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, path)
}
func HasRequestCredential(r *http.Request, path string) bool {
	if _, ok := r.Header["Authorization"]; ok {
		return true
	}
	if !match(`^/v1/operations(?:/|$)`, path) || path == "/v1/operations/login" || path == "/v1/operations/callback" {
		return false
	}
	raw := header(r, "Cookie")
	if len(raw) > 16384 {
		return false
	}
	values := []string{}
	for _, value := range strings.Split(raw, ";") {
		value = strings.TrimSpace(value)
		if match(`^(?:__Host-galaxy-operator|galaxy-operator-fixture)=`, value) {
			values = append(values, value)
		}
	}
	return len(values) == 1 && match(`^(?:__Host-galaxy-operator|galaxy-operator-fixture)=[A-Za-z0-9_-]{43}$`, values[0])
}
func WebsiteQuotaCredential(r *http.Request, path string) string {
	if _, ok := r.Header["Authorization"]; ok {
		return ""
	}
	if path == "/v1/account/login" || path == "/v1/account/callback" || !match(`^/(?:v1/(?:account|discovery)|v2/(?:community|chat))(?:/|$)`, path) {
		return ""
	}
	raw := header(r, "Cookie")
	if len(raw) > 16384 {
		return ""
	}
	values := []string{}
	for _, value := range strings.Split(raw, ";") {
		value = strings.TrimSpace(value)
		if match(`^(?:__Host-galaxy-account|galaxy-account-fixture)=`, value) {
			values = append(values, value)
		}
	}
	if len(values) != 1 {
		return ""
	}
	m := regexp.MustCompile(`^(?:__Host-galaxy-account|galaxy-account-fixture)=([A-Za-z0-9_-]{43})$`).FindStringSubmatch(values[0])
	if m == nil {
		return ""
	}
	return m[1]
}
func Category(method, path string, credential, website bool) string {
	query := func() string {
		if credential {
			return "query"
		}
		return "anonymous"
	}
	if method == "POST" && has([]string{"status", "query", "receipt"}, followMethod(path)) {
		return query()
	}
	if strings.HasPrefix(path, "/v2/community/") {
		if method == "GET" && match(`^/v2/community/(?:posts/`+id+`(?:/versions/`+id+`)?|replies/`+id+`)$`, path) || method == "POST" && (path == "/v2/community/posts/query" || path == "/v2/community/replies/query" || match(`^/v2/community/posts/`+id+`/versions$`, path)) {
			if website {
				return "query"
			}
			return "anonymous"
		}
		if method == "POST" && (strings.HasSuffix(path, "/withdraw") || strings.HasSuffix(path, "/appeal")) {
			return "revocation"
		}
		if method == "GET" || strings.HasSuffix(path, "/query") || strings.HasSuffix(path, "/config") || strings.HasSuffix(path, "/owned") || strings.HasSuffix(path, "/receipt") {
			return query()
		}
	}
	if method == "POST" && strings.HasPrefix(path, "/v2/chat/") {
		if path == "/v2/chat/export/owned" || match(`^/v2/chat/attachments/`+id+`/export-content$`, path) {
			return "export"
		}
		if path == "/v2/chat/rooms/directory" || match(`^/v2/chat/rooms/`+id+`/(?:read|history|decisions|receipt|operation-receipt|agent-grants|agent-participants|join-preview)$`, path) || match(`^/v2/chat/rooms/`+id+`/messages/`+id+`/context$`, path) || match(`^/v2/chat/attachments/`+id+`/content$`, path) {
			return query()
		}
	}
	if method == "POST" && path == "/v2/target-governance/events" {
		return "revocation"
	}
	if method == "POST" && has([]string{"/v2/target-governance/receipt", "/v2/target-governance/target"}, path) {
		return query()
	}
	if path == "/.well-known/oauth-protected-resource/mcp/personal" {
		return "anonymous"
	}
	if method == "POST" && (match(`^/v1/(?:bindings|consents|proofs|context-grants)/`+id+`/revoke$`, path) || has([]string{"/v1/data-exports/revoke", "/v1/audit/grants/revoke", "/v1/deletion-requests/status", "/v1/deletion-requests/submit"}, path)) {
		return "revocation"
	}
	if method == "POST" && (has([]string{"/v1/binding-challenges", "/v2/binding-challenges", "/v1/bindings", "/v1/session-challenges", "/v1/sessions"}, path) || strings.HasPrefix(path, "/v2/identity/control/")) {
		return "binding"
	}
	if has([]string{"/mcp/docs", "/.well-known/galaxy-network.json", "/.well-known/galaxy-signing-keys.json", "/v1/policy", "/v1/signing-keys/status", "/v1/service-status", "/v1/honor/rules", "/v1/honor/ranking", "/v1/honor/rule-history", "/v1/builders/specification"}, path) {
		return "anonymous"
	}
	if strings.HasPrefix(path, "/v1/data-exports/") || path == "/v1/audit/export" || path == "/v1/builders/reports/export" {
		return "export"
	}
	if strings.HasPrefix(path, "/v1/notifications/") {
		return "notifications"
	}
	if method == "POST" && path == "/v2/context/receipt" {
		return query()
	}
	if method == "POST" && strings.HasPrefix(path, "/v2/trust-package/") && path != "/v2/trust-package/permissions/submit" {
		return query()
	}
	if method == "GET" || match(`(?:/query|/read|/config|/policies|/specification)$`, path) || has([]string{"/v1/audit/grants", "/v1/requester-history/facts", "/v2/requester-history/facts", "/v2/honor/ranking", "/v2/contributions/preview", "/v2/account/quotas", "/v2/tasks/receipt", "/v2/consents/receipt"}, path) {
		return query()
	}
	return "submission"
}

// ApplyBrowserPolicy selects explicit Cookie-capable paths, but never replaces
// their own account-ID, current-session, Origin or CSRF business checks.
func ApplyBrowserPolicy(r *http.Request, w http.ResponseWriter, origins []string) (bool, error) {
	if _, ok := r.Header["Origin"]; !ok {
		return false, nil
	}
	origin := header(r, "Origin")
	if !has(origins, origin) {
		return false, browserError("browser_origin_not_enabled")
	}
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Origin", origin)
	path := r.URL.EscapedPath()
	raw := r.RequestURI
	if raw == "" {
		raw = r.URL.RequestURI()
	}
	operations := strings.HasPrefix(path, "/v1/operations/")
	discovery := match(`^/v1/discovery/(?:config|events|recommendations|search)$`, path)
	method := r.Method
	if method == "OPTIONS" {
		method = header(r, "Access-Control-Request-Method")
	}
	accountData := method == "POST" && match(`^/v1/account/data/feedback/(?:export|delete)$`, path) || method == "GET" && match(`(?i)^/v1/account/data/feedback/(?:operations|exports)/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, path) || method == "POST" && match(`(?i)^/v1/account/data/feedback/exports/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/attachments/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/content$`, path)
	account := path == "/v1/web-events" || match(`^/v1/account/(session|logout|settings|type-change|archives|work|external-credentials|bookmarks|chat-reports)(?:/|\?|$)`, raw) || accountData || method == "POST" && followMethod(path) != "" || path == "/v1/account/feedback" || method == "GET" && feedbackOperation(path) || match(`^/v1/account/feedback/attachments/(?:config|prepare|read|revoke)$`, path) || match(`^/v1/account/notifications/notices(?:/`+id+`/read)?$`, path) || strings.HasPrefix(raw, "/v2/community/") || accountChat(path) || accountBinary(path)
	if account || operations || discovery {
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	}
	w.Header().Set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id, X-Galaxy-Content-Sha256, X-Galaxy-Event-Cursor")
	if r.Method != "OPTIONS" {
		return false, nil
	}
	accountHeader := account || discovery || match(`^/v2/account-(?:archives|work|bookmarks)/`, raw)
	credentialDelete := method == "DELETE" && match(`^/v1/account/external-credentials/`+id+`$`, raw)
	upload := method == "PUT" && accountBinary(path) && strings.HasSuffix(path, "/upload")
	allowed := []string{"authorization", "content-type", "accept", "last-event-id", "x-galaxy-user-activity"}
	if accountHeader {
		allowed = append(allowed, "x-galaxy-account-id")
	}
	if account || discovery {
		allowed = append(allowed, "x-galaxy-account-csrf")
	}
	if operations {
		allowed = append(allowed, "x-galaxy-operator-csrf")
	}
	if discovery {
		allowed = append(allowed, "x-galaxy-discovery-csrf")
	}
	if method != "GET" && method != "POST" && !upload && !credentialDelete {
		return false, browserError("browser_preflight_denied")
	}
	for _, value := range strings.Split(header(r, "Access-Control-Request-Headers"), ",") {
		name := strings.ToLower(strings.TrimSpace(value))
		if name != "" && !has(allowed, name) {
			return false, browserError("browser_preflight_denied")
		}
	}
	methods := "GET, POST"
	if upload {
		methods += ", PUT"
	} else if credentialDelete {
		methods += ", DELETE"
	}
	w.Header().Set("Access-Control-Allow-Methods", methods)
	headers := "Authorization, Content-Type, Accept, Last-Event-ID, X-Galaxy-User-Activity"
	if accountHeader {
		headers += ", X-Galaxy-Account-ID"
	}
	if account || discovery {
		headers += ", X-Galaxy-Account-CSRF"
	}
	if operations {
		headers += ", X-Galaxy-Operator-CSRF"
	}
	if discovery {
		headers += ", X-Galaxy-Discovery-CSRF"
	}
	w.Header().Set("Access-Control-Allow-Headers", headers)
	w.Header().Set("Access-Control-Max-Age", "300")
	w.WriteHeader(204)
	return true, nil
}
