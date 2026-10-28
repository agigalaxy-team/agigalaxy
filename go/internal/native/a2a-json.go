package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// JS slice can deliberately end in one UTF-16 code unit. Preserve that JSON
// string in this private domain instead of replacing it with U+FFFD. These
// strings are peer display projections, never identity/signature material.
type a2aRawString struct{ raw []byte }

func (s a2aRawString) MarshalJSON() ([]byte, error) { return append([]byte{}, s.raw...), nil }
func a2aLoneEscape(raw []byte) bool {
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		if i+1 >= len(raw) {
			break
		}
		if raw[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(raw) {
			break
		}
		n, e := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if e != nil {
			continue
		}
		if n >= 0xdc00 && n <= 0xdfff {
			return true
		}
		if n >= 0xd800 && n <= 0xdbff {
			if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
				return true
			}
			next, e := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
			if e != nil || next < 0xdc00 || next > 0xdfff {
				return true
			}
			i += 6
		}
		i += 5
	}
	return false
}
func a2aDecodeJSON(raw []byte) (any, error) {
	raw = bytes.TrimSpace(bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf}))
	if !json.Valid(raw) {
		return nil, a2aError("invalid journal JSON")
	}
	if len(raw) > 0 && raw[0] == '{' {
		var parts map[string]json.RawMessage
		if e := json.Unmarshal(raw, &parts); e != nil {
			return nil, e
		}
		out := map[string]any{}
		for k, b := range parts {
			v, e := a2aDecodeJSON(b)
			if e != nil {
				return nil, e
			}
			out[k] = v
		}
		return out, nil
	}
	if len(raw) > 0 && raw[0] == '[' {
		var parts []json.RawMessage
		_ = json.Unmarshal(raw, &parts)
		out := []any{}
		for _, b := range parts {
			v, e := a2aDecodeJSON(b)
			if e != nil {
				return nil, e
			}
			out = append(out, v)
		}
		return out, nil
	}
	if len(raw) > 0 && raw[0] == '"' && a2aLoneEscape(raw) {
		return a2aRawString{append([]byte{}, raw...)}, nil
	}
	var value any
	e := protocol.Decode(raw, &value)
	return value, e
}
func a2aEncodeJSON(value any) ([]byte, error) {
	switch v := value.(type) {
	case a2aRawString:
		return v.MarshalJSON()
	case map[string]any:
		keys := []string{}
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var b bytes.Buffer
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			key, _ := protocol.EncodeJS(k)
			b.Write(key)
			b.WriteByte(':')
			raw, e := a2aEncodeJSON(v[k])
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte('}')
		return b.Bytes(), nil
	case []any:
		var b bytes.Buffer
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, e := a2aEncodeJSON(item)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	default:
		return protocol.EncodeJS(value)
	}
}
func a2aClone(value map[string]any) map[string]any {
	raw, e := a2aEncodeJSON(value)
	if e != nil {
		return nil
	}
	v, e := a2aDecodeJSON(raw)
	if e != nil {
		return nil
	}
	return uploadObject(v)
}
func a2aSurrogateTail(prefix string, high uint16) a2aRawString {
	raw, _ := protocol.EncodeJS(prefix)
	return a2aRawString{[]byte(fmt.Sprintf("%s\\u%04x\"", raw[:len(raw)-1], high))}
}
