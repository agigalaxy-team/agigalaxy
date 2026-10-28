package community

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// The original governance digest is sorted JSON.stringify, including its
// handling of UTF-16 strings. It is not a digest of Go struct field order.
type governanceString []uint16

func (s governanceString) MarshalJSON() ([]byte, error) { return quoteUnits(s), nil }
func quoteUnits(units []uint16) []byte {
	out := []byte{'"'}
	for i := 0; i < len(units); i++ {
		v := units[i]
		switch v {
		case '"', '\\':
			out = append(out, '\\', byte(v))
		case 8:
			out = append(out, '\\', 'b')
		case 9:
			out = append(out, '\\', 't')
		case 10:
			out = append(out, '\\', 'n')
		case 12:
			out = append(out, '\\', 'f')
		case 13:
			out = append(out, '\\', 'r')
		default:
			if v < 32 || v >= 0xd800 && v <= 0xdfff {
				if v >= 0xd800 && v <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
					out = utf8.AppendRune(out, utf16.DecodeRune(rune(v), rune(units[i+1])))
					i++
				} else {
					out = append(out, fmt.Sprintf(`\u%04x`, v)...)
				}
			} else {
				out = utf8.AppendRune(out, rune(v))
			}
		}
	}
	return append(out, '"')
}
func decodeUnits(raw []byte) governanceString {
	out := governanceString{}
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] == '\\' {
			i++
			switch raw[i] {
			case 'u':
				v, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
				out = append(out, uint16(v))
				i += 4
			case 'b':
				out = append(out, 8)
			case 'f':
				out = append(out, 12)
			case 'n':
				out = append(out, 10)
			case 'r':
				out = append(out, 13)
			case 't':
				out = append(out, 9)
			default:
				out = append(out, uint16(raw[i]))
			}
		} else {
			r, n := utf8.DecodeRune(raw[i:])
			out = append(out, utf16.Encode([]rune{r})...)
			i += n - 1
		}
	}
	return out
}
func governanceJSON(raw []byte) (any, error) {
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		return nil, fmt.Errorf("invalid governance JSON")
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("invalid governance JSON")
	}
	switch raw[0] {
	case '{':
		var m map[string]json.RawMessage
		if e := json.Unmarshal(raw, &m); e != nil {
			return nil, e
		}
		o := Object{}
		for k, v := range m {
			parsed, e := governanceJSON(v)
			if e != nil {
				return nil, e
			}
			o[k] = parsed
		}
		return o, nil
	case '[':
		var a []json.RawMessage
		_ = json.Unmarshal(raw, &a)
		out := []any{}
		for _, v := range a {
			parsed, e := governanceJSON(v)
			if e != nil {
				return nil, e
			}
			out = append(out, parsed)
		}
		return out, nil
	case '"':
		if !validTextBytes(raw) {
			return decodeUnits(raw), nil
		}
		var s string
		_ = json.Unmarshal(raw, &s)
		return s, nil
	default:
		var v any
		if e := json.Unmarshal(raw, &v); e != nil {
			return nil, e
		}
		return v, nil
	}
}
func governanceBytes(value any) ([]byte, error) {
	var out bytes.Buffer
	var write func(any) error
	write = func(v any) error {
		switch x := v.(type) {
		case nil:
			out.WriteString("null")
		case string:
			out.Write(quoteUnits(utf16.Encode([]rune(x))))
		case governanceString:
			out.Write(quoteUnits(x))
		case bool:
			out.WriteString(strconv.FormatBool(x))
		case int:
			out.WriteString(strconv.Itoa(x))
		case int64:
			out.WriteString(strconv.FormatInt(x, 10))
		case float64:
			if x == 0 {
				out.WriteByte('0')
			} else {
				out.WriteString(strconv.FormatFloat(x, 'f', -1, 64))
			}
		case map[string]any:
			keys := []string{}
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				out.Write(quoteUnits(utf16.Encode([]rune(k))))
				out.WriteByte(':')
				if e := write(x[k]); e != nil {
					return e
				}
			}
			out.WriteByte('}')
		case []any:
			out.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					out.WriteByte(',')
				}
				if e := write(item); e != nil {
					return e
				}
			}
			out.WriteByte(']')
		case []string:
			a := []any{}
			for _, s := range x {
				a = append(a, s)
			}
			return write(a)
		case []Object:
			a := []any{}
			for _, o := range x {
				a = append(a, o)
			}
			return write(a)
		default:
			return fmt.Errorf("invalid governance JSON type")
		}
		return nil
	}
	if e := write(value); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}
