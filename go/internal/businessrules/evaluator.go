package businessrules

import (
	"golang.org/x/net/idna"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

type Evaluation struct {
	Outcome             string
	Enabled             bool
	Matched, Exceptions []string
}

func objects(v any) ([]Object, bool) {
	a, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := []Object{}
	for _, item := range a {
		o, ok := item.(map[string]any)
		if !ok {
			return nil, false
		}
		out = append(out, o)
	}
	return out, true
}
func normalizeKeyword(v string) string { return cases.Lower(language.Und).String(norm.NFKC.String(v)) }
func domain(v string) string {
	v = strings.TrimSuffix(strings.ToLower(v), ".")
	if net.ParseIP(v) != nil {
		return v
	}
	ascii, e := idna.Lookup.ToASCII(v)
	if e != nil {
		return ""
	}
	return ascii
}

var embeddedLinks = regexp.MustCompile(`(?i)https?://[^\s\p{Z}\x{FEFF}<>"']+`)

func linkFacts(text string, explicit []any) ([]string, *int64) {
	values := []string{}
	for _, v := range explicit {
		values = append(values, asString(v))
	}
	values = append(values, embeddedLinks.FindAllString(text, -1)...)
	urls, hosts := map[string]bool{}, map[string]bool{}
	valid := true
	for _, value := range values {
		value = strings.TrimRight(value, "),，。；;！!？?")
		u, e := url.Parse(value)
		if e != nil || u.Hostname() == "" || u.User != nil || u.Scheme != "http" && u.Scheme != "https" {
			valid = false
			continue
		}
		hostname := domain(u.Hostname())
		if hostname == "" {
			valid = false
			continue
		}
		hosts[hostname] = true
		port := u.Port()
		if u.Scheme == "http" && port == "80" || u.Scheme == "https" && port == "443" {
			port = ""
		}
		u.Host = hostname
		if strings.Contains(hostname, ":") {
			u.Host = "[" + hostname + "]"
		}
		if port != "" {
			u.Host = net.JoinHostPort(hostname, port)
		}
		if u.Path == "" {
			u.Path = "/"
		}
		urls[u.String()] = true
	}
	out := []string{}
	for host := range hosts {
		out = append(out, host)
	}
	if !valid {
		return out, nil
	}
	n := int64(len(urls))
	return out, &n
}
func Evaluate(policy Object, target, account string, facts Object, suppliedText *string, links []any) (Evaluation, error) {
	text := ""
	hasText := suppliedText != nil
	if hasText {
		text = *suppliedText
	}
	out := Evaluation{Outcome: "allow", Matched: []string{}, Exceptions: []string{}}
	feature := map[string]string{"forum-post": "forumPost", "forum-reply": "forumReply", "forum-upload": "attachmentUpload", "chat-message": "chatSend", "chat-upload": "attachmentUpload"}[target]
	if feature == "" {
		return out, fail("invalid_operations_rule_target", 400)
	}
	features := obj(policy, "features")
	enabled, ok := features[feature].(bool)
	if str(policy, "schema") != "business-controls/1" || !ok {
		return out, fail("invalid_operations_rule_request", 400)
	}
	out.Enabled = enabled
	lists, ok := objects(policy["lists"])
	if !ok || len(lists) > 50 {
		return out, fail("invalid_operations_rule_request", 400)
	}
	byID := map[string]Object{}
	for _, list := range lists {
		byID[str(list, "id")] = list
	}
	rules, ok := objects(policy["rules"])
	if !ok || len(rules) > 100 {
		return out, fail("invalid_operations_rule_request", 400)
	}
	hosts, linkCount := linkFacts(text, links)
	if !hasText && links == nil {
		linkCount = nil
	}
	if linkCount != nil {
		facts["linkCount"] = *linkCount
	} else {
		facts["linkCount"] = nil
	}
	facts["textLength"] = nil
	if hasText {
		facts["textLength"] = int64(utf8.RuneCountInString(text))
	}
	environment := &conditionEnvironment{Lists: byID, HasText: hasText, Text: text, Hosts: hosts, LinkCount: linkCount, Facts: facts}
	condition := func(node Object, depth int) (string, error) { return environment.evaluate(node, depth, "1") }
	unknown := false
	for _, rule := range rules {
		targets, ok := rule["targets"].([]any)
		if !ok {
			return out, fail("invalid_operations_rule_request", 400)
		}
		applies := false
		for _, v := range targets {
			applies = applies || v == target
		}
		if !applies || !truth(rule, "enabled") {
			continue
		}
		if str(rule, "action") != "reject" {
			return out, fail("invalid_operations_rule_request", 400)
		}
		state, e := condition(obj(rule, "conditions"), 0)
		if e != nil {
			return out, e
		}
		exceptions, ok := objects(rule["exceptions"])
		if !ok {
			return out, fail("invalid_operations_rule_request", 400)
		}
		excepted := false
		for _, exception := range exceptions {
			if !truth(exception, "enabled") {
				continue
			}
			ids, ok := exception["accountIds"].([]any)
			if !ok {
				return out, fail("invalid_operations_rule_request", 400)
			}
			for _, id := range ids {
				if id == account {
					excepted = true
					out.Exceptions = append(out.Exceptions, str(exception, "id"))
					break
				}
			}
		}
		if state == "hit" && !excepted {
			out.Matched = append(out.Matched, str(rule, "id"))
		}
		unknown = unknown || state == "unknown"
	}
	if !enabled || len(out.Matched) > 0 {
		out.Outcome = "reject"
	} else if unknown {
		out.Outcome = "unknown"
	}
	return out, nil
}
