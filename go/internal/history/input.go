package history

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var capabilityPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$`)
var utcPattern = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$`)

const jsSpace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

type options struct {
	Subject, Query, Outcome, Capability, Strength, SourceKind, Environment, CreatedFrom, CreatedBefore, After *string
	Limit                                                                                                     int
	Terms                                                                                                     []string
}

func invalid() error            { return fault.New("invalid_history_query", 400) }
func lower(value string) string { return cases.Lower(language.AmericanEnglish).String(value) }
func one(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func parse(raw []byte) (options, error) {
	out := options{Limit: 20}
	var p Object
	if protocol.Decode(raw, &p) != nil || p == nil {
		return out, invalid()
	}
	fields := map[string]**string{"subjectId": &out.Subject, "query": &out.Query, "outcome": &out.Outcome, "capabilityId": &out.Capability, "verificationStrength": &out.Strength, "sourceKind": &out.SourceKind, "environment": &out.Environment, "createdFrom": &out.CreatedFrom, "createdBefore": &out.CreatedBefore, "after": &out.After}
	for k, v := range p {
		if k == "limit" {
			n, ok := v.(json.Number)
			if !ok {
				return out, invalid()
			}
			f, e := n.Float64()
			if e != nil || f < 1 || f > 50 || float64(int(f)) != f {
				return out, invalid()
			}
			out.Limit = int(f)
			continue
		}
		field, ok := fields[k]
		if !ok {
			return out, invalid()
		}
		s, ok := v.(string)
		if !ok {
			return out, invalid()
		}
		if one(k, "query", "environment") {
			s = strings.Trim(s, jsSpace)
		}
		*field = &s
	}
	if out.Subject != nil && !subjectPattern.MatchString(*out.Subject) || out.After != nil && !uuidPattern.MatchString(*out.After) || out.Capability != nil && !capabilityPattern.MatchString(*out.Capability) || out.Outcome != nil && !one(*out.Outcome, "succeeded", "partial", "failed", "inconclusive", "conflicting") || out.Strength != nil && !one(*out.Strength, "reported-only", "ci-execution-fact") || out.SourceKind != nil && !one(*out.SourceKind, "local", "bridge", "hub") {
		return out, invalid()
	}
	q := ""
	if out.Query != nil {
		q = *out.Query
	}
	if protocol.TextLength(q) > 200 {
		return out, invalid()
	}
	out.Query = &q
	if out.Environment != nil && (protocol.TextLength(*out.Environment) < 1 || protocol.TextLength(*out.Environment) > 160) {
		return out, invalid()
	}
	var times []time.Time
	for _, v := range []*string{out.CreatedFrom, out.CreatedBefore} {
		if v == nil {
			times = append(times, time.Time{})
			continue
		}
		if !utcPattern.MatchString(*v) {
			return out, invalid()
		}
		t, e := time.Parse(time.RFC3339Nano, *v)
		if e != nil {
			return out, invalid()
		}
		times = append(times, t)
	}
	if out.CreatedFrom != nil && out.CreatedBefore != nil && !times[0].Before(times[1]) {
		return out, invalid()
	}
	seen := map[string]bool{}
	for _, term := range strings.FieldsFunc(lower(q), func(r rune) bool { return strings.ContainsRune(jsSpace, r) }) {
		if !seen[term] {
			seen[term] = true
			out.Terms = append(out.Terms, term)
		}
	}
	if len(out.Terms) > 8 {
		return out, invalid()
	}
	if out.Terms == nil {
		out.Terms = []string{}
	}
	return out, nil
}
