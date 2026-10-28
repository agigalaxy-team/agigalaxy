package accountarchive

import (
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var technicalPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:+-]*(?:/[a-zA-Z0-9][a-zA-Z0-9_.:+-]*)?$`)
var drivePattern = regexp.MustCompile(`(?i)^[a-z]:/`)
var sessionPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,256}$`)
var utcPattern = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$`)

type check func(any) bool

func stringCheck(min, max int) check { return func(v any) bool { return text(v, min, max) } }
func enum(values ...string) check {
	return func(v any) bool {
		for _, x := range values {
			if v == x {
				return true
			}
		}
		return false
	}
}
func obj(fields map[string]check) check {
	return func(v any) bool {
		o, ok := v.(map[string]any)
		if !ok {
			return false
		}
		for k := range o {
			if strings.HasSuffix(k, "?") {
				return false
			}
			if _, yes := fields[k]; !yes {
				if _, yes = fields[k+"?"]; !yes {
					return false
				}
			}
		}
		for k, c := range fields {
			key := strings.TrimSuffix(k, "?")
			value, present := o[key]
			if !present && strings.HasSuffix(k, "?") {
				continue
			}
			if !present || !c(value) {
				return false
			}
		}
		return true
	}
}
func arr(max int, c check) check {
	return func(v any) bool {
		vv, ok := v.([]any)
		if !ok || len(vv) > max {
			return false
		}
		for _, x := range vv {
			if !c(x) {
				return false
			}
		}
		return true
	}
}
func nullable(c check) check { return func(v any) bool { return v == nil || c(v) } }
func boolCheck(v any) bool   { _, ok := v.(bool); return ok }
func seq(v any) bool         { _, ok := number(v); return ok }
func positive(v any) bool    { n, ok := number(v); return ok && n > 0 }
func uuidCheck(v any) bool   { s, ok := v.(string); return ok && validID(s) }
func timestamp(v any) bool {
	s, ok := v.(string)
	if !ok || !utcPattern.MatchString(s) {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func technical(v any) bool {
	s, ok := v.(string)
	return ok && text(s, 1, 128) && technicalPattern.MatchString(s) && !drivePattern.MatchString(s)
}
func material(v any) bool {
	nodes := 0
	var visit func(any, int) bool
	visit = func(v any, depth int) bool {
		nodes++
		if nodes > 4096 || depth > 16 {
			return false
		}
		if v == nil {
			return true
		}
		switch x := v.(type) {
		case bool:
			return true
		case string:
			return protocol.TextLength(x) <= 16384
		case []any:
			if len(x) > 1000 {
				return false
			}
			for _, c := range x {
				if !visit(c, depth+1) {
					return false
				}
			}
			return true
		case map[string]any:
			for k, c := range x {
				if protocol.TextLength(k) > 256 || k == "__proto__" || k == "constructor" || k == "prototype" || !visit(c, depth+1) {
					return false
				}
			}
			return true
		default:
			_, ok := numberSigned(v)
			return ok
		}
	}
	return visit(v, 0)
}
func numberSigned(v any) (float64, bool) {
	switch n := v.(type) {
	case interface{ Float64() (float64, error) }:
		f, e := n.Float64()
		return f, e == nil
	}
	return 0, false
}
func projection(v any) bool {
	outcome := enum("unknown", "reported-success", "reported-failure", "partial", "cancelled")
	host := enum("opencode", "codex", "claude-code", "claude", "gemini-cli", "cursor", "vscode", "windsurf", "openclaw", "mcp", "host", "unknown")
	facts := map[string]check{}
	for _, k := range []string{"host", "hostVersion", "platform", "architecture", "runtime", "runtimeVersion", "selectedModel", "actualModel"} {
		facts[k+"?"] = technical
	}
	facts["tools?"] = arr(256, func(v any) bool { return technical(v) && !strings.Contains(v.(string), "/") })
	environment := obj(map[string]check{"id": uuidCheck, "version": positive, "observedAt": timestamp, "facts": obj(facts)})
	source := obj(map[string]check{"kind": enum("host-event", "user-statement", "model-report", "tool-report", "external-material"), "messageId?": stringCheck(1, 512), "partId?": stringCheck(1, 512), "eventId?": stringCheck(1, 512), "locator?": stringCheck(0, 2048)})
	observationFields := obj(map[string]check{"id": uuidCheck, "sequence": seq, "sourceId": stringCheck(1, 512), "revision": seq, "latestRevision": seq, "superseded": boolCheck, "kind": enum("message", "tool", "session", "artifact", "claim", "gap"), "occurredAt": nullable(timestamp), "observedAt": timestamp, "source": source, "content": nullable(obj(map[string]check{"excerpt": stringCheck(0, 4000), "originalLength?": seq, "retained": enum("none", "excerpt", "full"), "availableFromHost": boolCheck})), "details": material, "exclusions": arr(1000, obj(map[string]check{"path": stringCheck(0, 2048), "kind": enum("credential", "inline-binary", "depth-limit", "cyclic-reference")})), "environmentId": nullable(uuidCheck), "environmentMeaning": enum("observed-at-collection"), "localOnly": enumBoolTrue})
	observation := func(v any) bool {
		if !observationFields(v) {
			return false
		}
		o := v.(map[string]any)
		r, _ := number(o["revision"])
		l, _ := number(o["latestRevision"])
		return l >= r && o["superseded"] == (l > r)
	}
	summary := obj(map[string]check{"title": stringCheck(0, 180), "summary": stringCheck(0, 12000), "outcome": outcome, "summaryRevision": seq, "sourceKind": enum("user-model", "host-observations"), "updatedAt?": timestamp})
	coverage := obj(map[string]check{"observations": obj(map[string]check{"sourceTotal": seq, "included": seq, "firstSequence": nullable(seq), "lastSequence": nullable(seq), "hasEarlier": boolCheck}), "omittedFields?": arr(2, enum("summary", "environments"))})
	fields := map[string]check{"workId": stringCheck(1, 512), "galaxyId": func(v any) bool { s, ok := v.(string); return ok && subjectPattern.MatchString(s) }, "source": obj(map[string]check{"host": host, "sessionId?": func(v any) bool { s, ok := v.(string); return ok && sessionPattern.MatchString(s) }}), "workType": enum("unknown", "development", "research", "writing", "design", "operations", "analysis", "learning", "other"), "role": enum("unknown", "owner", "participant", "contributor", "reviewer", "observer"), "startedAt?": timestamp, "updatedAt?": timestamp, "resultStatus": outcome, "resultSource": enum("user-model", "host-observations"), "environments": arr(1000, environment), "uploadLevel": enum("history-overview", "work-content", "conversation-archive")}
	o, ok := v.(map[string]any)
	if !ok {
		return false
	}
	if o["uploadLevel"] != "history-overview" {
		fields["summary?"] = summary
		fields["observations?"] = arr(2000, observation)
		fields["coverage?"] = coverage
	}
	if !obj(fields)(v) {
		return false
	}
	compact, e := identity.Canonical(v)
	if e != nil || len(compact) > 524288 {
		return false
	}
	redacted, e := localdata.Redact(v)
	if e != nil {
		return false
	}
	for _, x := range redacted.Exclusions {
		if x.Kind == "credential" {
			return false
		}
	}
	for _, key := range []string{"environments", "observations"} {
		seen := map[string]bool{}
		items, _ := o[key].([]any)
		for _, item := range items {
			id := item.(map[string]any)["id"].(string)
			if seen[id] {
				return false
			}
			seen[id] = true
		}
	}
	if c, ok := o["coverage"].(map[string]any); ok {
		window := c["observations"].(map[string]any)
		items, _ := o["observations"].([]any)
		included, _ := number(window["included"])
		total, _ := number(window["sourceTotal"])
		var first, last any
		for i, v := range items {
			n := v.(map[string]any)["sequence"]
			if i == 0 {
				first = n
			} else {
				prior, _ := number(last)
				current, _ := number(n)
				if current <= prior {
					return false
				}
			}
			last = n
		}
		equalNumber := func(a, b any) bool {
			if a == nil || b == nil {
				return a == nil && b == nil
			}
			x, _ := number(a)
			y, _ := number(b)
			return x == y
		}
		if included != int64(len(items)) || total < included || !equalNumber(first, window["firstSequence"]) || !equalNumber(last, window["lastSequence"]) || window["hasEarlier"] != (total > included) {
			return false
		}
		seen := map[string]bool{}
		omitted, _ := c["omittedFields"].([]any)
		for _, x := range omitted {
			k := x.(string)
			if seen[k] {
				return false
			}
			seen[k] = true
			if k == "summary" {
				if _, yes := o[k]; yes {
					return false
				}
			}
			if k == "environments" && len(o["environments"].([]any)) > 0 {
				return false
			}
		}
	}
	return true
}
func enumBoolTrue(v any) bool { return v == true }
func parseWork(raw []byte, action string) (Object, error) {
	code := "account_work_input_invalid"
	keys := []string{"workId"}
	if action == "put" {
		keys = []string{"operationId", "workId", "scopeId", "revision", "expectedRevision", "data"}
	}
	if action == "list" {
		keys = []string{"after", "limit"}
	}
	p, e := input(raw, code, keys)
	if e != nil {
		return nil, e
	}
	valid := true
	if action == "list" {
		if v, yes := p["after"]; yes {
			valid = text(v, 1, 512)
		}
		if _, yes := p["limit"]; yes {
			_, ok := integer(p, "limit", 1, 50)
			valid = valid && ok
		}
	} else {
		valid = text(p["workId"], 1, 512)
	}
	if action == "put" {
		rev, ok := integer(p, "revision", 1, 9007199254740991)
		expected, ok2 := integer(p, "expectedRevision", 0, 9007199254740991)
		valid = valid && validID(str(p, "operationId")) && validID(str(p, "scopeId")) && ok && ok2 && rev == expected+1 && projection(p["data"])
		if valid {
			valid = p["workId"] == p["data"].(map[string]any)["workId"]
		}
	}
	if !valid {
		return nil, fault.New(code, 400)
	}
	return p, nil
}
