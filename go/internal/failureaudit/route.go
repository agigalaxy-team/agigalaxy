package failureaudit

import (
	"regexp"
	"strings"
)

var fixedRoutes = map[string]bool{
	"/v1/identity/providers":                true,
	"/v1/identity/begin":                    true,
	"/v1/identity/status":                   true,
	"/v1/identity/cancel":                   true,
	"/v1/identity/confirm":                  true,
	"/v1/identity/query":                    true,
	"/v1/identity/revoke":                   true,
	"/v1/binding-challenges":                true,
	"/v1/bindings":                          true,
	"/v1/bindings/query":                    true,
	"/v1/session-challenges":                true,
	"/v1/sessions":                          true,
	"/v1/data-exports/specification":        true,
	"/v1/data-exports/create":               true,
	"/v1/data-exports/page":                 true,
	"/v1/data-exports/revoke":               true,
	"/v1/deletion-requests/status":          true,
	"/v1/deletion-requests/config":          true,
	"/v1/deletion-requests/submit":          true,
	"/v1/deletion-requests/read":            true,
	"/v1/deletion-requests/query":           true,
	"/v1/audit/config":                      true,
	"/v1/audit/query":                       true,
	"/v1/audit/export":                      true,
	"/v1/audit/grants":                      true,
	"/v1/audit/grants/approve":              true,
	"/v1/audit/grants/revoke":               true,
	"/v1/consents":                          true,
	"/v1/cases":                             true,
	"/v1/case-events":                       true,
	"/v1/evidence-submissions":              true,
	"/v1/proof-previews":                    true,
	"/v1/proofs":                            true,
	"/v1/policy":                            true,
	"/v1/service-status":                    true,
	"/v1/signing-keys/status":               true,
	"/.well-known/galaxy-network.json":      true,
	"/.well-known/galaxy-signing-keys.json": true,
	"/mcp/docs":                             true,
	"/readyz":                               true,
	"/healthz":                              true,
	"/v1/builders/events":                   true,
	"/v1/builders/read":                     true,
	"/v1/builders/query":                    true,
	"/v1/builders/reports/export":           true,
	"/v1/builders/node-control/export":      true,
	"/v1/builders/manage/read":              true,
	"/v1/builders/owned/query":              true,
	"/v1/builders/events/receipt":           true,
	"/v1/builders/notices/query":            true,
	"/v1/capsules/events":                   true,
	"/v1/capsules/uses":                     true,
	"/v1/capsules/read":                     true,
	"/v1/capsules/query":                    true,
	"/v1/capsules/uses/query":               true,
	"/v1/history/query":                     true,
	"/v1/search/query":                      true,
	"/v1/profiles/statements":               true,
	"/v1/honor/query":                       true,
	"/v1/honor/ranking":                     true,
	"/v1/honor/rules":                       true,
	"/v1/honor/rule-history":                true,
	"/v1/assistance":                        true,
	"/v1/assistance/query":                  true,
	"/v1/assistance/events/receipt":         true,
	"/v1/requester-history/query":           true,
	"/v1/context-grants":                    true,
	"/v1/context-grants/query":              true,
	"/v1/context-grants/receipt":            true,
	"/v1/qualification/policies":            true,
	"/v1/qualification/evaluate":            true,
	"/v1/notifications/query":               true,
	"/v1/notifications/preferences/read":    true,
	"/v1/notifications/preferences/save":    true,
	"/v1/notifications/read":                true,
	"/v1/notifications/archive":             true,
	"/v1/requester-history/facts":           true,
	"/v1/moderation/config":                 true,
	"/v1/moderation/reports":                true,
	"/v1/moderation/reports/query":          true,
	"/v1/account/follows/status":            true,
	"/v1/account/follows/query":             true,
	"/v1/account/follows/command":           true,
	"/v1/account/follows/receipt":           true,
	"/v1/account/session":                   true,
	"/v1/account/login":                     true,
	"/v1/account/logout":                    true,
	"/v1/account/callback":                  true,
	"/v1/account/settings":                  true,
	"/v1/account/work/list":                 true,
	"/v1/account/work/get":                  true,
	"/v1/account/work/status":               true,
	"/v1/account/work/delete":               true,
	"/v1/account/archives":                  true,
	"/v1/operations/session":                true,
	"/v1/operations/login":                  true,
	"/v1/operations/callback":               true,
	"/v1/operations/logout":                 true,
	"/v1/operations/users":                  true,
	"/v1/operations/audit":                  true,
	"/v1/operations/chat-reports":           true,
	"/v1/operations/jobs":                   true,
	"/v1/operations/search/failures":        true,
	"/v1/operations/content/publications":   true,
	"/v1/announcements":                     true,
	"/v1/operations/messaging/plans":        true,
	"/v1/operations/messaging/runs":         true,
	"/v1/discovery/config":                  true,
	"/v1/discovery/events":                  true,
	"/v1/discovery/search":                  true,
	"/v1/discovery/recommendations":         true,
	"/v1/operations/discovery/analytics":    true,
	"/v1/operations/agentos/status":         true,
	"/v1/operations/agentos/options":        true,
	"/v1/operations/agentos/executions":     true,
	"/v1/operations/agentos/runs":           true,
	"/v1/internal/agentos/authorize":        true,
	"/v1/internal/agentos/tools/execute":    true,
	"/v1/operations/smtp":                   true,
	"/v1/operations/smtp/identities":        true,
	"/v1/operations/smtp/queue":             true,
	"/v1/operations/smtp/bounces":           true,
	"/v1/operations/smtp/domains":           true,
	"/v1/operations/smtp/tests":             true,
	"/v1/operations/smtp/history":           true,
	"/v1/operations/smtp/settings":          true,
	"/v1/operations/smtp/tests/connection":  true,
	"/v1/operations/smtp/tests/delivery":    true,
	"/v2/community/topics":                  true,
	"/v2/community/access-options":          true,
	"/v2/community/posts":                   true,
	"/v2/community/posts/query":             true,
	"/v2/community/posts/owned":             true,
	"/v2/community/sections":                true,
	"/v2/community/sections/query":          true,
	"/v2/community/reports":                 true,
	"/v2/community/reports/query":           true,
	"/v2/community/accounts/query":          true,
	"/v2/community/notifications/query":     true,
	"/v2/community/notifications/read":      true,
	"/v2/community/attachments/config":      true,
	"/v2/community/attachments/prepare":     true,
	"/v2/community/attachments/read":        true,
	"/v2/community/attachments/query":       true,
	"/v2/community/attachments/revoke":      true,
	"/v2/chat/attachments/config":           true,
	"/v2/chat/attachments/prepare":          true,
	"/v2/chat/attachments/read":             true,
	"/v2/chat/attachments/query":            true,
	"/v2/chat/attachments/revoke":           true,
	"/v2/account-work/put":                  true,
	"/v2/account-work/get":                  true,
	"/v2/account-work/list":                 true,
	"/v2/account-work/status":               true,
	"/v2/account-work/delete":               true,
	"/v2/account-archives/accounts":         true,
	"/v2/account-archives/list":             true,
	"/v2/account-archives/status":           true,
	"/v2/reading-bookmarks/query":           true,
	"/v2/reading-bookmarks/get":             true,
	"/v2/reading-bookmarks/save":            true,
	"/v2/reading-bookmarks/remove":          true,
}

type routePattern struct {
	pattern  *regexp.Regexp
	template string
}

var routePatterns = []routePattern{
	{regexp.MustCompile(`(?i)^/v1/operations/files/(?:chat|forum)/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/access$`), "/v1/operations/files/:kind/:id/access"},
	{regexp.MustCompile(`(?i)^/v1/operations/files/access/operations/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`), "/v1/operations/files/access/operations/:id"},
	{regexp.MustCompile(`^/v1/operations/rules/(resource-budget|community-quota|forum-quota|business-controls)/(detail|versions|draft|publish|restore|sample)$`), "/v1/operations/rules/:key"},
	{regexp.MustCompile(`(?i)^/v1/operations/rules/operations/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`), "/v1/operations/rules/operations/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/agentos/executions/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:events|runs|review|continue))?$`), "/v1/operations/agentos/executions/:id"},
	{regexp.MustCompile(`^/v1/operations/agentos/runs/[A-Za-z0-9_-]{1,128}$`), "/v1/operations/agentos/runs/:run"},
	{regexp.MustCompile(`(?i)^/v1/account/public/by-uid/[a-z0-9]{6,16}$`), "/v1/account/public/by-uid/:uid"},
	{regexp.MustCompile(`(?i)^/v1/account/public/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/posts)?$`), "/v1/account/public/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/users/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:audit|links|type-history|restriction(?:/release)?|type-change))?$`), "/v1/operations/users/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/jobs/(information-watch|search-recovery|content-publication|account-notice|retention-cleanup|messaging-run|messaging-delivery)/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:cancel|retry))?$`), "/v1/operations/jobs/:queue/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/messaging/plans/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:save|activate|pause|resume|stop|withdraw|history))?$`), "/v1/operations/messaging/plans/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/messaging/runs/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:retry|recipients))?$`), "/v1/operations/messaging/runs/:id"},
	{regexp.MustCompile(`(?i)^/v1/announcements/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`), "/v1/announcements/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/search/failures/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/retry)?$`), "/v1/operations/search/failures/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/chat-reports/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/event|/attachments/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/content)?$`), "/v1/operations/chat-reports/:id"},
	{regexp.MustCompile(`(?i)^/v1/operations/content/publications/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`), "/v1/operations/content/publications/:id"},
	{regexp.MustCompile(`(?i)^/v2/community/(posts|sections|replies|reports)/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(/(?:versions|replies|permissions|quota|classification|events|receipt))?$`), "/v2/community/:kind/:id"},
	{regexp.MustCompile(`(?i)^/v2/(community|chat)/attachments/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/(content|export-content)$`), "/v2/:area/attachments/:id/:operation"},
}

var pretemplatedRoutes = []*regexp.Regexp{
	regexp.MustCompile(`^/v1/operations/files/(?::kind/:id/access|access/operations/:id)$`),
	regexp.MustCompile(`^/v1/operations/rules/(?:overview|:key/(?:detail|versions|draft|publish|restore|sample)|operations/:id)$`),
	regexp.MustCompile(`^/v1/operations/agentos/(?:executions/:id(?:/(?:events|runs|review|continue))?|runs/:run)$`),
	regexp.MustCompile(`^/v1/(?:announcements/:id|operations/(?:messaging/(?:plans/:id(?:/(?:save|activate|pause|resume|stop|withdraw|history))?|runs/:id(?:/(?:retry|recipients))?)|jobs/(?:information-watch|search-recovery|content-publication|account-notice|retention-cleanup|messaging-run|messaging-delivery)/:id(?:/(?:cancel|retry))?))$`),
	regexp.MustCompile(`^/v1/(?:identity/callback/:provider|(?:bindings|consents|cases|verifications|proofs|assistance|context-grants|moderation/reports)/:id(?:/(?:revoke|status|events|accept|read))?|account/public/(?:by-uid/:uid|:id(?:/posts)?)|operations/(?:users/:id(?:/(?:audit|links|type-history|restriction(?:/release)?|type-change))?|jobs/(?:information-watch|search-recovery|content-publication)/:id(?:/(?:cancel|retry))?|search/failures/:id(?:/retry)?|chat-reports/:id(?:/event|/attachments/:id/content)?|content/publications/:id))$`),
	regexp.MustCompile(`^/v2/(?:community/(?:posts|sections|replies|reports)/:id(?:/(?:versions|replies|permissions|quota|classification|events|receipt))?|(?:community|chat)/attachments/:id/(?:content|export-content))$`),
}
var callbackRoute = regexp.MustCompile(`^/v1/identity/callback/[a-z0-9][a-z0-9._-]{0,63}$`)
var finalRoute = regexp.MustCompile(`^/v1/(bindings|consents|cases|verifications|proofs|assistance|context-grants|moderation/reports)/[0-9a-f-]{36}(/(revoke|status|events|accept|read))?$`)

// FailureRoute consumes only a pathname, never a raw URL or query string. Unknown
// routes become http.request; dynamic identifiers use the original templates.
func FailureRoute(method, path string) string {
	if (method == "GET" || method == "POST" || method == "DELETE") && path == "/mcp/personal" {
		return method + " /mcp/personal"
	}
	if method == "GET" && path == "/.well-known/oauth-protected-resource/mcp/personal" {
		return "GET " + path
	}
	if method != "GET" && method != "POST" {
		return "http.request"
	}
	for _, pattern := range pretemplatedRoutes {
		if pattern.MatchString(path) {
			return method + " " + path
		}
	}
	if method == "GET" && callbackRoute.MatchString(path) {
		return "GET /v1/identity/callback/:provider"
	}
	if fixedRoutes[path] {
		return method + " " + path
	}
	for _, pattern := range routePatterns {
		match := pattern.pattern.FindStringSubmatch(path)
		if match == nil {
			continue
		}
		suffix := ""
		if len(match) > 1 {
			suffix = match[1]
		}
		out := pattern.template + suffix
		switch pattern.template {
		case "/v1/operations/rules/:key":
			out = pattern.template + "/" + match[2]
		case "/v2/community/:kind/:id":
			out = "/v2/community/" + suffix + "/:id" + match[2]
		case "/v1/operations/jobs/:queue/:id":
			out = "/v1/operations/jobs/" + suffix + "/:id" + match[2]
		case "/v2/:area/attachments/:id/:operation":
			out = "/v2/" + suffix + "/attachments/:id/" + match[2]
		case "/v1/operations/chat-reports/:id":
			if strings.HasPrefix(suffix, "/attachments/") {
				suffix = "/attachments/:id/content"
			}
			out = pattern.template + suffix
		}
		return method + " " + out
	}
	match := finalRoute.FindStringSubmatch(path)
	if match != nil {
		return method + " /v1/" + match[1] + "/:id" + match[2]
	}
	return "http.request"
}
