package chat

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

// Original Zod string min/max uses code points, independently of JS.length.
func textLength(s string) int { return utf8.RuneCountInString(s) }

func strict(x Object, keys ...string) bool {
	allowed := map[string]bool{}
	for _, key := range keys {
		allowed[key] = true
	}
	for key := range x {
		if !allowed[key] {
			return false
		}
	}
	return true
}
func parse(raw []byte, keys ...string) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil || !strict(x, keys...) {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}
func integer(v any, min, max int64) (int64, bool) {
	var n float64
	switch v := v.(type) {
	case json.Number:
		var e error
		n, e = v.Float64()
		if e != nil {
			return 0, false
		}
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	default:
		return 0, false
	}
	return int64(n), !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
}
func normalizeInteger(x Object, key string, min, max int64) bool {
	n, ok := integer(x[key], min, max)
	if ok {
		x[key] = n
	}
	return ok
}
func parseCreate(raw []byte) (Object, error) {
	x, e := parse(raw, "roomId", "operationId", "title", "kind", "parentRoomId", "taskRefs", "retentionDays")
	if e != nil {
		return nil, e
	}
	title, ok := x["title"].(string)
	title = trim(title)
	if !ok || title == "" || textLength(title) > 120 || !validID(str(x, "roomId")) || !validID(str(x, "operationId")) {
		return nil, fail("invalid_chat_request", 400)
	}
	x["title"] = title
	if _, ok = x["kind"]; !ok {
		x["kind"] = "ordinary"
	}
	if str(x, "kind") != "ordinary" && str(x, "kind") != "ai-subzone" {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["parentRoomId"]; present && !validID(asString(v)) {
		return nil, fail("invalid_chat_request", 400)
	}
	if _, ok = x["taskRefs"]; !ok {
		x["taskRefs"] = []any{}
	}
	tasks, ok := x["taskRefs"].([]any)
	if !ok || len(tasks) > 20 {
		return nil, fail("invalid_chat_request", 400)
	}
	for _, id := range tasks {
		if !validID(asString(id)) {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if _, ok = x["retentionDays"]; !ok {
		x["retentionDays"] = int64(90)
	}
	if !normalizeInteger(x, "retentionDays", 7, 90) || num(x, "retentionDays") != 7 && num(x, "retentionDays") != 30 && num(x, "retentionDays") != 90 {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}
func parsePage(raw []byte, keys ...string) (Object, error) {
	x, e := loose(raw)
	if e != nil {
		return nil, e
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(50)
	}
	if !normalizeInteger(x, "limit", 1, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, ok := x["after"]; ok {
		if _, ok = v.(string); !ok {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	return x, nil
}

// Original destructured operation inputs ignore unrelated properties; strict
// Zod inputs above continue to reject them.
func loose(raw []byte) (Object, error) {
	var x Object
	if protocol.Decode(raw, &x) != nil || x == nil {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}
func parseSend(raw []byte) (Object, error) {
	x, e := parse(raw, "clientMessageId", "text", "replyTo", "agentGrantId", "attachments")
	if e != nil {
		return nil, e
	}
	text, ok := x["text"].(string)
	if !ok || textLength(text) > 16000 || !validID(str(x, "clientMessageId")) {
		return nil, fail("invalid_chat_request", 400)
	}
	if _, ok = x["replyTo"]; !ok {
		x["replyTo"] = nil
	}
	if x["replyTo"] != nil && !validID(str(x, "replyTo")) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["agentGrantId"]; present && !validID(asString(v)) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["attachments"]; present {
		a, ok := v.([]any)
		if !ok || len(a) < 1 || len(a) > 16 {
			return nil, fail("invalid_chat_request", 400)
		}
		for _, ref := range a {
			r, ok := ref.(map[string]any)
			if !ok || !strict(r, "id", "sha256") || !validID(str(r, "id")) || !hashPattern.MatchString(str(r, "sha256")) {
				return nil, fail("invalid_chat_request", 400)
			}
		}
	} else if trim(text) == "" {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var digits = regexp.MustCompile(`^[0-9]+$`)

func parseHistory(raw []byte) (Object, error) {
	x, e := parse(raw, "after", "limit", "keyword", "author", "from", "to", "agentGrantId", "latest", "before")
	if e != nil {
		return nil, e
	}
	if _, ok := x["after"]; !ok {
		x["after"] = "0"
	}
	if !digits.MatchString(str(x, "after")) {
		return nil, fail("invalid_chat_request", 400)
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = int64(50)
	}
	if v, ok := x["limit"].(string); ok {
		n, e := strconv.ParseFloat(v, 64)
		if e != nil {
			return nil, fail("invalid_chat_request", 400)
		}
		x["limit"] = n
	}
	if !normalizeInteger(x, "limit", 1, 100) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["keyword"]; present {
		value, ok := v.(string)
		if !ok || textLength(value) > 100 {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if v, present := x["author"]; present && !subjectPattern.MatchString(asString(v)) && !accountPattern.MatchString(asString(v)) {
		return nil, fail("invalid_chat_request", 400)
	}
	for _, key := range []string{"from", "to"} {
		if v, present := x[key]; present {
			value, ok := v.(string)
			if !ok || !datetime.MatchString(value) {
				return nil, fail("invalid_chat_request", 400)
			}
			if _, e := time.Parse(time.RFC3339Nano, value); e != nil {
				return nil, fail("invalid_chat_request", 400)
			}
		}
	}
	if v, present := x["agentGrantId"]; present && !validID(asString(v)) {
		return nil, fail("invalid_chat_request", 400)
	}
	if v, present := x["latest"]; present {
		if _, ok := v.(bool); !ok {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if v, present := x["before"]; present {
		if !positiveDigits.MatchString(asString(v)) || !truth(x, "latest") {
			return nil, fail("invalid_chat_request", 400)
		}
	}
	if truth(x, "latest") && str(x, "after") != "0" {
		return nil, fail("invalid_chat_request", 400)
	}
	return x, nil
}

var datetime = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`)
var positiveDigits = regexp.MustCompile(`^[1-9][0-9]*$`)
