package jstext

import (
	"bytes"
	"encoding/json"
	"errors"
)

// DecodeJSON preserves unpaired string code units in explicitly selected domain
// payloads. It does not alter shared protocol decoding or original signed text.
// Object order remains the caller's separate wire-projection responsibility.
func DecodeJSON(raw []byte) (any, error) {
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		return nil, errors.New("invalid JSON value")
	}
	switch raw[0] {
	case '"':
		return ValueJSON(raw)
	case '{':
		var fields map[string]json.RawMessage
		if e := json.Unmarshal(raw, &fields); e != nil {
			return nil, e
		}
		out := map[string]any{}
		for k, b := range fields {
			v, e := DecodeJSON(b)
			if e != nil {
				return nil, e
			}
			out[k] = v
		}
		return out, nil
	case '[':
		var fields []json.RawMessage
		if e := json.Unmarshal(raw, &fields); e != nil {
			return nil, e
		}
		out := []any{}
		for _, b := range fields {
			v, e := DecodeJSON(b)
			if e != nil {
				return nil, e
			}
			out = append(out, v)
		}
		return out, nil
	default:
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		if e := decoder.Decode(&value); e != nil {
			return nil, e
		}
		if n, ok := value.(json.Number); ok {
			f, e := n.Float64()
			if e != nil {
				return nil, e
			}
			if f == 0 {
				f = 0
			}
			return f, nil
		}
		return value, nil
	}
}
