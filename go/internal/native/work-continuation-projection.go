package native

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"math"
	"strconv"
	"strings"
)

func continuationText(v any) string {
	switch x := v.(type) {
	case string:
		return uploadTrim(x)
	case jstext.String:
		return x.Trim().Decoded()
	}
	return ""
}
func continuationLines(heading string, values ...string) string {
	out := []string{}
	for _, v := range values {
		if uploadTrim(v) != "" {
			out = append(out, v)
		}
	}
	if len(out) == 0 {
		return ""
	}
	return heading + "\n" + strings.Join(out, "\n")
}
func continuationJoin(values ...string) string {
	out := []string{}
	for _, v := range values {
		if v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, "\n\n")
}
func continuationPick(v map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, key := range keys {
		if x, ok := v[key]; ok {
			out[key] = x
		}
	}
	return out
}
func continuationStrings(v any) []string {
	out := []string{}
	for _, item := range uploadRows(v) {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

var continuationOutcomes = map[string]string{"succeeded": "报告完成", "partial": "部分完成", "failed": "未完成", "inconclusive": "暂不能得出结论", "conflicting": "观察有冲突"}

type continuationReading struct {
	title, content string
	notes          []any
	until          any
	deadline       string
}

func continuationNumber(v any, coerce bool) (float64, bool) {
	switch n := v.(type) {
	case json.Number:
		f, e := n.Float64()
		return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case bool:
		if coerce {
			if n {
				return 1, true
			}
			return 0, true
		}
	case string:
		if coerce {
			s := uploadTrim(n)
			if s == "" {
				return 0, true
			}
			f, e := strconv.ParseFloat(s, 64)
			return f, e == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
		}
	}
	return 0, false
}
func continuationTaskDeadline(data map[string]any) any {
	var minimum any
	value := 0.0
	for _, raw := range uploadObject(uploadObject(data["textView"])["fields"]) {
		if n, ok := continuationNumber(uploadObject(raw)["availableUntil"], false); ok && (minimum == nil || n < value) {
			minimum = n
			value = n
		}
	}
	return minimum
}
func capsuleSourceReading(value map[string]any) any {
	if value == nil {
		return nil
	}
	reading := func(item map[string]any, keys ...string) map[string]any {
		ref := continuationPick(uploadObject(item["ref"]), "kind", "id", "version", "caseId")
		out := map[string]any{"status": "unavailable"}
		if item["ref"] != nil {
			out["ref"] = ref
		}
		if item["status"] == "available" {
			out = continuationPick(item, keys...)
			out["status"] = "available"
			out["ref"] = ref
		}
		return out
	}
	return map[string]any{"case": reading(uploadObject(value["case"]), "authorId", "title", "summary"), "result": reading(uploadObject(value["result"]), "authorId", "summary", "reportedOutcome", "limitations", "currentness")}
}
func sourceContinuationReading(object, data map[string]any) (*continuationReading, error) {
	bad := func() (*continuationReading, error) {
		return nil, connectionFailure("work_continuation_source_mismatch")
	}
	r := &continuationReading{notes: []any{}, deadline: "source-expired"}
	kind := text(object["kind"])
	switch kind {
	case "task":
		request := uploadObject(data["request"])
		if data["taskId"] != object["id"] || request == nil {
			return bad()
		}
		r.title = continuationText(request["title"])
		if r.title == "" {
			r.title = "这项求助"
		}
		work := uploadObject(request["workContext"])
		r.content = continuationJoin(continuationLines("需要的帮助", continuationText(request["summary"])), continuationLines("目标", continuationText(work["goal"])), continuationLines("当前情况", continuationText(work["currentSituation"])), continuationLines("希望取得", continuationText(request["expectedOutcome"])))
		r.notes = []any{"只使用这次服务返回的当前正文；这是阅读，不代表已参与或已完成。"}
		r.until = continuationTaskDeadline(data)
		r.deadline = "temporarily-unavailable"
	case "project":
		if data["projectId"] != object["id"] {
			return bad()
		}
		d := uploadObject(data["document"])
		if d == nil {
			return nil, nil
		}
		r.title = continuationText(d["title"])
		if r.title == "" {
			r.title = "这个项目"
		}
		r.content = continuationText(d["summary"])
		if fs := continuationStrings(d["functions"]); len(fs) > 0 {
			r.notes = append(r.notes, "适用方向："+strings.Join(fs, "、"))
		}
	case "person":
		if data["subjectId"] != object["id"] {
			return bad()
		}
		d := uploadObject(data["selfDeclared"])
		if d == nil || continuationText(d["displayName"]) == "" && continuationText(d["about"]) == "" {
			return nil, nil
		}
		r.title = continuationText(d["displayName"])
		if r.title == "" {
			r.title = "这位作者"
		}
		r.content = continuationText(d["about"])
		if caps := continuationStrings(d["claimedCapabilities"]); len(caps) > 0 {
			r.notes = append(r.notes, "本人介绍的方向："+strings.Join(caps, "、"))
		}
		r.until = data["selfDeclaredReadExpiresAt"]
		r.deadline = "temporarily-unavailable"
	case "post":
		locator := uploadObject(data["locator"])
		if locator["postId"] != object["id"] || object["versionId"] != nil && locator["versionId"] != object["versionId"] {
			return bad()
		}
		d := uploadObject(data["payload"])
		if data["availability"] != "available" || d == nil {
			return nil, nil
		}
		r.title = continuationText(d["title"])
		if r.title == "" {
			r.title = "这篇帖子"
		}
		r.content = continuationText(d["body"])
		r.until = data["publishedUntil"]
	case "context":
		metadata := uploadObject(data["metadata"])
		if metadata["grantId"] != object["id"] {
			return bad()
		}
		if data["contextAccessGranted"] != true {
			return nil, nil
		}
		r.title = "本次选定的工作材料"
		parts := []string{}
		for _, raw := range uploadRows(data["materials"]) {
			m := uploadObject(raw)
			label := continuationText(m["label"])
			if label == "" {
				label = "所选材料"
			}
			if part := continuationLines(label, continuationText(m["content"])); part != "" {
				parts = append(parts, part)
			}
		}
		r.content = strings.Join(parts, "\n\n")
		r.notes = []any{"材料只按现有许可读取，不附带执行或再次分享授权。"}
		r.until = metadata["expiresAt"]
	case "capsule":
		version := uploadObject(data["version"])
		if data["capsuleId"] != object["id"] || version["id"] != object["versionId"] && data["versionId"] != object["versionId"] {
			return bad()
		}
		d := uploadObject(version["payload"])
		if d == nil {
			d = version
		}
		if d == nil || data["sourceStatus"] == "source-unavailable" {
			return nil, nil
		}
		r.title = continuationText(d["title"])
		if r.title == "" {
			r.title = "这份方法"
		}
		r.content = continuationJoin(continuationLines("适用问题", continuationText(d["problemPattern"])), continuationLines("解决方法", continuationText(d["solutionStrategy"])), continuationLines("适用范围", continuationText(d["applicableScope"])), continuationLines("验证方式", continuationText(d["verificationMethod"])), continuationLines("限制", continuationStrings(d["limitations"])...))
		if source := uploadObject(capsuleSourceReading(uploadObject(data["sourceReading"]))); source != nil {
			c := uploadObject(source["case"])
			result := uploadObject(source["result"])
			caseText := "方法来自的工作当前不可读。"
			if c["status"] == "available" {
				caseText = continuationLines("方法来自的工作", continuationText(c["title"]), continuationText(c["summary"]))
			}
			resultText := "原工作结果当前不可读，保持未知。"
			if result["status"] == "available" {
				label := continuationOutcomes[text(result["reportedOutcome"])]
				if label == "" {
					label = "原作者的结果说明"
				}
				resultText = continuationLines("原工作结果 · "+label, continuationText(result["summary"]), continuationText(result["limitations"]))
			}
			r.content = continuationJoin(r.content, caseText, resultText)
		}
		if _, ok := continuationNumber(d["version"], false); ok {
			r.notes = append(r.notes, "方法第 "+strconv.FormatInt(integer(d["version"]), 10)+" 版")
		}
		if data["deprecated"] == true {
			r.notes = append(r.notes, "这一版本已弃用。")
		}
		if data["securityIssue"] == true {
			r.notes = append(r.notes, "这一版本有尚未处理的安全问题。")
		}
		if license := continuationText(d["license"]); license != "" {
			r.notes = append(r.notes, "许可证："+license)
		}
		r.notes = append(r.notes, "阅读或下载不表示这次已成功复用。")
		r.until = data["availableUntil"]
		if r.until == nil {
			r.until = data["readExpiresAt"]
		}
		r.deadline = "temporarily-unavailable"
	case "room":
		if data["roomId"] != object["id"] {
			return bad()
		}
		r.title = continuationText(data["title"])
		if r.title == "" {
			r.title = "这段对话"
		}
		r.content = "已定位这段对话。请只按当前问题和已有对话授权取得所需消息；这次链接没有选择完整历史或附件。"
	default:
		return nil, nil
	}
	return r, nil
}
func continuationSourceData(object, data map[string]any) map[string]any {
	switch object["kind"] {
	case "task":
		out := continuationPick(data, "schemaVersion", "taskId", "caseId", "requesterId", "version", "state", "enrollmentOpen", "paused", "textView")
		request := uploadObject(data["request"])
		r := continuationPick(request, "title", "summary", "expectedOutcome", "intent", "visibility", "enrollmentExpiresAt")
		r["workContext"] = continuationPick(uploadObject(request["workContext"]), "goal", "currentSituation", "attemptRefs")
		out["request"] = r
		participants := []any{}
		for _, raw := range uploadRows(data["participations"]) {
			p := uploadObject(raw)
			value := continuationPick(p, "participationId", "subjectId", "state", "role", "scopeVersion", "scopeAvailable", "agreedScope")
			deliveries := []any{}
			for _, raw := range uploadRows(p["deliveries"]) {
				d := uploadObject(raw)
				v := continuationPick(d, "deliveryId", "summary", "resultRef", "interventionRefs", "evidenceRefs")
				v["acceptance"] = nil
				if d["acceptance"] != nil {
					v["acceptance"] = continuationPick(uploadObject(d["acceptance"]), "eventId", "summary")
				}
				deliveries = append(deliveries, v)
			}
			value["deliveries"] = deliveries
			participants = append(participants, value)
		}
		out["participations"] = participants
		return out
	case "person":
		out := continuationPick(data, "subjectId", "selfDeclaredSource", "selfDeclaredRevision", "selfDeclaredReadExpiresAt", "checkedAt")
		out["selfDeclared"] = continuationPick(uploadObject(data["selfDeclared"]), "displayName", "about", "claimedCapabilities", "projects")
		return out
	case "context":
		return continuationPick(data, "metadata", "state", "materials", "contextAccessGranted", "originalContentErased")
	case "post":
		return continuationPick(data, "locator", "payload", "availability", "topic", "createdAt", "versionCreatedAt", "publishedUntil", "readExpiresAt")
	case "project":
		return continuationPick(data, "projectId", "ownerId", "creatorId", "revision", "state", "visibility", "document", "source")
	case "capsule":
		out := continuationPick(data, "capsuleId", "versionId", "authorId", "version", "revision", "sourceStatus", "permissions", "attributions", "deprecated", "securityIssue", "notices", "newApplicationAllowed", "synthetic", "readingIsReuse")
		if data["sourceReading"] != nil {
			out["sourceReading"] = capsuleSourceReading(uploadObject(data["sourceReading"]))
		}
		return out
	case "room":
		return continuationPick(data, "roomId", "title", "kind", "state", "members", "taskRefs")
	}
	return nil
}
