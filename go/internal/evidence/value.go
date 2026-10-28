package evidence

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
	"regexp"
)

type Object = map[string]any

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func obj(v any) Object {
	switch v := v.(type) {
	case Object:
		return v
	case *protocol.OrderedObject:
		return v.Values()
	}
	return nil
}
func str(o Object, k string) string { s, _ := o[k].(string); return s }
func num(o Object, k string) int64 {
	switch n := o[k].(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func safe(o Object, k string, min, max int64) bool {
	var f float64
	switch n := o[k].(type) {
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return false
		}
	case float64:
		f = n
	case int64:
		f = float64(n)
	case int:
		f = float64(n)
	default:
		return false
	}
	return !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= float64(max)
}
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	all := map[string]bool{}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
		all[k] = true
	}
	for _, k := range optional {
		all[k] = true
	}
	for k := range o {
		if !all[k] {
			return false
		}
	}
	return true
}
func one(v any, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
func arr(v any) []any     { v1, _ := v.([]any); return v1 }
func encode(v any) []byte { raw, _ := protocol.EncodeJS(v); return raw }
func ordered(fields ...any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for i := 0; i < len(fields); i += 2 {
		o.Set(fields[i].(string), fields[i+1])
	}
	return o
}
