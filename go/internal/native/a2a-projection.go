package native

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func a2aJSString(value any) string {
	if n, ok := value.(json.Number); ok {
		raw, e := protocol.EncodeJS(n)
		if e == nil {
			return string(raw)
		}
	}
	return remoteChatJSString(value)
}

// This is the selected 1.0 protobuf JSON projection used by the original SDK,
// before hashing. Unknown wire fields are not promoted into Galaxy material.
// Arbitrary metadata/data objects retain their received insertion order.
func a2aProjection(kind string, raw any) *protocol.OrderedObject {
	v := a2aObject(raw)
	out := protocol.NewOrderedObject()
	str := func(key, alias string, optional bool) {
		x := v[key]
		if x == nil && alias != "" {
			x = v[alias]
		}
		if x == nil {
			return
		}
		s := a2aJSString(x)
		if optional || s != "" {
			out.Set(key, s)
		}
	}
	object := func(key, kind string) {
		if v[key] != nil {
			out.Set(key, a2aProjection(kind, v[key]))
		}
	}
	rows := func(key, kind string) {
		items := uploadRows(v[key])
		if len(items) == 0 {
			return
		}
		values := []any{}
		for _, item := range items {
			values = append(values, a2aProjection(kind, item))
		}
		out.Set(key, values)
	}
	meta := func() {
		if a2aObject(v["metadata"]) != nil {
			out.Set("metadata", v["metadata"])
		}
	}
	stringsArray := func(key, alias string) {
		a, ok := v[key].([]any)
		if !ok {
			a, _ = v[alias].([]any)
		}
		if len(a) > 0 {
			values := []any{}
			for _, x := range a {
				if x == nil {
					values = append(values, "null")
				} else {
					values = append(values, a2aJSString(x))
				}
			}
			out.Set(key, values)
		}
	}
	switch kind {
	case "task":
		str("id", "", false)
		str("contextId", "context_id", false)
		object("status", "status")
		rows("artifacts", "artifact")
		rows("history", "message")
		meta()
	case "status":
		state := a2aEnum(v["state"], "TASK_STATE_", []string{"UNSPECIFIED", "SUBMITTED", "WORKING", "COMPLETED", "FAILED", "CANCELED", "INPUT_REQUIRED", "REJECTED", "AUTH_REQUIRED"})
		if state != "TASK_STATE_UNSPECIFIED" {
			out.Set("state", state)
		}
		object("message", "message")
		str("timestamp", "", true)
	case "message":
		str("messageId", "message_id", false)
		str("contextId", "context_id", false)
		str("taskId", "task_id", false)
		role := a2aEnum(v["role"], "ROLE_", []string{"UNSPECIFIED", "USER", "AGENT"})
		if role != "ROLE_UNSPECIFIED" {
			out.Set("role", role)
		}
		rows("parts", "part")
		meta()
		stringsArray("extensions", "")
		stringsArray("referenceTaskIds", "reference_task_ids")
	case "part":
		for _, key := range []string{"text", "raw", "url", "data"} {
			if v[key] == nil {
				continue
			}
			x := v[key]
			if key == "raw" {
				b := a2aBase64(a2aJSString(x))
				x = base64.StdEncoding.EncodeToString(b)
			} else if key != "data" {
				x = a2aJSString(x)
			}
			out.Set(key, x)
			break
		}
		meta()
		str("filename", "", false)
		str("mediaType", "media_type", false)
	case "artifact":
		str("artifactId", "artifact_id", false)
		str("name", "", false)
		str("description", "", false)
		rows("parts", "part")
		meta()
		stringsArray("extensions", "")
	}
	return out
}
func a2aEnum(raw any, prefix string, names []string) string {
	if raw == nil {
		return prefix + names[0]
	}
	if n, ok := a2aSafeInteger(raw); ok && n >= 0 && n < int64(len(names)) {
		return prefix + names[n]
	}
	for _, name := range names {
		if s, ok := raw.(string); ok && s == prefix+name {
			return s
		}
	}
	return "UNRECOGNIZED"
}
func a2aBase64(s string) []byte {
	// Buffer.from(base64) accepts URL alphabet, whitespace, omitted padding,
	// and stops at the first '='. Keep the SDK's forgiving byte conversion.
	if i := strings.IndexByte(s, '='); i >= 0 {
		s = s[:i]
	}
	s = strings.Map(func(r rune) rune {
		if r == '-' {
			return '+'
		}
		if r == '_' {
			return '/'
		}
		if r > 127 || !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", r) {
			return -1
		}
		return r
	}, s)
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	b, _ := base64.RawStdEncoding.DecodeString(s)
	return b
}
func a2aSlice(value string, count int) any {
	units := utf16.Encode([]rune(value))
	if len(units) > count {
		units = units[:count]
	}
	if len(units) > 0 && units[len(units)-1] >= 0xd800 && units[len(units)-1] <= 0xdbff {
		return a2aSurrogateTail(string(utf16.Decode(units[:len(units)-1])), units[len(units)-1])
	}
	return string(utf16.Decode(units))
}
func a2aIdentifier(s string) bool {
	n := len(utf16.Encode([]rune(s)))
	if n < 1 || n > 512 {
		return false
	}
	for _, r := range s {
		if unicode.Is(unicode.Cc, r) {
			return false
		}
	}
	return true
}
func a2aTerminal(state string) bool {
	return state == "completed" || state == "failed" || state == "canceled" || state == "rejected"
}
func a2aText(parts any) any {
	texts := []string{}
	for _, raw := range uploadRows(parts) {
		p := a2aObject(raw)
		if p["text"] != nil {
			texts = append(texts, text(p["text"]))
		}
	}
	return a2aSlice(strings.Join(texts, "\n"), 1200)
}
func a2aSnapshot(raw any, previous map[string]any) (map[string]any, error) {
	v := a2aObject(raw)
	_, isTask := v["id"]
	kind := "message"
	if isTask {
		kind = "task"
	}
	wire := a2aProjection(kind, raw)
	encoded, e := protocol.EncodeJS(wire)
	if e != nil || len(encoded) > 1048576 {
		return nil, a2aError("response exceeds profile limit")
	}
	v = wire.Values()
	context := text(v["contextId"])
	if !a2aIdentifier(context) || text(previous["contextId"]) != "" && text(previous["contextId"]) != context {
		return nil, a2aError("peer context changed or invalid")
	}
	if !isTask {
		if text(previous["taskId"]) != "" || !a2aIdentifier(text(v["messageId"])) || text(v["taskId"]) != "" {
			return nil, a2aError("unexpected standalone peer message")
		}
		return map[string]any{"kind": "message", "contextId": context, "messageId": v["messageId"], "state": "message-only", "responseHash": a2aHash(encoded), "artifacts": []any{}, "verification": "peer-reported", "text": a2aText(v["parts"])}, nil
	}
	states := map[string]string{"TASK_STATE_SUBMITTED": "submitted", "TASK_STATE_WORKING": "working", "TASK_STATE_COMPLETED": "completed", "TASK_STATE_FAILED": "failed", "TASK_STATE_CANCELED": "canceled", "TASK_STATE_INPUT_REQUIRED": "input-required", "TASK_STATE_REJECTED": "rejected", "TASK_STATE_AUTH_REQUIRED": "auth-required"}
	status := a2aObject(v["status"])
	state := states[text(status["state"])]
	id := text(v["id"])
	if !a2aIdentifier(id) || state == "" || text(previous["taskId"]) != "" && text(previous["taskId"]) != id || a2aTerminal(text(previous["state"])) && previous["state"] != state {
		return nil, a2aError("peer task/state changed or invalid")
	}
	items := uploadRows(v["artifacts"])
	if len(items) > 64 {
		return nil, a2aError("too many artifacts")
	}
	artifacts := []any{}
	seen := map[string]bool{}
	for _, item := range items {
		a := a2aObject(item)
		aid := text(a["artifactId"])
		parts := uploadRows(a["parts"])
		if !a2aIdentifier(aid) || seen[aid] || len(parts) > 64 {
			return nil, a2aError("invalid artifact")
		}
		seen[aid] = true
		raw, _ := protocol.EncodeJS(item)
		projections := []any{}
		for _, item := range parts {
			p := a2aObject(item)
			partKind := ""
			var data []byte
			for _, key := range []string{"text", "raw", "url", "data"} {
				if p[key] != nil {
					partKind = key
					if key == "raw" {
						data = a2aBase64(text(p[key]))
					} else if s, ok := p[key].(string); ok {
						data = []byte(s)
					} else {
						data, _ = protocol.EncodeJS(p[key])
					}
					break
				}
			}
			if partKind == "" {
				return nil, a2aError("unsupported artifact part")
			}
			projection := map[string]any{"kind": partKind, "mediaType": a2aSlice(text(p["mediaType"]), 160), "bytes": len(data), "sha256": a2aHash(data)}
			if partKind == "text" {
				projection["text"] = a2aSlice(text(p["text"]), 1200)
			}
			if partKind == "url" {
				projection["referenceHash"] = a2aHash([]byte(text(p["url"])))
				projection["downloaded"] = false
			}
			projections = append(projections, projection)
		}
		artifacts = append(artifacts, map[string]any{"artifactId": aid, "name": a2aSlice(text(a["name"]), 160), "objectHash": a2aHash(raw), "parts": projections})
	}
	return map[string]any{"kind": "task", "taskId": id, "contextId": context, "state": state, "responseHash": a2aHash(encoded), "artifacts": artifacts, "verification": "peer-reported", "text": a2aText(a2aObject(status["message"])["parts"])}, nil
}
