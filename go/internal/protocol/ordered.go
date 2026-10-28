package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

// OrderedObject carries the insertion order of a JSON.parse/object-built wire
// projection. Signed original strings remain strings: this is not a replacement
// for the exact payload bytes or for the separate canonical signing protocol.
type OrderedObject struct {
	keys   []string
	values map[string]any
}

func NewOrderedObject() *OrderedObject { return &OrderedObject{values: map[string]any{}} }
func (o *OrderedObject) Set(k string, v any) {
	if o.values == nil {
		o.values = map[string]any{}
	}
	if _, ok := o.values[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.values[k] = v
}

// Delete has JavaScript delete's ordering behavior: a later Set appends a new
// property instead of reviving its old position.
func (o *OrderedObject) Delete(k string) {
	if o == nil {
		return
	}
	delete(o.values, k)
	for i, key := range o.keys {
		if key == k {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			return
		}
	}
}

// Values is a read-only map view. Mutations must use Set to retain key order.
func (o *OrderedObject) Values() map[string]any {
	if o == nil {
		return nil
	}
	return o.values
}
func (o *OrderedObject) Keys() []string {
	if o == nil {
		return nil
	}
	indices := []uint64{}
	rest := []string{}
	for _, k := range o.keys {
		n, e := strconv.ParseUint(k, 10, 32)
		if e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == k {
			indices = append(indices, n)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(indices, func(i, j int) bool { return indices[i] < indices[j] })
	out := []string{}
	for _, n := range indices {
		out = append(out, strconv.FormatUint(n, 10))
	}
	return append(out, rest...)
}
func (o *OrderedObject) MarshalJSON() ([]byte, error) { return EncodeJS(o) }

// DecodeOrdered retains JSON object member order and number lexemes. As with
// Decode, ordinary JSON objects/arrays/scalars are accepted, without executing
// any data as code or manufacturing a domain-specific projection.
func DecodeOrdered(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var read func() (any, error)
	read = func() (any, error) {
		t, e := d.Token()
		if e != nil {
			return nil, e
		}
		switch t {
		case json.Delim('{'):
			o := NewOrderedObject()
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return nil, e
				}
				v, e := read()
				if e != nil {
					return nil, e
				}
				o.Set(k.(string), v)
			}
			_, e = d.Token()
			return o, e
		case json.Delim('['):
			out := []any{}
			for d.More() {
				v, e := read()
				if e != nil {
					return nil, e
				}
				out = append(out, v)
			}
			_, e = d.Token()
			return out, e
		}
		return t, nil
	}
	v, e := read()
	if e != nil {
		return nil, e
	}
	if _, e = d.Token(); e != io.EOF {
		return nil, fmt.Errorf("ordered JSON trailing data")
	}
	return v, nil
}

// EncodeJS matches JSON.stringify's numeric and string representation for the
// stored valid-Unicode JSON domain. Use OrderedObject when member insertion
// order matters; Go maps have no insertion order and use the encoder's order.
func EncodeJS(value any) ([]byte, error) {
	switch v := value.(type) {
	case *OrderedObject:
		if v == nil {
			return []byte("null"), nil
		}
		var b bytes.Buffer
		b.WriteByte('{')
		for i, k := range v.Keys() {
			if i > 0 {
				b.WriteByte(',')
			}
			key, e := EncodeJS(k)
			if e != nil {
				return nil, e
			}
			b.Write(key)
			b.WriteByte(':')
			raw, e := EncodeJS(v.values[k])
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte('}')
		return b.Bytes(), nil
	case []any:
		if v == nil {
			return []byte("null"), nil
		}
		var b bytes.Buffer
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			raw, e := EncodeJS(item)
			if e != nil {
				return nil, e
			}
			b.Write(raw)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	case json.Number:
		if n, _ := strconv.ParseFloat(v.String(), 64); math.IsInf(n, 0) && json.Valid([]byte(v.String())) {
			return []byte("null"), nil
		}
		// The mature JCS implementation accepts containers, so normalize one
		// Number inside an array and retain only its ECMAScript representation.
		raw, e := jsoncanonicalizer.Transform([]byte("[" + v.String() + "]"))
		if e != nil {
			return nil, e
		}
		return raw[1 : len(raw)-1], nil
	case string:
		raw, e := Encode(v)
		if e != nil {
			return nil, e
		}
		return jsEscapes(raw), nil
	case bool:
		if v {
			return []byte("true"), nil
		}
		return []byte("false"), nil
	case nil:
		return []byte("null"), nil
	default:
		raw, e := Encode(value)
		if e != nil {
			return nil, e
		}
		parsed, e := DecodeOrdered(raw)
		if e != nil {
			return nil, e
		}
		return EncodeJS(parsed)
	}
}
func jsEscapes(raw []byte) []byte {
	out := []byte{}
	for i := 0; i < len(raw); {
		if raw[i] == '\\' && i+1 < len(raw) {
			if raw[i+1] == '\\' {
				out = append(out, raw[i:i+2]...)
				i += 2
				continue
			}
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				if raw[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 6
				continue
			}
		}
		out = append(out, raw[i])
		i++
	}
	return out
}
