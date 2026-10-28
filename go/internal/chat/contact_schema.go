package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func contactError() error { return fail("invalid_contact_request", 400) }
func functionTags(v any, nonempty bool) ([]any, bool) {
	values, ok := v.([]any)
	if !ok || len(values) > 16 || nonempty && len(values) == 0 {
		return nil, false
	}
	out := []any{}
	for _, v := range values {
		value, ok := v.(string)
		value = trim(value)
		if !ok || value == "" || textLength(value) > 80 {
			return nil, false
		}
		out = append(out, value)
	}
	return out, true
}
func parseContactContext(v any) (Object, bool) {
	c, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	switch str(c, "kind") {
	case "project":
		if !strict(c, "kind", "projectId") || !validID(str(c, "projectId")) {
			return nil, false
		}
	case "ephemeral":
		if !strict(c, "kind", "title", "functions", "technologies") {
			return nil, false
		}
		title, ok := c["title"].(string)
		title = trim(title)
		if !ok || title == "" || textLength(title) > 120 {
			return nil, false
		}
		c["title"] = title
		tags, ok := functionTags(c["functions"], true)
		if !ok {
			return nil, false
		}
		c["functions"] = tags
		if _, ok := c["technologies"]; !ok {
			c["technologies"] = []any{}
		}
		tags, ok = functionTags(c["technologies"], false)
		if !ok {
			return nil, false
		}
		c["technologies"] = tags
	default:
		return nil, false
	}
	return c, true
}
func parseOpportunityRef(v any) (Object, bool) {
	r, ok := v.(map[string]any)
	if !ok || !subjectPattern.MatchString(str(r, "subjectId")) || !validID(str(r, "projectId")) {
		return nil, false
	}
	switch str(r, "sourceKind") {
	case "":
		if !strict(r, "subjectId", "projectId", "statementId") || !validID(str(r, "statementId")) {
			return nil, false
		}
	case "project":
		if !strict(r, "sourceKind", "subjectId", "projectId", "documentEventId", "policyEventId") || !validID(str(r, "documentEventId")) || !validID(str(r, "policyEventId")) {
			return nil, false
		}
	case "recruitment":
		if !strict(r, "sourceKind", "subjectId", "projectId", "recruitmentId", "eventId") || !validID(str(r, "recruitmentId")) || !validID(str(r, "eventId")) {
			return nil, false
		}
	default:
		return nil, false
	}
	return r, true
}
func parseContactEvent(raw []byte) (Object, error) {
	var e Object
	if protocol.Decode(raw, &e) != nil || e == nil || !validID(str(e, "operationId")) || !validID(str(e, "contactId")) || !normalizeInteger(e, "expectedRevision", 0, 9007199254740991) {
		return nil, contactError()
	}
	if str(e, "kind") == "send" {
		if !strict(e, "operationId", "contactId", "expectedRevision", "kind", "recipientId", "purpose", "context", "opportunityRef", "note", "roomTitle") || !subjectPattern.MatchString(str(e, "recipientId")) || !has([]string{"conversation", "reuse", "collaboration", "recruitment"}, str(e, "purpose")) {
			return nil, contactError()
		}
		context, ok := parseContactContext(e["context"])
		if !ok {
			return nil, contactError()
		}
		e["context"] = context
		ref, ok := parseOpportunityRef(e["opportunityRef"])
		if !ok {
			return nil, contactError()
		}
		e["opportunityRef"] = ref
		if _, ok := e["roomTitle"]; !ok {
			e["roomTitle"] = "银河交流"
		}
		title, ok := e["roomTitle"].(string)
		title = trim(title)
		if !ok || title == "" || textLength(title) > 120 {
			return nil, contactError()
		}
		e["roomTitle"] = title
		note, ok := e["note"].(string)
		note = trim(note)
		if !ok || note == "" || textLength(note) > 2000 {
			return nil, contactError()
		}
		e["note"] = note
	} else {
		if !has([]string{"accept", "decline", "withdraw"}, str(e, "kind")) || !strict(e, "operationId", "contactId", "expectedRevision", "kind", "note") {
			return nil, contactError()
		}
		if _, ok := e["note"]; !ok {
			e["note"] = ""
		}
		note, ok := e["note"].(string)
		note = trim(note)
		if !ok || textLength(note) > 2000 {
			return nil, contactError()
		}
		e["note"] = note
	}
	return e, nil
}
func contactEnvelope(raw []byte) (Object, Object, error) {
	x, e := parse(raw, "consentId", "payloadJson")
	if e != nil || !validID(str(x, "consentId")) {
		return nil, nil, contactError()
	}
	text, ok := x["payloadJson"].(string)
	if !ok || textLength(text) < 2 || textLength(text) > 8000 || !json.Valid([]byte(text)) {
		return nil, nil, contactError()
	}
	event, e := parseContactEvent([]byte(text))
	return x, event, e
}
