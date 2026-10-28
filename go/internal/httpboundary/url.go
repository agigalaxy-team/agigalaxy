package httpboundary

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func browserError(code string) error { return fault.New(code, 403) }

// Browser URLSearchParams tolerates malformed query escapes and treats ';' as
// data. Keep duplicate values for the original route-specific rejection rules.
func browserParams(raw string) map[string][]string {
	m := map[string][]string{}
	decode := func(s string) string {
		s = strings.ReplaceAll(s, "+", " ")
		var b strings.Builder
		for i := 0; i < len(s); i++ {
			if s[i] == '%' && i+2 < len(s) {
				if v, e := url.PathUnescape(s[i : i+3]); e == nil {
					b.WriteString(v)
					i += 2
					continue
				}
			}
			b.WriteByte(s[i])
		}
		return strings.ToValidUTF8(b.String(), "�")
	}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		key, value, _ := strings.Cut(part, "=")
		key = decode(key)
		m[key] = append(m[key], decode(value))
	}
	return m
}
func queryKeys(q map[string][]string, allowed []string) bool {
	for key, values := range q {
		if !has(allowed, key) || len(values) != 1 {
			return false
		}
	}
	return true
}
func one(q map[string][]string, key string) string {
	if len(q[key]) == 0 {
		return ""
	}
	return q[key][0]
}
func optionalMatch(q map[string][]string, key, pattern string) bool {
	_, exists := q[key]
	return !exists || match(pattern, one(q, key))
}
func queryEncode(raw string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c <= 0x20 || c > 0x7e || strings.ContainsRune("\"#<>'", rune(c)) {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}
func normalizePath(u *url.URL) error {
	parts := strings.Split(u.EscapedPath(), "/")
	if len(parts) < 2 {
		return nil
	}
	stack := []string{}
	for i, part := range parts[1:] {
		decoded, e := url.PathUnescape(part)
		if e != nil {
			return fault.New("invalid_request", 400)
		}
		switch decoded {
		case ".":
			if i == len(parts)-2 {
				stack = append(stack, "")
			}
		case "..":
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			if i == len(parts)-2 {
				stack = append(stack, "")
			}
		default:
			stack = append(stack, part)
		}
	}
	path, e := url.Parse("/" + strings.Join(stack, "/"))
	if e != nil {
		return fault.New("invalid_request", 400)
	}
	u.Path, u.RawPath = path.Path, path.RawPath
	return nil
}
func RequestURL(r *http.Request, endpoint string, origins []string) (*url.URL, error) {
	origin := header(r, "Origin")
	if origin != "" && !has(origins, origin) {
		return nil, browserError("browser_origin_not_enabled")
	}
	raw := r.RequestURI
	if raw == "" {
		raw = r.URL.String()
	}
	raw = strings.Trim(raw, " \t\r\n")
	raw = strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(raw)
	prefix := len(raw)
	for _, sep := range []string{"?", "#"} {
		if i := strings.Index(raw, sep); i >= 0 && i < prefix {
			prefix = i
		}
	}
	raw = strings.ReplaceAll(raw[:prefix], "\\", "/") + raw[prefix:]
	relative, e := url.Parse(raw)
	if e != nil {
		return nil, fault.New("invalid_request", 400)
	}
	base, _ := url.Parse(endpoint)
	u := base.ResolveReference(relative)
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	if u.Scheme == "https" && u.Port() == "443" {
		u.Host = strings.TrimSuffix(u.Host, ":443")
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if u.User.Username() == "" && password == "" {
			u.User = nil
		}
	}
	if e = normalizePath(u); e != nil {
		return nil, e
	}
	u.RawQuery = queryEncode(u.RawQuery)
	if u.Scheme != base.Scheme || u.Host != base.Host || u.User != nil || u.Fragment != "" || u.RawQuery != "" && !AllowedQuery(r.Method, u.EscapedPath(), u.RawQuery, header(r, "Access-Control-Request-Method")) {
		return nil, fault.New("invalid_request", 400)
	}
	return u, nil
}
func AllowedQuery(method, path, raw, preflightMethod string) bool {
	q := browserParams(raw)
	n := protocol.TextLength("?" + raw)
	read := method == "GET" || method == "OPTIONS" && preflightMethod == "GET"
	get := method == "GET"
	rule := func(condition bool, max int, keys ...string) bool {
		return condition && n <= max && (keys == nil || queryKeys(q, keys))
	}
	if get && path == "/v1/consents" {
		return queryKeys(q, []string{"after"}) && len(q["after"]) == 1
	}
	if rule(get && (match(`^/v1/identity/callback/[a-z0-9][a-z0-9._-]{0,63}$`, path) || path == "/v1/account/callback" || path == "/v1/operations/callback"), 8192, "code", "state", "iss", "error", "error_description", "error_uri", "session_state") {
		return true
	}
	if rule(read && has([]string{"/v1/account/login", "/v1/account/session", "/v1/account/archives", "/v1/account/external-credentials"}, path), 8192) {
		return true
	}
	if rule(get && match(`(?i)^/v1/identity/return/`+id+`$`, path), 8192) || rule(get && match(`^/v2/recruitment/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/receipt$`, path), 512) {
		return true
	}
	if rule(read && path == "/v1/account/notifications/notices", 512, "after", "limit", "unreadOnly") {
		return true
	}
	if rule(read && match(`(?i)^/v1/account/data/feedback/exports/`+id+`$`, path), 160, "after", "limit") && optionalMatch(q, "after", `^(0|[1-9][0-9]{0,18})$`) && optionalMatch(q, "limit", `^(?:[1-9]|[1-4][0-9]|50)$`) {
		return true
	}
	if rule(get && match(`^/v1/account/public/(?:`+id+`/(?:ids|credentials)|by-id/GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})$`, path), 160, "after", "limit") {
		return true
	}
	if rule(get && match(`^/v1/account/public/`+id+`/posts$`, path), 600, "after", "limit") && optionalMatch(q, "after", `^fp1\.[A-Za-z0-9_-]+$`) && protocol.TextLength(one(q, "after")) <= 512 && optionalMatch(q, "limit", `^(?:[1-9]|[1-4][0-9]|50)$`) {
		return true
	}
	if rule(read && has([]string{"/v1/web-events", "/v1/operations/web-events"}, path), 4096, "cursor", "topics", "stream") && optionalMatch(q, "cursor", `^(0|[1-9][0-9]{0,18})$`) && optionalMatch(q, "stream", `^(true|false)$`) {
		topics := one(q, "topics")
		valid := protocol.TextLength(topics) <= 1024 && len(strings.Split(topics, ",")) <= 32
		if _, exists := q["topics"]; exists {
			for _, topic := range strings.Split(topics, ",") {
				if !match(`^[a-z][a-z-]{0,50}$`, topic) {
					valid = false
				}
			}
		}
		if valid {
			return true
		}
	}
	if rule(read && path == "/v1/operations/permissions/catalog/lease", 80, "version") && len(q) == 1 && len(q["version"]) == 1 && match(`^[a-f0-9]{64}$`, one(q, "version")) {
		return true
	}
	if rule(get && path == "/v2/community/quotas", 96, "postId", "replyId", "sectionId") && len(q) == 1 {
		for _, v := range q {
			if match(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`, v[0]) {
				return true
			}
		}
	}
	if rule(get && path == "/v1/operations/summary", 80, "publicActivity") && len(q) == 1 && one(q, "publicActivity") == "deferred" {
		return true
	}
	// Exact field lists retain the independently validated original read routes.
	type row struct {
		path string
		max  int
		keys []string
	}
	fixed := []row{
		{"/v1/operations/audit", 8192, []string{"accountId", "resourceId", "after", "limit", "action", "kind", "day", "query", "page", "pageSize", "snapshot", "sort"}},
		{"/v1/operations/chat-reports", 8192, []string{"roomId", "state", "after", "limit"}},
		{"/v1/operations/permissions/history", 8192, []string{"after", "limit", "resourceId", "targetOperatorId"}},
		{"/v1/operations/messaging/plans", 8192, []string{"after", "limit", "state"}},
		{"/v1/operations/messaging/runs", 8192, []string{"after", "limit", "planId"}},
		{"/v1/announcements", 8192, []string{"after", "limit"}},
		{"/v1/operations/autonomy/tasks", 2048, []string{"page", "limit", "domain", "source", "state", "mode", "targetType", "targetId"}},
		{"/v1/operations/autonomy/overview", 2048, []string{"days"}},
		{"/v1/operations/agentos/runs", 2048, []string{"page", "limit", "domain", "state"}},
		{"/v1/operations/strategies/records", 2048, []string{"after", "limit", "strategyId"}},
		{"/v1/operations/strategies/versions", 2048, []string{"after", "limit"}},
		{"/v1/operations/recommendation/overview", 2048, []string{"days", "query"}},
		{"/v1/operations/recommendation/history", 2048, []string{"after", "limit"}},
		{"/v1/operations/search-quality/overview", 4096, []string{"days", "query", "issue", "after", "limit"}},
		{"/v1/operations/search-quality/history", 4096, []string{"after", "limit"}},
		{"/v1/operations/maintenance/logs", 4096, []string{"component", "level", "period", "before", "limit"}},
		{"/v1/operations/model-settings/history", 2048, []string{"after", "limit"}},
		{"/v1/operations/model-settings/usage", 2048, []string{"days"}},
		{"/v1/operations/maintenance/backups", 4096, []string{"after", "limit"}},
		{"/v1/operations/maintenance/restore-plans", 4096, []string{"after", "limit"}},
		{"/v1/operations/discovery/analytics", 2048, []string{"kind", "days", "scope", "accountId"}},
		{"/v1/operations/files", 8192, []string{"after", "limit", "kind", "state", "processing", "issue"}},
		{"/v1/operations/files/summary", 8192, []string{"kind", "state", "processing", "issue"}},
		{"/v1/operations/files/cleanup/candidates", 4096, []string{"kind", "after", "limit"}},
		{"/v1/operations/files/cleanup/plans", 4096, []string{"after", "limit"}},
		{"/v1/operations/registered-users", 4096, []string{"page", "pageSize", "query", "source", "subjectType", "login", "emailVerified", "registeredFrom", "registeredTo", "sort", "participation", "business"}},
		{"/v1/operations/management-accounts", 4096, []string{"page", "pageSize", "query", "enabled", "roleId", "aiDomain", "sort"}},
		{"/v1/operations/users", 8192, []string{"query", "after", "limit", "subjectType", "restriction"}},
		{"/v1/operations/feedback", 8192, []string{"query", "category", "module", "state", "days", "after", "limit"}},
		{"/v1/operations/community/content", 8192, []string{"query", "targetId", "kind", "topic", "visibility", "pinned", "featured", "days", "after", "limit"}},
	}
	for _, r := range fixed {
		if rule(get && path == r.path, r.max, r.keys...) {
			return true
		}
	}
	patterns := []row{
		{`^/v1/operations/users/` + id + `/audit$`, 8192, []string{"resourceId", "after", "limit", "action", "kind", "day", "query", "page", "pageSize", "snapshot", "sort"}},
		{`(?i)^/v1/operations/messaging/runs/` + id + `/recipients$`, 8192, []string{"after", "limit", "channel", "state"}},
		{`^/v1/operations/smtp/(?:queue|tests|history)$`, 8192, []string{"after", "limit"}},
		{`(?i)^/v1/operations/messaging/plans/` + id + `/history$`, 8192, []string{"after", "limit"}},
		{`^/v1/operations/ai-work-accounts/(?:overview|governance|messaging|discovery|maintenance)/history$`, 2048, []string{"after", "limit"}},
		{`^/v1/operations/rules/(?:resource-budget|community-quota|forum-quota|business-controls)/versions$`, 2048, []string{"after", "limit"}},
		{`^/v1/operations/system-settings/(?:mail|service-connections)/history$`, 2048, []string{"after", "limit"}},
		{`(?i)^/v1/operations/maintenance/restore-plans/` + id + `$`, 4096, []string{"after", "limit"}},
		{`(?i)^/v1/operations/registered-users/` + id + `/history$`, 4096, []string{"after", "limit"}},
		{`(?i)^/v1/operations/management-accounts/[a-f0-9]{64}/history$`, 4096, []string{"after", "limit"}},
		{`(?i)^/v1/operations/users(?:/` + id + `)?/summary$`, 8192, []string{"days"}},
		{`(?i)^/v1/operations/feedback/` + id + `$`, 8192, []string{"historyAfter"}},
		{`(?i)^/v1/operations/community/content/(post|reply)/` + id + `$`, 8192, []string{"historyAfter"}},
	}
	for _, r := range patterns {
		if rule(get && match(r.path, path), r.max, r.keys...) {
			return true
		}
	}
	if rule(get && path != "/v1/operations/audit" && !match(`^/v1/operations/users/`+id+`/audit$`, path) && path != "/v1/operations/files" && match(`^/v1/operations/(?:login|users(?:/`+id+`(?:/(?:audit|links|type-history))?)?|audit|jobs|search/failures|content/publications|community/(?:sections|reports|posts)|resources/(?:projects|methods)|files|notices|rules/(?:resource-budget|community-quota|forum-quota)/history|retention/runs)$`, path), 8192, "returnTo", "query", "after", "limit", "accountId", "resourceId", "queue", "state", "category", "kind", "processing") {
		return true
	}
	if rule(get && match(`(?i)^/v1/operations/agentos/conversations/(?:overview|governance|messaging|discovery|maintenance)/operations/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/events$`, path), 80, "after") && optionalMatch(q, "after", `^(?:0|[1-9][0-9]{0,9})$`) {
		return true
	}
	if rule(read && path == "/v1/discovery/search", 2048, "q", "topic", "after", "limit") || rule(read && path == "/v1/discovery/recommendations", 2048, "mode", "topic", "limit") {
		return true
	}
	return false
}
