package operationsrules

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"golang.org/x/net/idna"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)

func text(v any, max int) (string, bool) {
	s, ok := v.(string)
	s = trim(s)
	n := utf8.RuneCountInString(s)
	if !ok || n < 1 || n > max {
		return "", false
	}
	for _, r := range s {
		if unicode.IsControl(r) || r >= 0xd800 && r <= 0xdfff {
			return "", false
		}
	}
	return s, true
}
func ids(v any, min, max int) bool {
	return unique(v, min, max, func(v any) bool { return uuidPattern.MatchString(str(v)) })
}
func unique(v any, min, max int, valid func(any) bool) bool {
	if !array(v) || len(list(v)) < min || len(list(v)) > max {
		return false
	}
	seen := map[string]bool{}
	for _, x := range list(v) {
		s := str(x)
		if !valid(x) || seen[s] {
			return false
		}
		seen[s] = true
	}
	return true
}

var domainLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func domain(value string) string {
	if protocol.TextLength(value) > 253 {
		return ""
	}
	for _, r := range value {
		if strings.ContainsRune(`/\:@?#`, r) || unicode.IsSpace(r) || r == '\ufeff' {
			return ""
		}
	}
	v, e := idna.Lookup.ToASCII(strings.TrimSuffix(cases.Lower(language.Und).String(value), "."))
	if e != nil || len(v) > 253 || !strings.Contains(v, ".") {
		return ""
	}
	for _, p := range strings.Split(v, ".") {
		if !domainLabel.MatchString(p) {
			return ""
		}
	}
	return v
}
func EmptyControls() Object {
	return Object{"schema": "business-controls/1", "features": Object{"forumPost": true, "forumReply": true, "chatSend": true, "attachmentUpload": true}, "lists": []any{}, "rules": []any{}}
}
func ParsePolicy(key string, input Object) (Object, error) {
	bad := func() (Object, error) { return nil, invalid() }
	// Domain loaders and SQL projections use different Go numeric carriers.
	// Normalize through the existing JSON decoder before the shared schema.
	raw, e := json.Marshal(input)
	if e != nil || protocol.Decode(raw, &input) != nil {
		return bad()
	}
	switch key {
	case "resource-budget":
		p, e := resourcebudget.ParsePolicy(input)
		if e != nil {
			return bad()
		}
		b, _ := json.Marshal(p)
		var out Object
		_ = json.Unmarshal(b, &out)
		return out, nil
	case "forum-quota":
		p, e := community.ParseForumPolicy(input)
		if e != nil {
			return bad()
		}
		return p, nil
	case "community-quota":
		if publicwrites.ValidatePolicy(input) != nil || input["version"] != "community-quota/1" {
			return bad()
		}
		for _, tier := range []string{"new", "normal"} {
			for _, v := range obj(input[tier]) {
				if !integer(v, 1, 100000) {
					return bad()
				}
			}
		}
		return input, nil
	case "business-controls":
		return ParseControls(input)
	}
	return bad()
}
func ParseControls(input Object) (Object, error) {
	bad := func() (Object, error) { return nil, invalid() }
	if !closed(input, []string{"schema", "features", "lists", "rules"}, nil) || input["schema"] != "business-controls/1" {
		return bad()
	}
	f := obj(input["features"])
	if !closed(f, []string{"forumPost", "forumReply", "chatSend", "attachmentUpload"}, nil) {
		return bad()
	}
	for _, v := range f {
		if _, ok := v.(bool); !ok {
			return bad()
		}
	}
	if !array(input["lists"]) || len(list(input["lists"])) > 50 || !array(input["rules"]) || len(list(input["rules"])) > 100 {
		return bad()
	}
	out := Object{"schema": input["schema"], "features": clone(f), "lists": []any{}, "rules": []any{}}
	kinds := map[string]string{}
	for _, v := range list(input["lists"]) {
		x := obj(v)
		if !closed(x, []string{"id", "name", "kind", "enabled", "entries"}, nil) || !uuidPattern.MatchString(str(x["id"])) || !has([]string{"keyword", "domain"}, str(x["kind"])) || !array(x["entries"]) || len(list(x["entries"])) > 500 {
			return bad()
		}
		if _, exists := kinds[str(x["id"])]; exists {
			return bad()
		}
		kinds[str(x["id"])] = str(x["kind"])
		if _, ok := x["enabled"].(bool); !ok {
			return bad()
		}
		name, ok := text(x["name"], 80)
		if !ok {
			return bad()
		}
		entries := []any{}
		seen := map[string]bool{}
		for _, v := range list(x["entries"]) {
			s, ok := text(v, 160)
			if !ok {
				return bad()
			}
			normalized := cases.Lower(language.Und).String(norm.NFKC.String(s))
			if x["kind"] == "domain" {
				normalized = domain(s)
				if normalized == "" {
					return bad()
				}
			}
			if seen[normalized] {
				return bad()
			}
			seen[normalized] = true
			entries = append(entries, s)
		}
		y := clone(x)
		y["name"], y["entries"] = name, entries
		out["lists"] = append(list(out["lists"]), y)
	}
	count := 0
	seenRules := map[string]bool{}
	for _, v := range list(input["rules"]) {
		x := obj(v)
		if !closed(x, []string{"id", "name", "enabled", "targets", "conditions", "action", "exceptions"}, nil) || !uuidPattern.MatchString(str(x["id"])) || seenRules[str(x["id"])] || x["action"] != "reject" || !unique(x["targets"], 1, 5, func(v any) bool { return has(Targets, str(v)) }) || !array(x["exceptions"]) || len(list(x["exceptions"])) > 30 {
			return bad()
		}
		seenRules[str(x["id"])] = true
		if _, ok := x["enabled"].(bool); !ok {
			return bad()
		}
		name, ok := text(x["name"], 80)
		if !ok {
			return bad()
		}
		type node struct {
			x     Object
			depth int
		}
		stack := []node{{obj(x["conditions"]), 0}}
		for len(stack) > 0 {
			n := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			count++
			if n.depth > 6 || count > 1000 {
				return bad()
			}
			if array(n.x["rules"]) {
				for _, child := range list(n.x["rules"]) {
					stack = append(stack, node{obj(child), n.depth + 1})
				}
			} else {
				field := str(n.x["field"])
				for _, t := range list(x["targets"]) {
					upload := t == "forum-upload" || t == "chat-upload"
					if upload && !has([]string{"accountTier", "subjectType", "fileBytes"}, field) || !upload && !has([]string{"accountTier", "subjectType", "textLength", "linkCount", "attachmentCount", "keywordList", "domainList"}, field) {
						return bad()
					}
				}
				if field == "keywordList" && kinds[str(n.x["value"])] != "keyword" || field == "domainList" && kinds[str(n.x["value"])] != "domain" {
					return bad()
				}
			}
		}
		condition, e := businessrules.ParseCondition(obj(x["conditions"]))
		if e != nil {
			return bad()
		}
		exceptions := []any{}
		seen := map[string]bool{}
		for _, v := range list(x["exceptions"]) {
			e := obj(v)
			if !closed(e, []string{"id", "name", "enabled", "accountIds"}, nil) || !uuidPattern.MatchString(str(e["id"])) || seen[str(e["id"])] || !ids(e["accountIds"], 1, 100) {
				return bad()
			}
			seen[str(e["id"])] = true
			if _, ok := e["enabled"].(bool); !ok {
				return bad()
			}
			n, ok := text(e["name"], 80)
			if !ok {
				return bad()
			}
			y := clone(e)
			y["name"] = n
			exceptions = append(exceptions, y)
		}
		y := clone(x)
		y["name"], y["conditions"], y["exceptions"] = name, condition, exceptions
		out["rules"] = append(list(out["rules"]), y)
	}
	return out, nil
}
func parseCommand(kind string, x Object) (Object, error) {
	fields := []string{"operationId", "expectedRevision", "reason"}
	if kind == "draft" {
		fields = append(fields, "policy")
	} else {
		fields = append(fields, "versionId")
	}
	if !closed(x, fields, nil) || !uuidPattern.MatchString(str(x["operationId"])) || !integer(x["expectedRevision"], 0, 9007199254740991) {
		return nil, invalid()
	}
	reason, ok := text(x["reason"], 500)
	if !ok || kind != "draft" && !uuidPattern.MatchString(str(x["versionId"])) {
		return nil, invalid()
	}
	out := clone(x)
	out["reason"] = reason
	return out, nil
}
