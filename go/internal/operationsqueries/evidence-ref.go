package operationsqueries

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/url"
	"strings"
)

var kindLabels = map[string]string{"account": "业务账户", "account-summary": "账户使用情况", "registered-user": "注册用户", "post": "公开帖子", "reply": "公开回复", "section": "版块", "case": "举报案件", "chat-report": "私聊案件", "feedback": "使用反馈", "chat-file": "私聊文件", "forum-file": "公开附件", "file-cleanup-plan": "具体文件清理计划", "file-cleanup-operation": "文件清理处理结果", "project": "项目", "method": "方法", "message-plan": "消息计划", "message-run": "消息执行", "rule": "业务规则", "strategy-run": "策略执行", "ai-run": "AI运行", "backup-point": "备份点", "restore-plan": "恢复方案", "role": "业务角色"}

func refVersion(r reference) any {
	x := r.row
	if r.kind == "message-plan" {
		raw, _ := protocol.EncodeJS([]any{x["version"], x["revision"], x["state"]})
		return string(raw)
	}
	if r.kind == "case" && object(x["source"]) != nil {
		if events, ok := x["events"].([]any); ok {
			source := object(x["source"])
			var locator any
			if l := object(source["locator"]); l != nil {
				ordered := protocol.NewOrderedObject()
				for _, key := range []string{"kind", "postId", "replyId", "versionId", "contentRevision"} {
					if v, ok := l[key]; ok {
						ordered.Set(key, v)
					}
				}
				locator = ordered
			}
			rows := []any{}
			for _, v := range events {
				e := object(v)
				rows = append(rows, []any{e["id"], e["version"], e["kind"]})
			}
			raw, _ := protocol.EncodeJS([]any{x["version"], locator, source["availability"], source["publishedUntil"], x["knownPartyConflict"], x["legacyPrivateNarrativeGranted"], rows})
			return identity.Digest(raw)
		}
	}
	if r.kind == "chat-report" {
		if items, ok := x["materials"].([]any); ok {
			rows := []any{}
			for _, v := range items {
				m := object(v)
				rows = append(rows, []any{m["eventId"], m["messageId"], m["revision"], m["state"], m["sourceExpiresAt"], object(m["moderation"])["revision"]})
			}
			raw, _ := protocol.EncodeJS([]any{x["version"], rows})
			return identity.Digest(raw)
		}
	}
	if oneOf(r.kind, "post", "reply", "project", "method", "section") != nil {
		raw, _ := protocol.EncodeJS([]any{x["version"], x["versionId"], x["sourceState"], object(x["visibility"])["hidden"], object(x["curation"])["revision"]})
		return string(raw)
	}
	for _, key := range []string{"profileRevision", "version", "revision", "updatedAt"} {
		if x[key] != nil {
			return x[key]
		}
	}
	return nil
}
func objectHref(r reference) string {
	base := "/admin/operations/" + locations[kinds[r.kind]]
	escape := url.QueryEscape(r.id)
	join := func(query string) string {
		separator := "?"
		if strings.Contains(base, "?") {
			separator = "&"
		}
		return base + separator + query
	}
	switch r.kind {
	case "registered-user":
		return join("registration=" + escape + "&view=detail")
	case "account", "account-summary":
		q := "account=" + escape
		if r.kind == "account-summary" {
			q += "&tab=profile"
		}
		return join(q)
	case "post", "reply":
		return join("contentKind=" + r.kind + "&id=" + escape)
	case "section":
		return "/admin/operations/community?tab=sections&id=" + escape
	case "chat-file", "forum-file":
		kind := "chat"
		if r.kind == "forum-file" {
			kind = "forum"
		}
		return join("id=" + escape + "&fileKind=" + kind)
	case "file-cleanup-plan":
		return join("kind=all&view=cleanup&plan=" + escape)
	case "file-cleanup-operation":
		q := "kind=all&view=cleanup"
		if p := str(r.row["planId"]); p != "" {
			q += "&plan=" + url.QueryEscape(p)
		}
		return join(q)
	case "project", "method":
		kind := "projects"
		if r.kind == "method" {
			kind = "methods"
		}
		return join("id=" + escape + "&kind=" + kind)
	case "message-run", "ai-run":
		return join("run=" + escape)
	case "rule":
		return join("key=" + escape)
	case "strategy-run":
		return join("tab=runs&run=" + escape)
	case "backup-point":
		return join("tab=backups&point=" + escape)
	case "restore-plan":
		return join("tab=backups&plan=" + escape)
	case "role":
		return join("tab=roles&id=" + escape)
	}
	return join("id=" + escape)
}
func (s *Service) ref(r reference, at int64, deadline float64) Object {
	if r.id == "" {
		return nil
	}
	filters := r.filters
	if filters == nil {
		filters = Object{}
	}
	args := Object{"kind": r.kind, "id": r.id, "filters": filters}
	if _, e := parse("read-operation-object", args); e != nil {
		return nil
	}
	readable := oneOf(r.kind, "post", "reply", "project", "method", "section") != nil && publicVisible(r.row)
	public := oneOf(r.kind, "post", "reply") != nil && readable
	caseSource := r.kind == "case" && r.purpose == "public-case-review"
	private := r.kind == "chat-report" && r.purpose == "private-case-review"
	draft := r.kind == "message-plan" && r.purpose == "message-draft-editing"
	feedback := r.kind == "feedback" && r.purpose == "feedback-processing"
	labelSource := r.row["displayName"]
	if labelSource == nil {
		labelSource = r.row["name"]
	}
	if readable || feedback {
		labelSource = r.row["title"]
	}
	if draft {
		labelSource = object(object(r.row["config"])["content"])["title"]
	}
	label := text(labelSource)
	if label == nil {
		label = kindLabels[r.kind]
	}
	purpose := "operations"
	switch {
	case feedback:
		purpose = "feedback-processing"
	case caseSource:
		purpose = "public-case-review"
	case private:
		purpose = "private-case-review"
	case draft:
		purpose = "message-draft-editing"
	case public:
		purpose = "public-content"
	}
	var expiry any
	if public {
		expiry = r.row["publishedUntil"]
	} else if caseSource && object(r.row["source"])["availability"] == "available" {
		expiry = object(r.row["source"])["publishedUntil"]
	}
	if n, ok := number(expiry); ok {
		deadline = min(deadline, n)
	}
	return Object{"kind": r.kind, "id": r.id, "version": refVersion(r), "label": label, "href": objectHref(r), "purpose": purpose, "controlledSource": readable || feedback || caseSource || private || draft, "checkedAt": at, "readExpiresAt": deadline, "read": Object{"tool": "read-operation-object", "arguments": args}}
}
