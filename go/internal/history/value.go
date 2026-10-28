// Package history builds the existing on-demand authorized history projection.
// It writes no replacement history and infers no capability or work success.
package history

import (
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any

type ordered = protocol.OrderedObject

func newObject() *ordered                 { return protocol.NewOrderedObject() }
func orderedJSON(raw []byte) (any, error) { return protocol.DecodeOrdered(raw) }
func obj(v any) Object {
	switch x := v.(type) {
	case Object:
		return x
	case *ordered:
		if x != nil {
			return x.Values()
		}
	}
	return nil
}
func array(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []Object:
		out := []any{}
		for _, v := range x {
			out = append(out, v)
		}
		return out
	}
	return nil
}
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func num(o Object, k string) int64 {
	switch n := o[k].(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		v, _ := n.Int64()
		return v
	}
	return 0
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func copyField(to *ordered, name string, source Object, key string) {
	if v, ok := source[key]; ok {
		to.Set(name, v)
	}
}
func pick(v any, fields ...string) *ordered {
	o := newObject()
	allowed := map[string]bool{}
	for _, k := range fields {
		allowed[k] = true
	}
	if source, ok := v.(*ordered); ok {
		for _, k := range source.Keys() {
			if allowed[k] {
				o.Set(k, source.Values()[k])
			}
		}
		return o
	}
	for _, k := range fields {
		if v, ok := obj(v)[k]; ok {
			o.Set(k, v)
		}
	}
	return o
}
func canonicalValue(v any, dropChecked bool) any {
	if o := obj(v); o != nil {
		out := Object{}
		for k, v := range o {
			if dropChecked && k == "checkedAt" {
				continue
			}
			out[k] = canonicalValue(v, dropChecked)
		}
		return out
	}
	if a := array(v); a != nil {
		out := []any{}
		for _, v := range a {
			out = append(out, canonicalValue(v, dropChecked))
		}
		return out
	}
	return v
}
func contentHash(v any) (string, error) {
	raw, e := identity.Canonical(canonicalValue(v, true))
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
