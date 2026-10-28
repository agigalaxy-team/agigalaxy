package personalaudit

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"math/big"
	"net/url"
	"regexp"
)

type Object = map[string]any

var subject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var actionName = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,79}$`)
var reasonCode = regexp.MustCompile(`^[a-z][a-z0-9.-]{2,79}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var cursor = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)

func fail(c string, s int) error    { return fault.New(c, s) }
func invalid() error                { return fail("invalid_audit_request", 409) }
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func id(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	u, e := uuid.Parse(s)
	return e == nil && len(s) == 36 && (u == uuid.Nil || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" || u.Variant() == uuid.RFC4122 && u.Version() >= 1 && u.Version() <= 8)
}
func integer(v any) (int64, bool) {
	switch n := v.(type) {
	case int:
		return int64(n), n >= 0 && int64(n) <= 9007199254740991
	case int64:
		return n, n >= 0 && n <= 9007199254740991
	case float64:
		return int64(n), n >= 0 && n <= 9007199254740991 && n == float64(int64(n))
	case json.Number:
		i, e := n.Int64()
		return i, e == nil && i >= 0 && i <= 9007199254740991
	}
	return 0, false
}
func has(a []string, b string) bool {
	for _, v := range a {
		if v == b {
			return true
		}
	}
	return false
}
func stringsOf(v any) []string {
	a, _ := v.([]any)
	out := []string{}
	for _, item := range a {
		s, ok := item.(string)
		if ok {
			out = append(out, s)
		}
	}
	return out
}
func strict(o Object, keys ...string) bool {
	if o == nil {
		return false
	}
	for k := range o {
		if !has(keys, k) {
			return false
		}
	}
	return true
}
func roles(a []string) bool {
	if len(a) > 32 {
		return false
	}
	seen := map[string]bool{}
	for _, s := range a {
		if !subject.MatchString(s) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}
func validCursor(v any) bool {
	s, ok := v.(string)
	if !ok || !cursor.MatchString(s) {
		return false
	}
	n, _ := new(big.Int).SetString(s, 10)
	return n.Cmp(big.NewInt(9223372036854775807)) <= 0
}
func parseQuery(x Object) (Object, error) {
	if !strict(x, "subjectId", "grantId", "action", "objectId", "requestId", "after", "through", "limit") {
		return nil, invalid()
	}
	q := Object{}
	for k, v := range x {
		q[k] = v
	}
	for _, k := range []string{"grantId", "requestId"} {
		if v, ok := q[k]; ok && !id(v) {
			return nil, invalid()
		}
	}
	if v, ok := q["subjectId"]; ok && !subject.MatchString(str(q, "subjectId")) {
		_ = v
		return nil, invalid()
	}
	if _, ok := q["action"]; ok && !actionName.MatchString(str(q, "action")) {
		return nil, invalid()
	}
	if v, ok := q["objectId"]; ok && !id(v) && !subject.MatchString(str(q, "objectId")) && !hashPattern.MatchString(str(q, "objectId")) {
		return nil, invalid()
	}
	if _, ok := q["after"]; !ok {
		q["after"] = "0"
	}
	if !validCursor(q["after"]) {
		return nil, invalid()
	}
	if v, ok := q["through"]; ok {
		if !validCursor(v) {
			return nil, invalid()
		}
		a, _ := new(big.Int).SetString(str(q, "after"), 10)
		b, _ := new(big.Int).SetString(str(q, "through"), 10)
		if a.Cmp(b) > 0 {
			return nil, invalid()
		}
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = int64(25)
	}
	n, ok := integer(q["limit"])
	if !ok || n < 1 || n > 100 {
		return nil, invalid()
	}
	q["limit"] = n
	return q, nil
}
func parseGrant(g Object) (Object, error) {
	keys := []string{"version", "id", "endpoint", "reviewerId", "reviewerBindingId", "readerId", "subjectIds", "actions", "reasonCode", "issuedAt", "expiresAt"}
	if !strict(g, keys...) || len(g) != len(keys) || !id(g["id"]) || !id(g["reviewerBindingId"]) {
		return nil, invalid()
	}
	version, ok := integer(g["version"])
	if !ok || version != 1 {
		return nil, invalid()
	}
	u, e := url.Parse(str(g, "endpoint"))
	if e != nil || u.Scheme == "" || u.Host == "" {
		return nil, invalid()
	}
	for _, k := range []string{"reviewerId", "readerId"} {
		if !subject.MatchString(str(g, k)) {
			return nil, invalid()
		}
	}
	for _, k := range []string{"subjectIds", "actions"} {
		a, ok := g[k].([]any)
		if !ok {
			return nil, invalid()
		}
		limit := 16
		if k == "actions" {
			limit = 2
		}
		if len(a) < 1 || len(a) > limit {
			return nil, invalid()
		}
		seen := map[string]bool{}
		for _, v := range a {
			s, ok := v.(string)
			if !ok || seen[s] || k == "subjectIds" && !subject.MatchString(s) || k == "actions" && !has([]string{"query", "export"}, s) {
				return nil, invalid()
			}
			seen[s] = true
		}
	}
	issued, ok := integer(g["issuedAt"])
	expires, ok2 := integer(g["expiresAt"])
	if !ok || !ok2 || expires <= issued || expires-issued > 3600 || g["readerId"] == g["reviewerId"] || !reasonCode.MatchString(str(g, "reasonCode")) {
		return nil, invalid()
	}
	return g, nil
}
