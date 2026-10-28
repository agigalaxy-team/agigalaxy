package protocol

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"unicode/utf16"
)

// Decode retains numbers and rejects unknown fields and trailing values.
func Decode(raw []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return fault.New("invalid_request", 400)
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return fault.New("invalid_request", 400)
	}
	return nil
}
func Encode(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
func TextLength(s string) int { return len(utf16.Encode([]rune(s))) }
