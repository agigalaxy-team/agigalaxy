package operationsstrategies

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func normalized(v any) any { b, _ := json.Marshal(v); var x any; _ = json.Unmarshal(b, &x); return x }
func sampleConfig() Object {
	c := EmptyConfiguration()
	obj(c["common"])["objective"] = " 共同目标 "
	obj(c["common"])["automationEnabled"] = true
	for _, v := range list(c["domains"]) {
		obj(v)["objective"] = "领域目标"
		obj(v)["executionEnabled"] = true
	}
	s := Object{"id": "11111111-1111-4111-8111-111111111111", "name": " 日常参数 ", "domain": "governance", "objective": "原目标", "enabled": false, "mode": "code-automatic", "template": "analysis-only", "judgment": "prepared-command", "instructions": nil, "condition": Object{"combinator": "and", "rules": []any{Object{"field": "textLength", "operator": "gte", "value": 10}}}, "ordinaryBounds": Object{"parameters": []any{Object{"path": []int{0}, "minimum": 5, "maximum": 20}}, "modes": []string{"code-automatic", "ai-autonomous"}, "canEnable": true, "canDisable": true}, "recovery": Object{"versionId": nil, "conditions": []any{}}}
	c["strategies"] = []any{s}
	return c
}
func TestOriginalStrategiesSchemaConditionsAndOrdinaryBounds(t *testing.T) {
	c := sampleConfig()
	configurations := []Object{c, EmptyConfiguration()}
	for k, v := range (Object{"name": strings.Repeat("😀", 121), "condition": Object{"combinator": "and", "rules": []any{Object{"field": "accountTier", "operator": "eq", "value": "new"}}}, "ordinaryBounds": Object{"parameters": []any{Object{"path": []int{1}, "minimum": 5, "maximum": 20}}, "modes": []any{}, "canEnable": true, "canDisable": true}, "execution": Object{}}) {
		x := deepClone(c)
		obj(list(x["strategies"])[0])[k] = v
		configurations = append(configurations, x)
	}
	group := Object{"combinator": "and", "rules": []any{Object{"field": "textLength", "operator": "gte", "value": 1}}}
	for range 7 {
		group = Object{"combinator": "or", "rules": []any{group}}
	}
	tooDeep := deepClone(c)
	obj(list(tooDeep["strategies"])[0])["condition"] = group
	obj(list(tooDeep["strategies"])[0])["ordinaryBounds"] = nil
	configurations = append(configurations, tooDeep)
	sort.Slice(configurations, func(i, j int) bool {
		a, _ := json.Marshal(configurations[i])
		b, _ := json.Marshal(configurations[j])
		return string(a) < string(b)
	})
	id := "11111111-1111-4111-8111-111111111111"
	base := Object{"configuration": c, "input": Object{"strategyId": id, "parameterEdits": []any{Object{"path": []int{0}, "value": 20}}}}
	invalidBound := deepClone(base)
	obj(list(obj(invalidBound["input"])["parameterEdits"])[0])["value"] = 21
	input := Object{"configuration": configurations, "draft": []Object{{"operationId": id, "expectedRevision": 0, "configuration": c, "reason": strings.Repeat("😀", 2400)}, {"operationId": id, "expectedRevision": 0, "configuration": c, "reason": strings.Repeat("😀", 2401)}}, "rehearsal": []Object{{"operationId": id, "versionId": id, "executionIds": []any{}}}, "continue": []Object{{"operationId": id, "confirmed": false}, {"operationId": id, "confirmed": true, "inputDecision": "proceed"}}, "ordinaryDraft": []Object{{"operationId": id, "expectedRevision": 0, "strategyId": id, "enabled": false}, {"operationId": id, "expectedRevision": 0, "strategyId": id}}, "page": []Object{{}, {"limit": "0x10"}, {"limit": true}, {"limit": []any{2}}}, "ordinary": []Object{base, invalidBound}, "classify": []Object{}}
	strategy := obj(list(c["strategies"])[0])
	strategy = clone(strategy)
	strategy["enabled"], strategy["template"] = true, "selected-public-content-visibility"
	for _, state := range []string{"hit", "miss", "unknown"} {
		input["classify"] = append(input["classify"].([]Object), Object{"configuration": c, "strategy": strategy, "facts": Object{"authorized": true, "sourceAvailable": true, "casMatches": true, "temporalAllowed": true, "independent": true, "conditionState": state}})
	}
	native := Object{"runId": "native-run", "status": "PAUSED", "awaitingHuman": true, "workflowId": WorkflowID, "workflowVersion": 1, "pauseId": "native-run:1", "pauseKind": "confirmation", "steps": []any{Object{"name": nativeStepNames[0], "type": strings.Repeat("😀", 30), "success": true}}, "privateProse": "must be stripped"}
	badNative := deepClone(native)
	obj(list(badNative["steps"])[0])["type"] = strings.Repeat("😀", 31)
	input["nativeMetadata"] = []Object{native, badNative, {"runId": nil, "status": "NOT_RECORDED", "awaitingHuman": false, "workflowId": WorkflowID, "workflowVersion": 1}}
	b, e := os.ReadFile("testdata/strategies-schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected Object
	_ = json.Unmarshal(b, &expected)
	actual := Object{}
	for _, kind := range []string{"draft", "publish", "control", "rehearsal", "run", "continue", "ordinaryDraft", "ordinaryPublish"} {
		rows := []any{}
		parseKind := kind
		if kind == "ordinaryDraft" {
			parseKind = "ordinary-draft"
		}
		if kind == "ordinaryPublish" {
			parseKind = "ordinary-publish"
		}
		for _, v := range list(input[kind]) {
			out, e := ParseCommand(parseKind, obj(v))
			if e != nil {
				rows = append(rows, nil)
			} else {
				rows = append(rows, out)
			}
		}
		actual[kind] = rows
	}
	for k, f := range map[string]func(Object) (Object, error){"configuration": ParseConfiguration, "page": ParsePage, "nativeMetadata": ProjectNativeRun} {
		rows := []any{}
		for _, v := range list(input[k]) {
			out, e := f(obj(v))
			if e != nil {
				rows = append(rows, nil)
			} else {
				rows = append(rows, out)
			}
		}
		actual[k] = rows
	}
	ordinary := []any{}
	for _, v := range list(input["ordinary"]) {
		x := obj(v)
		out, e := OrdinaryChanges(obj(x["configuration"]), obj(x["input"]))
		if e != nil {
			ordinary = append(ordinary, Object{"error": fault.Code(e)})
		} else {
			ordinary = append(ordinary, out)
		}
	}
	actual["ordinary"] = ordinary
	classification := []any{}
	for _, v := range list(input["classify"]) {
		x := obj(v)
		classification = append(classification, Classify(obj(x["configuration"]), obj(x["strategy"]), obj(x["facts"])))
	}
	actual["classify"] = classification
	for k, v := range actual {
		if !reflect.DeepEqual(normalized(v), expected[k]) {
			a, _ := json.Marshal(v)
			b, _ := json.Marshal(expected[k])
			t.Errorf("%s\nGo%s\nJS%s", k, a, b)
		}
	}
}
