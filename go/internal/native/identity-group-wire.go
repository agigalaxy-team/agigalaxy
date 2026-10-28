package native

import (
	"bytes"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"sort"
)

func groupOrderedSource(v map[string]any) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, k := range []string{"kind", "id", "version", "caseId", "taskId", "sourceHash", "originalSubjectId"} {
		if x, ok := v[k]; ok {
			out.Set(k, x)
		}
	}
	return out
}

func groupClone(v map[string]any) map[string]any {
	raw, e := groupWire(v)
	if e != nil {
		return nil
	}
	out, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil
	}
	return uploadObject(out)
}

// Only newly constructed intents use this writer. Previously signed payload
// strings are retained verbatim, including their whitespace and field order.
func groupWire(value any) ([]byte, error) {
	if s, ok := value.(jstext.String); ok {
		return s.MarshalJSON()
	}
	var keys []string
	var values map[string]any
	switch v := value.(type) {
	case *protocol.OrderedObject:
		keys = v.Keys()
		values = v.Values()
	case map[string]any:
		values = v
		for k := range v {
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
			raw, e := protocol.EncodeJS(k)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
			b.WriteByte(':')
			raw, e = groupWire(values[k])
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte('}')
		return b.Bytes(), nil
	}
	if list, ok := value.([]any); ok {
		if list == nil {
			return []byte("null"), nil
		}
		var b bytes.Buffer
		b.WriteByte('[')
		for i, v := range list {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, e := groupWire(v)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	}
	return protocol.EncodeJS(value)
}
