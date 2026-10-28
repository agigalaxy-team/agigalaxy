package jstext

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// String retains JavaScript UTF-16 code units, including unpaired surrogates.
// Callers retain their own validation, JSON object order and signature semantics.
type String []uint16

func (s String) MarshalJSON() ([]byte, error) {
	out := []byte{'"'}
	for i := 0; i < len(s); i++ {
		v := s[i]
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
				if v >= 0xd800 && v <= 0xdbff && i+1 < len(s) && s[i+1] >= 0xdc00 && s[i+1] <= 0xdfff {
					out = utf8.AppendRune(out, utf16.DecodeRune(rune(v), rune(s[i+1])))
					i++
				} else {
					out = append(out, fmt.Sprintf(`\u%04x`, v)...)
				}
			} else {
				out = utf8.AppendRune(out, rune(v))
			}
		}
	}
	return append(out, '"'), nil
}
func ParseJSON(raw []byte) (String, error) {
	if !json.Valid(raw) || len(raw) < 2 || raw[0] != '"' {
		return nil, errors.New("invalid JavaScript JSON string")
	}
	out := String{}
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
	return out, nil
}
func IsSpace(v uint16) bool {
	return v >= 9 && v <= 13 || v == 32 || v == 0xa0 || v == 0x1680 || v >= 0x2000 && v <= 0x200a || v == 0x2028 || v == 0x2029 || v == 0x202f || v == 0x205f || v == 0x3000 || v == 0xfeff
}
func (s String) Trim() String {
	left, right := 0, len(s)
	for left < right && IsSpace(s[left]) {
		left++
	}
	for right > left && IsSpace(s[right-1]) {
		right--
	}
	return s[left:right]
}
func (s String) Decoded() string { return string(utf16.Decode(s)) }

func From(value string) String { return String(utf16.Encode([]rune(value))) }
func (s String) CodePointLen() int {
	n := len(s)
	for i := 0; i+1 < len(s); i++ {
		if s[i] >= 0xd800 && s[i] <= 0xdbff && s[i+1] >= 0xdc00 && s[i+1] <= 0xdfff {
			n--
			i++
		}
	}
	return n
}
func (s String) HasUnpaired() bool {
	for i := 0; i < len(s); i++ {
		v := s[i]
		if v >= 0xd800 && v <= 0xdbff {
			if i+1 >= len(s) || s[i+1] < 0xdc00 || s[i+1] > 0xdfff {
				return true
			}
			i++
		} else if v >= 0xdc00 && v <= 0xdfff {
			return true
		}
	}
	return false
}

// ValueJSON keeps ordinary strings ordinary and preserves values that Go's
// UTF-8 conversion would replace. It has no object or domain authority.
func ValueJSON(raw []byte) (any, error) {
	s, e := ParseJSON(raw)
	if e != nil {
		return nil, e
	}
	if s.HasUnpaired() {
		return s, nil
	}
	return s.Decoded(), nil
}
