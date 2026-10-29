package operationsmodels

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func normalize(v any) any { b, _ := json.Marshal(v); var o any; _ = json.Unmarshal(b, &o); return o }
func sampleConfiguration() Object {
	id := "11111111-1111-4111-8111-111111111111"
	m := Object{"id": id, "displayName": " 手动😀 ", "modelId": "original-model", "apiFormat": "openai-responses", "baseUrl": " https://provider.example.invalid/custom/responses ", "credentialRef": "model-key:22222222-2222-4222-8222-222222222222", "contextWindow": 1000, "maxOutputTokens": 128, "timeoutSeconds": 60, "reasoning": Object{"mode": "effort", "effort": "medium", "supportedEfforts": []string{"medium"}, "supportSource": "manual"}, "toolCalling": true, "structuredOutput": true, "enabled": true}
	c := EmptyConfiguration()
	c["models"] = []any{m}
	obj(c["scenarios"])["overview"] = Object{"modelId": id, "dataPolicyApproved": true}
	return c
}
func sampleStatus() Object {
	return Object{"availability": Object{"state": "available"}, "configurationVersion": "original-v1", "appliedVersionId": nil, "engines": Object{"gateway": Object{"state": "ready", "configurationVersion": "original-v1", "modelCount": 1}, "agentos": Object{"state": "running", "configurationVersion": "original-v1", "configuredScenarios": []string{"overview"}}}, "credentials": []any{Object{"reference": "model-key:22222222-2222-4222-8222-222222222222", "modelRecordId": "11111111-1111-4111-8111-111111111111", "configured": true}}}
}
func TestOriginalModelsSchemaAndNativeUnknownProjection(t *testing.T) {
	c := sampleConfiguration()
	models := []Object{c, EmptyConfiguration()}
	for k, v := range (Object{"displayName": strings.Repeat("😀", 101), "baseUrl": "http://127.1/v1", "contextWindow": 128, "maxOutputTokens": 15, "parallelToolCalls": true, "verbosity": "high"}) {
		m := clone(obj(list(c["models"])[0]))
		m[k] = v
		x := clone(c)
		x["models"] = []any{m}
		models = append(models, x)
	}
	sort.Slice(models, func(i, j int) bool {
		a, _ := json.Marshal(models[i])
		b, _ := json.Marshal(models[j])
		return string(a) < string(b)
	})
	id := "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
	status := sampleStatus()
	usage := Object{"availability": Object{"state": "available"}, "days": 7, "calls": Object{"total": 2, "completed": 1, "failed": 0, "unknown": 1}, "tokens": Object{"input": 12, "output": nil, "total": nil, "cachedInput": 0, "reasoning": nil}, "byScenario": []any{}, "byModel": []any{}, "unknownUsageCalls": 1, "from": "2033-05-18T00:00:00Z", "to": nil, "coverageFrom": nil, "coversWholeWindow": false}
	input := Object{"configuration": models, "applicable": models, "draft": []Object{{"operationId": id, "expectedRevision": 0, "configuration": c, "reason": strings.Repeat("😀", 500)}, {"operationId": id, "expectedRevision": 0, "configuration": c, "reason": strings.Repeat("😀", 501)}}, "credential": []Object{{"operationId": id, "modelRecordId": id, "apiKey": "isolated-secret"}, {"operationId": id, "modelRecordId": id, "apiKey": " spaced "}}, "history": []Object{{}, {"after": "9223372036854775808"}, {"after": "9223372036854775807", "limit": 50}, {"limit": "20"}}, "usage": []Object{{}, {"days": 30}, {"days": "7"}}, "command": []Object{{"kind": "models-overview"}, {"kind": "models-apply", "operationId": id, "operatorId": strings.Repeat("😀", 500), "versionId": id, "revision": 0, "configuration": c}}, "status": []Object{status, {}, clone(status)}, "operation": []Object{{"id": id, "kind": "models-apply", "state": "completed", "code": "unexpected_private", "startedAt": "invalid", "finishedAt": nil}, {}}, "nativeUsage": []Object{usage, {}}, "nativeCredential": []Object{{"reference": "model-key:22222222-2222-4222-8222-222222222222", "modelRecordId": id, "configured": true}}}
	obj(list(input["status"])[2])["credentials"] = []any{Object{"configured": true}}
	raw, e := os.ReadFile("testdata/models-schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected Object
	_ = json.Unmarshal(raw, &expected)
	actual := Object{}
	parsers := map[string]func(Object) (Object, error){"configuration": ParseConfiguration, "draft": func(v Object) (Object, error) { return ParseCommand("draft", v) }, "apply": func(v Object) (Object, error) { return ParseCommand("apply", v) }, "credential": func(v Object) (Object, error) { return ParseCommand("credential-provision", v) }, "history": func(v Object) (Object, error) { return ParseQuery("history", v) }, "usage": func(v Object) (Object, error) { return ParseQuery("usage", v) }, "command": func(v Object) (Object, error) { return ParseNativeCommand(v, false) }, "authorization": func(v Object) (Object, error) { return ParseNativeCommand(v, true) }, "status": ProjectStatus, "operation": ProjectOperation, "nativeUsage": ProjectUsage, "nativeCredential": ProjectCredential}
	for k, f := range parsers {
		rows := []any{}
		for _, v := range list(input[k]) {
			o, e := f(obj(v))
			if e != nil {
				rows = append(rows, nil)
			} else {
				rows = append(rows, o)
			}
		}
		actual[k] = rows
	}
	rows := []any{}
	for _, v := range models {
		o, e := AssertApplicable(v)
		if e != nil {
			rows = append(rows, Object{"error": fault.Code(e)})
		} else {
			rows = append(rows, o)
		}
	}
	actual["applicable"] = rows
	for k, v := range actual {
		if !reflect.DeepEqual(normalize(v), expected[k]) {
			a, _ := json.Marshal(v)
			b, _ := json.Marshal(expected[k])
			t.Errorf("%s\nGo%s\nJS%s", k, a, b)
		}
	}
}
