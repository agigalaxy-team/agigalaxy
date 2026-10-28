package taskmaterials

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
)

// Keep Comment's original type and errors; only JSON/code-unit operations are shared.
type jsText jstext.String

func jsUnitSpace(v uint16) bool { return jstext.IsSpace(v) }

func (s jsText) MarshalJSON() ([]byte, error) { return jstext.String(s).MarshalJSON() }
func parseJSText(raw []byte) (jsText, error) {
	v, e := jstext.ParseJSON(raw)
	if e != nil {
		return nil, fail("invalid_comment_payload", 400)
	}
	return jsText(v), nil
}
func (s jsText) trim() jsText                       { return jsText(jstext.String(s).Trim()) }
func (s jsText) decoded() string                    { return jstext.String(s).Decoded() }
func rawCommentBody(payload string) (jsText, error) { return rawCommentText(payload, "body", 6000) }
func rawCommentText(payload, key string, maximum int) (jsText, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(payload), &fields) != nil {
		return nil, fail("invalid_comment_payload", 400)
	}
	body, e := parseJSText(fields[key])
	if e != nil {
		return nil, e
	}
	body = body.trim()
	if jstext.String(body).CodePointLen() < 1 || jstext.String(body).CodePointLen() > maximum {
		return nil, fail("invalid_comment_payload", 400)
	}
	return body, nil
}
