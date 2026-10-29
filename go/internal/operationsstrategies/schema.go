package operationsstrategies

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"regexp"
	"strconv"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var actionPattern = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,119}$`)

func closed(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !has(required, k) && !has(optional, k) {
			return false
		}
	}
	return true
}
func boundedText(v any, max int) (string, bool) {
	s, ok := v.(string)
	s = trim(s)
	n := utf8.RuneCountInString(s)
	return s, ok && n >= 1 && n <= max
}
func note(v any) (any, bool) {
	if v == nil {
		return nil, true
	}
	s, ok := boundedText(v, 2400)
	return s, ok
}
func uniqueArray(v any, min, max int, valid func(any) bool) bool {
	if !array(v) || len(list(v)) < min || len(list(v)) > max {
		return false
	}
	seen := map[string]bool{}
	for _, v := range list(v) {
		if !valid(v) || seen[str(v)] {
			return false
		}
		seen[str(v)] = true
	}
	return true
}
func uuids(v any, min, max int) bool {
	return uniqueArray(v, min, max, func(v any) bool { return uuidPattern.MatchString(str(v)) })
}
func path(v any) bool {
	if !array(v) || len(list(v)) < 1 || len(list(v)) > 6 {
		return false
	}
	for _, v := range list(v) {
		if !integer(v, 0, 19) {
			return false
		}
	}
	return true
}
func pathKey(v any) string {
	k := ""
	for i, v := range list(v) {
		if i > 0 {
			k += "."
		}
		k += strconv.FormatInt(num(v), 10)
	}
	return k
}
func leaf(tree any, p any) Object {
	node := obj(tree)
	for _, v := range list(p) {
		rows := list(node["rules"])
		i := int(num(v))
		if i < 0 || i >= len(rows) {
			return nil
		}
		node = obj(rows[i])
	}
	if node["rules"] != nil {
		return nil
	}
	return node
}
func parseExecution(v any) (Object, bool) {
	o := obj(v)
	if !closed(o, []string{"aiDomain", "trigger", "mode", "grantIds", "resourceScope", "requiredRehearsal", "actions"}, nil) || !has(Domains, str(o["aiDomain"])) || !has([]string{"code", "ai", "ai-human", "human-ai"}, str(o["mode"])) || !uuids(o["grantIds"], 0, 50) || !uniqueArray(o["actions"], 0, 200, func(v any) bool { return actionPattern.MatchString(str(v)) }) {
		return nil, false
	}
	if _, ok := o["requiredRehearsal"].(bool); !ok {
		return nil, false
	}
	t := obj(o["trigger"])
	if !closed(t, []string{"kind"}, []string{"minutes", "at", "eventTypes"}) || !has([]string{"manual", "interval", "daily", "event"}, str(t["kind"])) {
		return nil, false
	}
	trigger := clone(t)
	if v, ok := t["minutes"]; ok && !integer(v, 1, 10080) {
		return nil, false
	}
	if v, ok := t["at"]; ok && v != nil && !regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`).MatchString(str(v)) {
		return nil, false
	}
	if _, ok := trigger["eventTypes"]; !ok {
		trigger["eventTypes"] = []any{}
	}
	if !uniqueArray(trigger["eventTypes"], 0, 50, func(v any) bool { return actionPattern.MatchString(str(v)) }) {
		return nil, false
	}
	scope := obj(o["resourceScope"])
	switch scope["kind"] {
	case "eligible", "unresolved":
		if !closed(scope, []string{"kind"}, nil) {
			return nil, false
		}
	case "selected":
		if !closed(scope, []string{"kind", "resourceIds"}, nil) || !uuids(scope["resourceIds"], 0, 200) {
			return nil, false
		}
	default:
		return nil, false
	}
	out := clone(o)
	out["trigger"] = trigger
	return out, true
}
func parseStrategy(v any) (Object, bool) {
	o := obj(v)
	if !closed(o, []string{"id", "name", "domain", "objective", "enabled", "mode", "template", "judgment", "instructions", "recovery"}, []string{"execution", "condition", "ordinaryBounds"}) || !uuidPattern.MatchString(str(o["id"])) || !has(Domains, str(o["domain"])) || !has(Modes, str(o["mode"])) || !has([]string{"selected-public-content-visibility", "analysis-only", "business-action"}, str(o["template"])) || !has([]string{"prepared-command", "semantic"}, str(o["judgment"])) {
		return nil, false
	}
	out := clone(o)
	name, ok := boundedText(o["name"], 120)
	if !ok {
		return nil, false
	}
	out["name"] = name
	if _, ok := o["enabled"].(bool); !ok {
		return nil, false
	}
	for _, k := range []string{"objective", "instructions"} {
		if out[k], ok = note(o[k]); !ok {
			return nil, false
		}
	}
	if o["template"] == "selected-public-content-visibility" && o["domain"] != "governance" || o["judgment"] == "semantic" && out["instructions"] == nil {
		return nil, false
	}
	if v, exists := o["execution"]; exists && v != nil {
		x, valid := parseExecution(v)
		if !valid || o["template"] == "analysis-only" && len(list(x["actions"])) > 0 {
			return nil, false
		}
		mode := map[string]string{"code": "code-automatic", "ai": "ai-autonomous", "ai-human": "ai-human-participation", "human-ai": "human-led"}[str(x["mode"])]
		if mode != o["mode"] {
			return nil, false
		}
		out["execution"] = x
	}
	recovery := obj(o["recovery"])
	if !closed(recovery, []string{"versionId", "conditions"}, nil) || recovery["versionId"] != nil && !uuidPattern.MatchString(str(recovery["versionId"])) || !uniqueArray(recovery["conditions"], 0, 2, func(v any) bool { return has([]string{"native-unavailable", "workflow-failed"}, str(v)) }) || (recovery["versionId"] == nil) != (len(list(recovery["conditions"])) == 0) {
		return nil, false
	}
	out["condition"] = nil
	if o["condition"] != nil {
		tree, e := businessrules.ParseCondition(obj(o["condition"]))
		if e != nil {
			return nil, false
		}
		queue := []Object{tree}
		for len(queue) > 0 {
			node := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			if node["rules"] != nil {
				for _, v := range list(node["rules"]) {
					queue = append(queue, obj(v))
				}
			} else if !has([]string{"textLength", "linkCount", "attachmentCount"}, str(node["field"])) {
				return nil, false
			}
		}
		out["condition"] = tree
	}
	out["ordinaryBounds"] = nil
	if o["ordinaryBounds"] != nil {
		b := obj(o["ordinaryBounds"])
		if !closed(b, []string{"parameters", "modes", "canEnable", "canDisable"}, []string{"canCreate"}) || !array(b["parameters"]) || len(list(b["parameters"])) > 30 || !uniqueArray(b["modes"], 0, 3, func(v any) bool {
			return has([]string{"code-automatic", "ai-autonomous", "ai-human-participation"}, str(v))
		}) {
			return nil, false
		}
		for _, k := range []string{"canEnable", "canDisable"} {
			if _, ok := b[k].(bool); !ok {
				return nil, false
			}
		}
		if value, ok := b["canCreate"]; ok {
			if _, valid := value.(bool); !valid {
				return nil, false
			}
		}
		seen := map[string]bool{}
		for _, v := range list(b["parameters"]) {
			bound := obj(v)
			if !closed(bound, []string{"path", "minimum", "maximum"}, nil) || !path(bound["path"]) || !integer(bound["minimum"], 0, 9007199254740991) || !integer(bound["maximum"], 0, 9007199254740991) || num(bound["maximum"]) < num(bound["minimum"]) {
				return nil, false
			}
			key := pathKey(bound["path"])
			node := leaf(out["condition"], bound["path"])
			if seen[key] || node == nil || !integer(node["value"], 0, 9007199254740991) {
				return nil, false
			}
			seen[key] = true
		}
		out["ordinaryBounds"] = b
	}
	return out, true
}
func EmptyConfiguration() Object {
	rows := []any{}
	for _, d := range Domains {
		rows = append(rows, Object{"key": d, "objective": nil, "priority": nil, "executionEnabled": false})
	}
	return Object{"common": Object{"objective": nil, "automationEnabled": false}, "domains": rows, "strategies": []any{}}
}
func ParseConfiguration(input Object) (Object, error) {
	if !closed(input, []string{"common", "domains", "strategies"}, nil) || !array(input["domains"]) || len(list(input["domains"])) != 5 || !array(input["strategies"]) || len(list(input["strategies"])) > 200 {
		return nil, invalid()
	}
	common := obj(input["common"])
	if !closed(common, []string{"objective", "automationEnabled"}, nil) {
		return nil, invalid()
	}
	if _, ok := common["automationEnabled"].(bool); !ok {
		return nil, invalid()
	}
	objective, ok := note(common["objective"])
	if !ok {
		return nil, invalid()
	}
	domains := []any{}
	seen := map[string]bool{}
	for _, v := range list(input["domains"]) {
		d := obj(v)
		if !closed(d, []string{"key", "objective", "priority", "executionEnabled"}, nil) || !has(Domains, str(d["key"])) || seen[str(d["key"])] {
			return nil, invalid()
		}
		seen[str(d["key"])] = true
		x := clone(d)
		for _, k := range []string{"objective", "priority"} {
			if x[k], ok = note(d[k]); !ok {
				return nil, invalid()
			}
		}
		if _, ok := d["executionEnabled"].(bool); !ok {
			return nil, invalid()
		}
		domains = append(domains, x)
	}
	strategies := []any{}
	seen = map[string]bool{}
	size := 0
	type entry struct {
		node  Object
		depth int
	}
	for _, v := range list(input["strategies"]) {
		raw := obj(v)
		queue := []entry{{obj(raw["condition"]), 0}}
		for len(queue) > 0 {
			item := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			if item.node == nil {
				continue
			}
			size++
			if item.depth > 6 || size > 1000 {
				return nil, invalid()
			}
			for _, v := range list(item.node["rules"]) {
				queue = append(queue, entry{obj(v), item.depth + 1})
			}
		}
		strategy, ok := parseStrategy(v)
		if !ok || seen[str(strategy["id"])] {
			return nil, invalid()
		}
		seen[str(strategy["id"])] = true
		strategies = append(strategies, strategy)
	}
	return Object{"common": Object{"objective": objective, "automationEnabled": common["automationEnabled"]}, "domains": domains, "strategies": strategies}, nil
}
func ParseCommand(kind string, input Object) (Object, error) {
	req, opt := []string{"operationId"}, []string{}
	switch kind {
	case "draft":
		req = append(req, "expectedRevision", "configuration", "reason")
	case "prepared-draft":
		req = append(req, "expectedRevision", "configuration", "reason", "expectedDraftId")
	case "publish":
		req = append(req, "expectedRevision", "versionId", "rehearsalId", "reason")
	case "control":
		req = append(req, "expectedRevision", "kind", "reason")
	case "rehearsal":
		req = append(req, "versionId", "executionIds")
	case "run":
		req = append(req, "strategyId", "executionId")
	case "continue":
		opt = []string{"confirmed", "inputDecision"}
	case "ordinary-draft":
		req = append(req, "expectedRevision", "strategyId")
		opt = []string{"parameterEdits", "mode", "enabled"}
	case "ordinary-create-draft":
		req = append(req, "expectedRevision", "sourceStrategyId", "sourceVersionId", "name", "reason")
		opt = []string{"parameterEdits", "mode", "enabled"}
	case "ordinary-publish":
		req = append(req, "expectedRevision", "strategyId", "versionId")
	default:
		return nil, invalid()
	}
	if !closed(input, req, opt) {
		return nil, invalid()
	}
	x := clone(input)
	for _, k := range []string{"operationId", "versionId", "rehearsalId", "strategyId", "executionId", "sourceStrategyId", "sourceVersionId"} {
		if v, ok := x[k]; ok && !uuidPattern.MatchString(str(v)) {
			return nil, invalid()
		}
	}
	if v, ok := x["expectedRevision"]; ok && !integer(v, 0, 9007199254740991) {
		return nil, invalid()
	}
	if v, ok := x["reason"]; ok {
		r, valid := boundedText(v, 2400)
		if !valid {
			return nil, invalid()
		}
		x["reason"] = r
	}
	if kind == "prepared-draft" && x["expectedDraftId"] != nil && !uuidPattern.MatchString(str(x["expectedDraftId"])) {
		return nil, invalid()
	}
	if kind == "draft" || kind == "prepared-draft" {
		c, e := ParseConfiguration(obj(x["configuration"]))
		if e != nil {
			return nil, e
		}
		x["configuration"] = c
	}
	if kind == "rehearsal" && !uuids(x["executionIds"], 0, 200) {
		return nil, invalid()
	}
	if kind == "control" && !has([]string{"pause", "resume"}, str(x["kind"])) {
		return nil, invalid()
	}
	if kind == "continue" {
		_, a := x["confirmed"]
		_, b := x["inputDecision"]
		if a == b {
			return nil, invalid()
		}
		if a {
			if _, ok := x["confirmed"].(bool); !ok {
				return nil, invalid()
			}
		}
		if b && !has([]string{"proceed", "no-action"}, str(x["inputDecision"])) {
			return nil, invalid()
		}
	}
	if kind == "ordinary-create-draft" {
		name, valid := boundedText(x["name"], 120)
		if !valid {
			return nil, invalid()
		}
		x["name"] = name
	}
	if kind == "ordinary-draft" || kind == "ordinary-create-draft" {
		if _, ok := x["parameterEdits"]; !ok {
			x["parameterEdits"] = []any{}
		}
		if !array(x["parameterEdits"]) || len(list(x["parameterEdits"])) > 30 {
			return nil, invalid()
		}
		for _, v := range list(x["parameterEdits"]) {
			e := obj(v)
			if !closed(e, []string{"path", "value"}, nil) || !path(e["path"]) || !integer(e["value"], 0, 9007199254740991) {
				return nil, invalid()
			}
		}
		_, mode := x["mode"]
		_, enabled := x["enabled"]
		if mode && !has(Modes, str(x["mode"])) {
			return nil, invalid()
		}
		if enabled {
			if _, ok := x["enabled"].(bool); !ok {
				return nil, invalid()
			}
		}
		if kind == "ordinary-draft" && len(list(x["parameterEdits"])) == 0 && !mode && !enabled {
			return nil, invalid()
		}
	}
	return x, nil
}
func ParsePage(input Object) (Object, error) {
	if !closed(input, nil, []string{"after", "limit", "strategyId"}) {
		return nil, invalid()
	}
	x := clone(input)
	if v, ok := x["strategyId"]; ok && !uuidPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, ok := x["after"]; ok && !regexp.MustCompile(`^[1-9][0-9]{0,18}$`).MatchString(str(v)) {
		return nil, invalid()
	}
	if _, ok := x["limit"]; !ok {
		x["limit"] = 20
	} else {
		f, e := coerceNumber(x["limit"])
		if e != nil {
			return nil, invalid()
		}
		x["limit"] = f
	}

	if !integer(x["limit"], 1, 50) {
		return nil, invalid()
	}
	return x, nil
}

func coerceNumber(v any) (float64, error) {
	switch n := v.(type) {
	case nil:
		return 0, nil
	case bool:
		if n {
			return 1, nil
		}
		return 0, nil
	case string:
		s := trim(n)
		if s == "" {
			return 0, nil
		}
		if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X" || s[:2] == "0b" || s[:2] == "0B" || s[:2] == "0o" || s[:2] == "0O") {
			i, e := strconv.ParseUint(s, 0, 64)
			return float64(i), e
		}
		return strconv.ParseFloat(s, 64)
	case float64:
		return n, nil
	case int:
		return float64(n), nil
	case int64:
		return float64(n), nil
	}
	if array(v) {
		a := list(v)
		if len(a) == 0 {
			return 0, nil
		}
		if len(a) == 1 {
			if _, ok := a[0].(bool); ok {
				return 0, invalid()
			}
			return coerceNumber(a[0])
		}
	}
	return 0, invalid()
}
