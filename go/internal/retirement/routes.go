// Exact route categories migrated from operations/service-access-v2.mjs.
package retirement

import "regexp"

var v2ControlPosts = routeSet(`/v2/receipt-status/challenges`, `/v1/binding-challenges`, `/v2/binding-challenges`, `/v1/bindings`, `/v2/identity/control/status`, `/v2/identity/control/cancel`, `/v2/consents/receipt`, `/v1/deletion-requests/read`, `/v1/deletion-requests/query`)
var v2StopPosts = routeSet(`/v2/watch-controls/stop`, `/v2/ci/requests/revoke`, `/v2/ci/proofs/revoke`, `/v2/chat/attachments/revoke`, `/v2/chat/shared-summaries/retract`, `/v2/community/attachments/revoke`, `/v2/personal-summaries/delete`, `/v2/choice-snapshots/delete`, `/v2/information/watches/stop`)
var v2ReadPosts = routeSet(`/v1/data-exports/binary`, `/v2/receipt-status/query`, `/v2/watch-controls/query`, `/v2/watch-controls/read`, `/v2/watch-controls/receipt`, `/v2/tasks/query`, `/v2/tasks/receipt`, `/v2/cases/events/receipt`, `/v2/history/query`, `/v2/search/query`, `/v2/search/reference`, `/v2/discovery/query`, `/v2/discovery/detail`, `/v2/configurations/read`, `/v2/configurations/query`, `/v2/configurations/versions`, `/v2/configurations/receipt`, `/v2/verification-records/read`, `/v2/verification-records/status`, `/v2/verification-records/receipt`, `/v2/ci/requests/read`, `/v2/ci/receipts`, `/v2/ci/proofs/read`, `/v2/context/query`, `/v2/context/receipt`, `/v2/experience/read`, `/v2/qualification/evaluate`, `/v2/qualification/candidates`, `/v2/qualification/calculation-owned`, `/v2/qualification/calculation-receipt`, `/v2/qualification/permission-requests/read`, `/v2/qualification/permission-requests/query`, `/v2/qualification/permission-requests/receipt`, `/v2/capsules/read`, `/v2/capsules/query`, `/v2/capsules/uses/query`, `/v2/capsules/versions`, `/v2/capsules/receipt`, `/v2/capsules/permissions/read`, `/v2/capsules/permissions/query`, `/v2/contributions/status`, `/v2/contributions/read`, `/v2/honor/query`, `/v2/honor/ranking`, `/v2/requester-history/query`, `/v2/requester-history/facts`, `/v2/recruitment/query`, `/v2/contacts/query`, `/v2/projects/query`, `/v2/comments/query`, `/v2/comments/receipt`, `/v2/comment-governance/query`, `/v2/comment-governance/receipt`, `/v2/personal-summaries/preferences/read`, `/v2/personal-summaries/get`, `/v2/personal-summaries/receipt`, `/v2/personal-summaries/list`, `/v2/personal-summaries/sources`, `/v2/choice-snapshots/preferences/read`, `/v2/choice-snapshots/get`, `/v2/choice-snapshots/list`, `/v2/choice-snapshots/receipt`, `/v2/notifications/query`, `/v2/notifications/options/read`, `/v2/chat/rooms/query`, `/v2/chat/invitations/query`, `/v2/chat/export/owned`, `/v2/chat/rooms/directory`, `/v2/chat/accounts/query`, `/v1/account/bookmarks/status`, `/v1/account/bookmarks/query`, `/v1/account/bookmarks/receipt`, `/v2/account-bookmarks/status`, `/v2/account-bookmarks/query`, `/v2/account-bookmarks/receipt`, `/v2/community/attachments/config`, `/v2/community/attachments/read`, `/v2/community/attachments/query`, `/v2/chat/shared-summaries/get`, `/v2/chat/shared-summaries/list`, `/v2/chat/shared-summaries/receipt`, `/v2/chat/attachments/config`, `/v2/chat/attachments/read`, `/v2/chat/attachments/query`, `/v1/builders/manage/read`, `/v1/builders/owned/query`, `/v1/builders/events/receipt`, `/v1/builders/notices/query`, `/v1/builders/node-control/export`, `/v2/builders/support/read`, `/v2/builders/pack/export`, `/v2/builders/pack/manifest`, `/v2/builders/pack-uses/candidates`, `/v2/builders/pack-uses/query`, `/v2/builders/pack-uses/read`, `/v2/builders/pack-uses/receipt`, `/v2/trust-package/permissions/receipt`, `/v2/trust-package/permissions/status`, `/v2/trust-package/permissions/query`, `/v2/hubs/status`, `/v2/hubs/read`, `/v2/hubs/manage`, `/v2/hubs/query`, `/v2/hubs/memberships`, `/v2/hubs/intake`, `/v2/hubs/receipt`, `/v2/hubs/peering/read`, `/v2/hubs/peering/list`, `/v2/hubs/peering/receipt`, `/v2/hubs/peering/connections`, `/v2/hubs/peering/party`)
var v2ControlState = regexp.MustCompile(`^/v2/identity/GUID[0-9A-Z]{28}/control$`)
var v2BindingRead = regexp.MustCompile(`^/v1/bindings/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var v2RoomStop = regexp.MustCompile(`^/v2/chat/rooms/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:leave|agent-revoke)$`)
var v2MessageStop = regexp.MustCompile(`^/v2/chat/rooms/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/messages/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:retract|hide)$`)
var v2ReadGets = regexp.MustCompile(`^/v2/(?:tasks|projects|contacts|recruitment|comments)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^/v2/tasks$|^/v2/context/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:/metadata)?$|^/v2/comment-governance/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|config)$`)
var v2CaseRead = regexp.MustCompile(`^/v2/cases/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/read$`)
var v2TaskCaseLinkReceipt = regexp.MustCompile(`^/v2/tasks/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/case-link/receipt$`)
var v2TaskOwnerRead = regexp.MustCompile(`^/v2/tasks/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/owner-read(?:/prepare)?$`)
var v2TaskOwnerControlPrepare = regexp.MustCompile(`^/v2/tasks/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/owner-control/prepare$`)
var v2ModerationReceipt = regexp.MustCompile(`^/v1/moderation/reports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/receipt$`)
var v2RoomRead = regexp.MustCompile(`^/v2/chat/rooms/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:read|history|decisions|receipt|agent-grants|agent-participants|join-preview)$`)
var v2ProjectPreferences = regexp.MustCompile(`^/v2/projects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/preferences/read$`)
var v2AttachmentExport = regexp.MustCompile(`^/v2/chat/attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/export-content$`)
var v2SourceAttachmentRead = regexp.MustCompile(`^/v2/(?:chat|community)/attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/content$`)
var v2RecruitmentReceipt = regexp.MustCompile(`^/v2/recruitment/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/receipt$`)
var v2HonorGet = regexp.MustCompile(`^/v2/honor/GUID[0-9A-Z]{28}/[a-z0-9][a-z0-9._-]{0,79}/[0-9]+(?:\.[0-9]+){0,2}$`)
var retirementMetadata = routeSet(`POST /v1/deletion-requests/status`, `GET /v1/service-status`, `GET /v1/policy`, `GET /.well-known/galaxy-signing-keys.json`, `GET /v1/signing-keys/status`)
var retirementTakeoutPosts = routeSet(`/v2/information/query`, `/v2/information/watches/list`, `/v2/information/watches/receipt`, `/v2/information/watches/events`, `/v2/information/watches/stop`, `/v2/chat/attachments/config`, `/v2/chat/attachments/query`, `/v2/chat/attachments/revoke`, `/v1/identity/query`, `/v1/identity/cancel`, `/v1/identity/revoke`, `/v1/deletion-requests/config`, `/v1/deletion-requests/submit`, `/v1/deletion-requests/read`, `/v1/deletion-requests/query`, `/v1/binding-challenges`, `/v1/bindings`, `/v1/bindings/query`, `/v1/session-challenges`, `/v1/sessions`, `/mcp/docs`, `/v1/data-exports/specification`, `/v1/data-exports/create`, `/v1/data-exports/page`, `/v1/data-exports/binary`, `/v1/data-exports/revoke`, `/v1/history/query`, `/v1/assistance/query`, `/v1/assistance/events/receipt`, `/v1/context-grants/query`, `/v1/context-grants/receipt`, `/v1/requester-history/query`, `/v1/notifications/query`, `/v1/notifications/preferences/read`, `/v1/qualification/policies`, `/v1/qualification/evaluate`, `/v1/builders/specification`, `/v1/builders/read`, `/v1/builders/query`, `/v1/builders/reports/export`, `/v1/capsules/read`, `/v1/capsules/query`, `/v1/capsules/uses/query`, `/v1/honor/rules`, `/v1/honor/query`, `/v1/honor/ranking`, `/v1/honor/rule-history`, `/v1/moderation/config`, `/v1/moderation/reports/query`, `/v1/audit/config`, `/v1/audit/query`, `/v1/audit/export`, `/v1/audit/grants`, `/v1/audit/grants/revoke`)
var retirementProofStatus = regexp.MustCompile(`^/v1/proofs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/status$`)
var retirementRevocation = regexp.MustCompile(`^/v1/(?:bindings|consents|proofs|context-grants)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revoke$`)
var retirementModerationRead = regexp.MustCompile(`^/v1/moderation/reports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/read$`)
var retirementOwnAttachmentExport = regexp.MustCompile(`^/v2/chat/attachments/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/export-content$`)
var retirementTakeoutRead = regexp.MustCompile(`^/v1/(?:bindings|cases|verifications|assistance|context-grants)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^/v1/proofs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:/status)?$|^/v1/profiles/GUID[0-9A-Z]{28}$|^/v1/honor/GUID[0-9A-Z]{28}/[a-z0-9][a-z0-9._-]{0,79}/[0-9]+(?:\.[0-9]+){0,2}$`)

func routeSet(paths ...string) map[string]bool {
	m := map[string]bool{}
	for _, path := range paths {
		m[path] = true
	}
	return m
}

// ServiceAccessV2 classifies only the original named operations. An empty result
// is unclassified; this classification never supplies object authorization.
func ServiceAccessV2(method, path string) string {
	if method == "GET" && (v2ControlState.MatchString(path) || v2BindingRead.MatchString(path) || path == "/v1/consents") {
		return "control"
	}
	if method == "POST" && v2ControlPosts[path] {
		return "control"
	}
	if method == "POST" && (v2StopPosts[path] || v2RoomStop.MatchString(path) || v2MessageStop.MatchString(path)) {
		return "stop"
	}
	if method == "POST" && (v2ReadPosts[path] || v2CaseRead.MatchString(path) || v2TaskCaseLinkReceipt.MatchString(path) || v2TaskOwnerRead.MatchString(path) || v2TaskOwnerControlPrepare.MatchString(path) || v2ModerationReceipt.MatchString(path) || v2RoomRead.MatchString(path) || v2ProjectPreferences.MatchString(path) || v2AttachmentExport.MatchString(path) || v2SourceAttachmentRead.MatchString(path)) {
		return "read"
	}
	if method == "GET" && (v2ReadGets.MatchString(path) || v2HonorGet.MatchString(path) || v2RecruitmentReceipt.MatchString(path)) {
		return "read"
	}
	return ""
}
