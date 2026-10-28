// Package publicwrites owns the existing shared Task/comment/invitation quota
// ledger. Forum publication budgets are a separate original policy.
package publicwrites

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any

func DefaultPolicy() Object {
	return Object{"version": "community-quota/1", "new": Object{"task": 2, "comment": 20, "invitation": 5}, "normal": Object{"task": 10, "comment": 100, "invitation": 20}, "promotionDays": 7, "invitationCooldownDays": 7}
}
func LoadPolicy(path string) (Object, error) {
	if path == "" {
		return DefaultPolicy(), nil
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("absolute community policy path required")
	}
	info, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 8192 {
		return nil, fmt.Errorf("invalid community policy file")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	var policy Object
	if protocol.Decode(raw, &policy) != nil {
		return nil, fmt.Errorf("invalid community policy")
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if v, ok := fields["version"]; ok {
		policy["version"] = rawPolicyString(append([]byte(nil), v...))
	}
	if e = ValidatePolicy(policy); e != nil {
		return nil, e
	}
	return policy, nil
}
func ValidatePolicy(p Object) error {
	invalid := func() error { return fmt.Errorf("invalid community policy") }
	if len(p) != 5 || !keys(p, "version", "new", "normal", "promotionDays", "invitationCooldownDays") || !validText(p["version"], 80) || !integer(p["promotionDays"], 1, 365) || !integer(p["invitationCooldownDays"], 1, 365) {
		return invalid()
	}
	for _, tier := range []string{"new", "normal"} {
		limits := object(p[tier])
		if len(limits) != 3 || !keys(limits, "task", "comment", "invitation") {
			return invalid()
		}
		for _, kind := range []string{"task", "comment", "invitation"} {
			if !integer(limits[kind], 1, 9007199254740991) {
				return invalid()
			}
		}
	}
	return nil
}
func keys(v Object, names ...string) bool {
	for _, k := range names {
		if _, ok := v[k]; !ok {
			return false
		}
	}
	return true
}

type rawPolicyString []byte

func (s rawPolicyString) MarshalJSON() ([]byte, error) { return []byte(s), nil }
func validText(v any, max int) bool {
	if s, ok := v.(string); ok {
		return protocol.TextLength(s) > 0 && protocol.TextLength(s) <= max
	}
	if marshaler, ok := v.(json.Marshaler); ok {
		raw, e := marshaler.MarshalJSON()
		if e != nil {
			return false
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return false
		}
		return protocol.TextLength(s) > 0 && protocol.TextLength(s) <= max
	}
	return false
}

func integer(v any, min, max int64) bool {
	n := number(v)
	if n < min || n > max {
		return false
	}
	switch x := v.(type) {
	case int, int64:
		return true
	case float64:
		return float64(n) == x
	case json.Number:
		f, e := x.Float64()
		return e == nil && f == float64(n)
	}
	return false
}
