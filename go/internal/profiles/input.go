// Package profiles owns signed Galaxy ID declarations, distinct from online
// account profiles. Declared capabilities remain unverified statements.
package profiles

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Object = map[string]any
type Sharing struct {
	Visibility string   `json:"visibility"`
	Viewers    []string `json:"viewers"`
	ExpiresAt  *int64   `json:"expiresAt"`
}
type Statement struct {
	ID               string
	ExpectedRevision int64
	SelfDeclared     Object
	Sharing          *Sharing
}

const jsSpace = " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func invalid() error                { return fault.New("invalid_profile_statement", 400) }
func str(o Object, k string) string { v, _ := o[k].(string); return v }
func number(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, e := n.Float64()
	return int64(f), e == nil && f >= 0 && f <= 9007199254740991 && float64(int64(f)) == f
}
func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func shape(v any, required, optional []string) (Object, bool) {
	o, ok := v.(map[string]any)
	if !ok || o == nil {
		return nil, false
	}
	for k := range o {
		found := false
		for _, name := range append(append([]string{}, required...), optional...) {
			if name == k {
				found = true
			}
		}
		if !found {
			return nil, false
		}
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return nil, false
		}
	}
	return o, true
}
func trimmed(v any, min, max int) (string, bool) {
	s, ok := v.(string)
	s = strings.Trim(s, jsSpace)
	return s, ok && protocol.TextLength(s) >= min && protocol.TextLength(s) <= max
}
func tags(v any, maxItems, maxLength int) ([]string, bool) {
	vv, ok := v.([]any)
	if !ok || len(vv) > maxItems {
		return nil, false
	}
	out := []string{}
	for _, x := range vv {
		s, ok := trimmed(x, 1, maxLength)
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}
func parseProject(value any) (Object, bool) {
	o, ok := shape(value, []string{"id", "kind", "title", "summary"}, []string{"functions", "technologies", "sourceUrl", "discoverable"})
	if !ok || !uuidPattern.MatchString(str(o, "id")) || (o["kind"] != "project" && o["kind"] != "module") {
		return nil, false
	}
	title, ok := trimmed(o["title"], 1, 120)
	if !ok {
		return nil, false
	}
	summary, ok := trimmed(o["summary"], 1, 2000)
	if !ok {
		return nil, false
	}
	out := Object{"id": o["id"], "kind": o["kind"], "title": title, "summary": summary}
	for _, k := range []string{"functions", "technologies"} {
		if v, present := o[k]; present {
			values, ok := tags(v, 16, 80)
			if !ok {
				return nil, false
			}
			out[k] = values
		} else {
			out[k] = []string{}
		}
	}
	discoverable := false
	if v, present := o["discoverable"]; present {
		var good bool
		discoverable, good = v.(bool)
		if !good {
			return nil, false
		}
	}
	if discoverable && len(out["functions"].([]string)) == 0 {
		return nil, false
	}
	out["discoverable"] = discoverable
	if v, present := o["sourceUrl"]; present {
		s, ok := v.(string)
		if !ok || protocol.TextLength(s) > 2048 {
			return nil, false
		}
		u, e := url.Parse(strings.Trim(s, jsSpace))
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil && (u.User.Username() != "" || password(u) != "") {
			return nil, false
		}
		out["sourceUrl"] = s
	}
	return out, true
}
func password(u *url.URL) string {
	if u.User == nil {
		return ""
	}
	s, _ := u.User.Password()
	return s
}
func ParseStatement(raw []byte) (Statement, error) {
	var s Statement
	var value Object
	if protocol.Decode(raw, &value) != nil {
		return s, invalid()
	}
	o, ok := shape(value, []string{"id", "expectedRevision", "selfDeclared"}, []string{"sharing"})
	if !ok || !uuidPattern.MatchString(str(o, "id")) {
		return s, invalid()
	}
	revision, ok := number(o["expectedRevision"])
	if !ok {
		return s, invalid()
	}
	s.ID = str(o, "id")
	s.ExpectedRevision = revision
	declared, ok := shape(o["selfDeclared"], nil, []string{"displayName", "about", "claimedCapabilities", "projects"})
	if !ok {
		return s, invalid()
	}
	s.SelfDeclared = Object{}
	for _, field := range []struct {
		k   string
		max int
	}{{"displayName", 100}, {"about", 2000}} {
		if v, yes := declared[field.k]; yes {
			text, good := trimmed(v, 0, field.max)
			if !good {
				return s, invalid()
			}
			s.SelfDeclared[field.k] = text
		}
	}
	if v, yes := declared["claimedCapabilities"]; yes {
		values, good := tags(v, 20, 100)
		if !good {
			return s, invalid()
		}
		s.SelfDeclared["claimedCapabilities"] = values
	}
	if v, yes := declared["projects"]; yes {
		values, good := v.([]any)
		if !good || len(values) > 10 {
			return s, invalid()
		}
		projects := []Object{}
		seen := map[string]bool{}
		for _, v := range values {
			p, good := parseProject(v)
			if !good || seen[str(p, "id")] {
				return s, invalid()
			}
			seen[str(p, "id")] = true
			projects = append(projects, p)
		}
		s.SelfDeclared["projects"] = projects
	}
	if v, yes := o["sharing"]; yes {
		p, good := shape(v, []string{"visibility", "viewers", "expiresAt"}, nil)
		if !good || (p["visibility"] != "Private" && p["visibility"] != "Public") {
			return s, invalid()
		}
		viewers, good := p["viewers"].([]any)
		if !good || len(viewers) > 16 {
			return s, invalid()
		}
		sharing := &Sharing{Visibility: str(p, "visibility"), Viewers: []string{}}
		seen := map[string]bool{}
		for _, v := range viewers {
			id, good := v.(string)
			if !good || !subjectPattern.MatchString(id) || seen[id] {
				return s, invalid()
			}
			seen[id] = true
			sharing.Viewers = append(sharing.Viewers, id)
		}
		if sharing.Visibility == "Public" && len(sharing.Viewers) > 0 {
			return s, invalid()
		}
		if p["expiresAt"] != nil {
			n, good := number(p["expiresAt"])
			if !good || n == 0 {
				return s, invalid()
			}
			sharing.ExpiresAt = &n
		}
		s.Sharing = sharing
	}
	return s, nil
}
