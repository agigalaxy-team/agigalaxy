package hubs

import (
	"bytes"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sort"
)

// Peering fingerprints use JSON.stringify, including original nested order and
// isolated UTF-16 code units. Signed payload strings themselves remain intact.
func wireDecode(raw []byte) (any, error) {
	order, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	precise, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	var overlay func(any, any) any
	overlay = func(a, b any) any {
		if o, ok := a.(*protocol.OrderedObject); ok {
			out := protocol.NewOrderedObject()
			for _, k := range o.Keys() {
				out.Set(k, overlay(o.Values()[k], obj(b)[k]))
			}
			return out
		}
		if list, ok := a.([]any); ok {
			out := []any{}
			for i, v := range list {
				out = append(out, overlay(v, arr(b)[i]))
			}
			return out
		}
		return b
	}
	return overlay(order, precise), nil
}
func wireEncode(v any) ([]byte, error) {
	if text, ok := v.(jstext.String); ok {
		return text.MarshalJSON()
	}
	var keys []string
	var values Object
	switch o := v.(type) {
	case *protocol.OrderedObject:
		keys = o.Keys()
		values = o.Values()
	case Object:
		values = o
		for k := range o {
			keys = append(keys, k)
		}
		sort.Strings(keys)
	}
	if values != nil {
		var b bytes.Buffer
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			key, _ := protocol.EncodeJS(k)
			b.Write(key)
			b.WriteByte(':')
			raw, e := wireEncode(values[k])
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte('}')
		return b.Bytes(), nil
	}
	if list, ok := v.([]any); ok {
		if list == nil {
			return []byte("null"), nil
		}
		var b bytes.Buffer
		b.WriteByte('[')
		for i, item := range list {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, e := wireEncode(item)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	}
	return protocol.EncodeJS(v)
}
