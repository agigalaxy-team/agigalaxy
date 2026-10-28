package watchcontrol

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Object = map[string]any

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func obj(v any) Object {
	if o, ok := v.(Object); ok {
		return o
	}
	if o, ok := v.(*protocol.OrderedObject); ok {
		return o.Values()
	}
	return nil
}
func text(o Object, k string) string { s, _ := o[k].(string); return s }
func number(o Object, k string) int64 {
	switch v := o[k].(type) {
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Float64()
		return int64(n)
	}
	return 0
}
func integer(v any, min, max int64) bool {
	var n float64
	switch v := v.(type) {
	case int:
		n = float64(v)
	case int32:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		var e error
		n, e = v.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max)
}
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == 0xFEFF || r == 0xA0 || r == 0x1680 || r >= 0x2000 && r <= 0x200A || r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f'
	})
}
func encode(v any) []byte {
	b, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return b
}
func parse(raw []byte, kind string) (*protocol.OrderedObject, error) {
	input, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, fault.New("invalid_watch_control_request", 400)
	}
	o := obj(input)
	if o == nil {
		return nil, fault.New("invalid_watch_control_request", 400)
	}
	keys, optional := []string{}, map[string]bool{}
	switch kind {
	case "register":
		keys = []string{"operationId", "watchId", "roomId", "agentGrantId", "purpose", "expiresAt", "taskId"}
		optional["taskId"] = true
	case "takeover":
		keys = []string{"operationId", "watchId", "expectedRevision", "expectedGrantId", "targetBindingId", "newGrantId"}
	case "stop":
		keys = []string{"operationId", "watchId", "expectedRevision", "expectedGrantId"}
	case "read":
		keys = []string{"watchId"}
	case "receipt":
		keys = []string{"operationId", "requestHash"}
	case "query":
		keys = []string{"after", "limit"}
		optional["after"] = true
		optional["limit"] = true
	default:
		return nil, fault.New("invalid_watch_control_request", 400)
	}
	allowed := map[string]bool{}
	out := protocol.NewOrderedObject()
	for _, k := range keys {
		allowed[k] = true
		v, present := o[k]
		if !present {
			if !optional[k] {
				return nil, fault.New("invalid_watch_control_request", 400)
			}
			if kind == "query" {
				if k == "after" {
					out.Set(k, nil)
				} else {
					out.Set(k, int64(20))
				}
			}
			continue
		}
		valid := false
		switch k {
		case "purpose":
			s, ok := v.(string)
			if ok {
				s = trim(s)
				v = s
				valid = utf8.RuneCountInString(s) >= 1 && utf8.RuneCountInString(s) <= 500
			}
		case "expiresAt", "expectedRevision":
			valid = integer(v, 1, 9007199254740991)
			if valid {
				v = number(Object{k: v}, k)
			}
		case "limit":
			valid = integer(v, 1, 50)
			if valid {
				v = number(Object{k: v}, k)
			}
		case "requestHash":
			valid = hashPattern.MatchString(text(o, k))
		default:
			valid = uuidPattern.MatchString(text(o, k)) || k == "after" && v == nil
		}
		if !valid {
			return nil, fault.New("invalid_watch_control_request", 400)
		}
		out.Set(k, v)
	}
	for k := range o {
		if !allowed[k] {
			return nil, fault.New("invalid_watch_control_request", 400)
		}
	}
	return out, nil
}
