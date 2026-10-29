package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"strings"
	"testing"
)

func remoteFactsInputFixtures() []map[string]any {
	id := "00000000-0000-4000-8000-000000000001"
	subject := "GUID1000000000000000000000000000"
	hash := strings.Repeat("a", 64)
	signed := func() map[string]any { return map[string]any{"consentId": id, "payloadJson": " {\"original\": true} "} }
	items := []map[string]any{}
	add := func(name string, input map[string]any) {
		items = append(items, map[string]any{"name": name, "input": input})
	}
	taskSigned := func() map[string]any { value := signed(); value["taskId"] = id; return value }
	add("galaxy_tasks_v2_query", map[string]any{"query": "  original request "})
	add("galaxy_task_v2_get", map[string]any{"taskId": id})
	add("galaxy_task_material_prepare", map[string]any{"source": map[string]any{"postId": id, "versionId": id}, "selections": []any{map[string]any{"materialId": id, "field": "body", "start": 0, "end": 1}}, "expiresAt": int64(2000000000)})
	add("galaxy_task_material_status", map[string]any{"taskId": id})
	add("galaxy_task_v2_create", signed())
	add("galaxy_task_v2_event", taskSigned())
	add("galaxy_participation_v2_propose", taskSigned())
	value := signed()
	value["participationId"] = id
	add("galaxy_participation_v2_event", value)
	add("galaxy_task_v2_receipt", map[string]any{"taskId": id, "eventId": id, "payloadHash": hash})
	add("galaxy_task_v2_owner_read_prepare", map[string]any{"taskId": id, "operationId": id})
	add("galaxy_task_v2_owner_read", taskSigned())
	add("galaxy_task_v2_owner_control_prepare", map[string]any{"taskId": id, "operationId": id, "kind": "cancel", "reason": "  explicit cancellation  "})
	add("galaxy_task_v2_owner_control", taskSigned())
	add("galaxy_history_v2_query", map[string]any{"subjectId": subject, "query": "  real work  ", "context": map[string]any{"environment": "  environment  "}})
	add("galaxy_case_v2_submit", signed())
	add("galaxy_case_v2_receipt", map[string]any{"caseId": id, "eventId": id, "payloadHash": hash})
	add("galaxy_case_v2_read", map[string]any{"caseId": id})
	add("galaxy_intervention_responses_submit", map[string]any{"requests": []any{signed()}})
	add("galaxy_task_create_link_case", map[string]any{"operationId": id, "taskId": id, "expectedTaskVersion": 1, "case": signed(), "initialFact": signed()})
	add("galaxy_task_case_link_receipt", map[string]any{"operationId": id, "taskId": id, "payloadHash": hash})
	evidence := map[string]any{"id": id, "operationId": id, "expectedVersion": 0, "caseId": id, "reportedBy": subject, "synthetic": true, "kind": "evidence", "evidenceType": "self-assertion", "source": map[string]any{"originSystem": "fixture", "externalStableId": "original", "contentVersion": "1", "originalAt": "2033-05-18T03:33:20.000Z", "issuer": "own declaration"}, "observedAt": "2033-05-18T03:33:20.000Z", "reportedSourceState": "unknown", "summary": "Synthetic existing schema example"}
	value = signed()
	value["payloadJson"] = hostJSONString(evidence)
	add("galaxy_evidence_v2_submit", value)
	add("galaxy_verification_record_submit", signed())
	add("galaxy_verification_record_read", map[string]any{"type": "evidence", "id": id})
	add("galaxy_verification_record_receipt", map[string]any{"type": "evidence", "id": id, "operationId": id, "payloadHash": hash})
	add("galaxy_evidence_status", map[string]any{"refs": []any{map[string]any{"type": "evidence", "id": id}}})
	add("galaxy_project_v2_query", map[string]any{})
	add("galaxy_project_v2_get", map[string]any{"projectId": id})
	add("galaxy_project_v2_event", signed())
	add("galaxy_project_v2_preferences", map[string]any{"projectId": id})
	add("galaxy_project_v2_preferences_save", map[string]any{"projectId": id, "expectedRevision": 0, "preferences": map[string]any{"enabled": true, "functions": []any{"  bounded function  "}, "temporary": map[string]any{"until": int64(2000000000), "contact": "welcome"}}})
	return items
}
func TestRemoteFactsThirtyOriginalConsumersAndRefinements(t *testing.T) {
	cases := remoteFactsInputFixtures()
	original := nativeContractFixture(t)
	for index, item := range cases {
		name := text(item["name"])
		value, e := remoteFactsNormalize(name, item["input"])
		if e != nil || !connectionEqual(value, uploadRows(original["normalized"])[index]) {
			t.Fatalf("normalize differs %s: %v %v / %v", name, value, e, uploadRows(original["normalized"])[index])
		}
		request := remoteFactsRequest
		if remoteTaskSelected(name) {
			request = remoteTaskRequest
		}
		if strings.HasPrefix(name, "galaxy_project_v2_") {
			request = remoteProjectRequest
		}
		path, body, method, e := request(name, value)
		expected := uploadObject(uploadRows(original["calls"])[index])
		originalMethod := "POST"
		if uploadObject(expected["options"])["method"] == "GET" {
			originalMethod = "GET"
		}
		if e != nil || path != expected["path"] || !connectionEqual(body, expected["input"]) || method != originalMethod {
			t.Fatal("transport differs", name, path, body, method, e, expected)
		}
	}
	store, e := NewStore(t.TempDir(), "https://facts.invalid")
	if e != nil {
		t.Fatal(e)
	}
	runtime := commandRuntime(t, store)
	server := mcp.NewServer(&mcp.Implementation{Name: "facts", Version: "1"}, nil)
	tools := &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}
	registerRemoteFactsTools(server, tools, runtime)
	registerRemoteTaskTools(server, tools, runtime)
	registerRemoteProjectTools(server, tools, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(context.Background(), st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "facts", Version: "1"}, nil)
	session, e := client.Connect(context.Background(), ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	registered, e := session.ListTools(context.Background(), nil)
	if e != nil || len(registered.Tools) != 30 {
		t.Fatal("incomplete consumer batch", e)
	}
	id := "00000000-0000-4000-8000-000000000001"
	materialCall(t, session, "galaxy_task_v2_create", map[string]any{"consentId": id, "payloadJson": "{}", "signedIntent": "cannot mix variants"}, true)
	materialCall(t, session, "galaxy_task_v2_owner_control_prepare", map[string]any{"taskId": id, "operationId": id, "kind": "close", "reason": " "}, true)
	materialCall(t, session, "galaxy_task_material_prepare", map[string]any{"source": map[string]any{"postId": id, "versionId": id}, "selections": []any{map[string]any{"materialId": id, "field": "body", "start": 1, "end": 1}}, "expiresAt": 2000000000}, true)
	for _, input := range []map[string]any{{"subjectId": "GUID1000000000000000000000000000", "query": "1 2 3 4 5 6 7 8 9"}, {"subjectId": "GUID1000000000000000000000000000", "timeWindow": map[string]any{"kind": "custom", "from": "2033-05-18T03:33:20.000001Z", "before": "2033-05-18T03:33:20.000002Z"}}} {
		if _, e = remoteFactsNormalize("galaxy_history_v2_query", input); e == nil {
			t.Fatal("original history refinement ignored")
		}
	}
}
