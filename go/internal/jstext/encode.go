package jstext

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sort"
)

// EncodeJSON retains JavaScript string code units in the caller's own JSON
// projection. OrderedObject carries source member order; ordinary maps have
// deterministic keys. Shared protocol decoding and signed bytes are unchanged.
func EncodeJSON(value any) ([]byte, error) {
	switch v := value.(type) {
	case String:
		return v.MarshalJSON()
	case string:
		return From(v).MarshalJSON()
	case *protocol.OrderedObject:
		if v == nil {
			return []byte("null"), nil
		}
		return encodeObject(v.Keys(), v.Values())
	case map[string]any:
		if v == nil {
			return []byte("null"), nil
		}
		keys := []string{}
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		order := protocol.NewOrderedObject()
		for _, k := range keys {
			order.Set(k, v[k])
		}
		return encodeObject(order.Keys(), v)
	case []any:
		if v == nil {
			return []byte("null"), nil
		}
		var b bytes.Buffer
		b.WriteByte('[')
		for i, v := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, e := EncodeJSON(v)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	}
	if v, ok := value.(json.Marshaler); ok {
		raw, e := v.MarshalJSON()
		if e != nil {
			return nil, e
		}
		if len(raw) > 0 && raw[0] == '"' {
			s, e := ParseJSON(raw)
			if e != nil {
				return nil, e
			}
			return s.MarshalJSON()
		}
	}
	return protocol.EncodeJS(value)
}
func encodeObject(keys []string, values map[string]any) ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, e := From(k).MarshalJSON()
		if e != nil {
			return nil, e
		}
		b.Write(key)
		b.WriteByte(':')
		raw, e := EncodeJSON(values[k])
		if e != nil {
			return nil, e
		}
		b.Write(raw)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
