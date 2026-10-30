package agentos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

func TestNativeOperationExactLookupPrecedesHistory(t *testing.T) {
	row := Conversation{ID: uuid.NewString(), SessionID: uuid.NewString(), Domain: "overview", OperatorID: "original-operator"}
	command := &conversationCommand{ID: uuid.NewString(), ConversationID: row.ID, OperatorID: row.OperatorID, Domain: row.Domain, Result: Object{"runId": "owned-native-run"}}
	for _, mode := range []string{"current", "forbidden", "missing", "not-recorded", "unknown", "wrong-conversation", "wrong-session", "wrong-operation", "wrong-missing-conversation", "wrong-missing-session", "wrong-run", "wrong-native-operation", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			history, original, writes := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method != "GET" {
					writes++
					w.WriteHeader(405)
					return
				}
				switch r.URL.Path {
				case "/health":
					flag := 1
					if mode == "legacy" {
						flag = 0
					}
					_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "conversations": Object{"version": 2, "transport": Object{"originalRunLookup": flag}}})
				case "/galaxy/conversations/" + row.ID:
					history++
					_ = json.NewEncoder(w).Encode(Object{"runs": []Object{{"runId": "owned-native-run", "operationId": command.ID, "status": "RUNNING"}}})
				case "/galaxy/conversations/" + row.ID + "/operations/" + command.ID:
					original++
					if mode == "forbidden" || mode == "missing" {
						status := 403
						if mode == "missing" {
							status = 404
						}
						w.WriteHeader(status)
						_ = json.NewEncoder(w).Encode(Object{"error": "synthetic-native-lookup"})
						return
					}
					native := Object{"runId": "owned-native-run", "operationId": command.ID, "status": "RUNNING"}
					value := Object{"conversationId": row.ID, "sessionId": row.SessionID, "operationId": command.ID, "runId": "owned-native-run", "state": "RUNNING", "native": native}
					switch mode {
					case "not-recorded":
						value["runId"], value["state"], value["native"] = nil, "not-recorded", nil
					case "unknown-no-run":
						value["runId"], value["state"], value["native"] = nil, "unknown", nil
					case "wrong-parent":
						native["regeneratedFrom"] = "foreign-parent-run"
					case "missing-parent":
						delete(native, "regeneratedFrom")
					case "unknown":
						value["state"], value["native"] = "unknown", nil
					case "wrong-conversation":
						value["conversationId"] = uuid.NewString()
					case "wrong-session":
						value["sessionId"] = uuid.NewString()
					case "wrong-missing-conversation":
						delete(value, "conversationId")
					case "wrong-missing-session":
						delete(value, "sessionId")
					case "wrong-operation":
						value["operationId"] = uuid.NewString()
					case "wrong-run":
						value["runId"] = "another-native-run"
					case "wrong-native-operation":
						native["operationId"] = uuid.NewString()
					}
					_ = json.NewEncoder(w).Encode(value)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			client, err := New(Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32)}, Options{})
			if err != nil {
				t.Fatal(err)
			}
			local := *command
			local.Result = copyObject(command.Result)
			if mode == "legacy" {
				delete(local.Result, "runId")
			}
			value, err := (&Conversations{Client: client}).nativeOperation(context.Background(), row, &local)
			switch {
			case mode == "forbidden":
				if fault.Status(err) != 403 {
					t.Fatal("current denial was hidden", value, err)
				}
			case strings.HasPrefix(mode, "wrong-"):
				if err == nil {
					t.Fatal("foreign original context was accepted", value)
				}
			case mode == "missing" || mode == "not-recorded" || mode == "legacy":
				if err != nil || value != nil {
					t.Fatal("missing original was not retained as uncertain", value, err)
				}
			case mode == "unknown":
				if err != nil || value["status"] != "unknown" {
					t.Fatal("unknown original was reclassified", value, err)
				}
			default:
				if err != nil || value["runId"] != "owned-native-run" || value["operationId"] != command.ID {
					t.Fatal("original read failed", value, err)
				}
			}
			if writes != 0 || mode != "legacy" && (history != 0 || original != 1) || mode == "legacy" && (history != 0 || original != 0) {
				t.Fatal("read transport scanned history or issued a command", mode, history, original, writes)
			}
		})
	}
}

func TestNativeOperationStoredLocatorAndRetryBinding(t *testing.T) {
	row := Conversation{ID: uuid.NewString(), SessionID: uuid.NewString(), Domain: "overview", OperatorID: "original-operator"}
	operationID, parentID := uuid.NewString(), uuid.NewString()
	runID, parentRunID := "detached-native-run", "prior-native-run"
	invalidRun := "bad/run"
	tests := []struct {
		name, responseMode  string
		nativeRunID         *string
		result              Object
		query               string
		wantError           bool
		wantOriginal        int
		foreignOwner        bool
		foreignConversation bool
	}{
		{name: "detached retry", nativeRunID: &runID, result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID + "&runId=" + runID, wantOriginal: 1},
		{name: "ordinary stored run", nativeRunID: &runID, result: Object{}, query: "runId=" + runID, wantOriginal: 1},
		{name: "unacknowledged retry lookup unknown", result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID, responseMode: "unknown-no-run", wantOriginal: 1},
		{name: "unacknowledged retry recovers detached run", result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID, wantOriginal: 1},
		{name: "unacknowledged retry wrong parent rejected", result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID, responseMode: "wrong-parent", wantOriginal: 1, wantError: true},
		{name: "unacknowledged retry missing parent rejected", result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID, responseMode: "missing-parent", wantOriginal: 1, wantError: true},
		{name: "unacknowledged retry lacks native proof", result: Object{"retryOfOperationId": parentID, "retryOfRunId": parentRunID}, query: "retryOfOperationId=" + parentID + "&retryOfRunId=" + parentRunID, responseMode: "unknown", wantOriginal: 1, wantError: true},
		{name: "ordinary unacknowledged lookup has no locator", responseMode: "unknown-no-run", wantOriginal: 1},
		{name: "unacknowledged retry incomplete lineage rejected", result: Object{"retryOfOperationId": parentID}, wantError: true},
		{name: "unacknowledged self retry rejected", result: Object{"retryOfOperationId": operationID, "retryOfRunId": parentRunID}, wantError: true},
		{name: "result run alone is not a native locator", result: Object{"runId": runID}, wantOriginal: 1},
		{name: "known but unavailable remains unknown", nativeRunID: &runID, responseMode: "unknown", query: "runId=" + runID, wantOriginal: 1},
		{name: "known run mismatch rejected", nativeRunID: &runID, responseMode: "wrong-run", query: "runId=" + runID, wantOriginal: 1, wantError: true},
		{name: "known run missing rejected", nativeRunID: &runID, responseMode: "missing-run", query: "runId=" + runID, wantOriginal: 1, wantError: true},
		{name: "incomplete retry lineage rejected", nativeRunID: &runID, result: Object{"retryOfOperationId": parentID}, wantError: true},
		{name: "invalid parent operation rejected", nativeRunID: &runID, result: Object{"retryOfOperationId": "not-a-uuid", "retryOfRunId": parentRunID}, wantError: true},
		{name: "self retry parent rejected", nativeRunID: &runID, result: Object{"retryOfOperationId": operationID, "retryOfRunId": parentRunID}, wantError: true},
		{name: "invalid parent run rejected", nativeRunID: &runID, result: Object{"retryOfOperationId": parentID, "retryOfRunId": invalidRun}, wantError: true},
		{name: "malformed retry lineage rejected", nativeRunID: &runID, result: Object{"retryOfOperationId": 7, "retryOfRunId": nil}, wantError: true},
		{name: "invalid persisted native run rejected", nativeRunID: &invalidRun, wantError: true},
		{name: "foreign command owner rejected", nativeRunID: &runID, foreignOwner: true, wantError: true},
		{name: "foreign command conversation rejected", nativeRunID: &runID, foreignConversation: true, wantError: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			original, history, writes := 0, 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method != http.MethodGet {
					writes++
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				switch r.URL.Path {
				case "/health":
					_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "conversations": Object{"version": 2, "transport": Object{"originalRunLookup": 1}}})
				case "/galaxy/conversations/" + row.ID:
					history++
					_ = json.NewEncoder(w).Encode(Object{"runs": []any{}})
				case "/galaxy/conversations/" + row.ID + "/operations/" + operationID:
					original++
					if r.URL.RawQuery != tc.query {
						t.Errorf("stored locator query mismatch: got %q want %q", r.URL.RawQuery, tc.query)
					}
					native := Object{"runId": runID, "operationId": operationID, "status": "ERROR", "content": "native retry result"}
					if parent, ok := tc.result["retryOfRunId"].(string); ok {
						native["regeneratedFrom"] = parent
					}
					value := Object{"conversationId": row.ID, "sessionId": row.SessionID, "operationId": operationID, "runId": runID, "state": "ERROR", "native": native}
					switch tc.responseMode {
					case "not-recorded":
						value["runId"], value["state"], value["native"] = nil, "not-recorded", nil
					case "unknown-no-run":
						value["runId"], value["state"], value["native"] = nil, "unknown", nil
					case "wrong-parent":
						native["regeneratedFrom"] = "foreign-parent-run"
					case "missing-parent":
						delete(native, "regeneratedFrom")
					case "unknown":
						value["state"], value["native"] = "unknown", nil
					case "wrong-run":
						value["runId"] = "foreign-run"
					case "missing-run":
						value["runId"], value["state"], value["native"] = nil, "not-recorded", nil
					}
					_ = json.NewEncoder(w).Encode(value)
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			client, err := New(Configuration{URL: server.URL, SigningKey: strings.Repeat("s", 32)}, Options{})
			if err != nil {
				t.Fatal(err)
			}
			command := &conversationCommand{ID: operationID, ConversationID: row.ID, OperatorID: row.OperatorID, Domain: row.Domain, NativeRunID: tc.nativeRunID, Result: tc.result}
			if tc.foreignOwner {
				command.OperatorID = "different-operator"
			}
			if tc.foreignConversation {
				command.ConversationID = uuid.NewString()
			}
			value, err := (&Conversations{Client: client}).nativeOperation(context.Background(), row, command)
			if (err != nil) != tc.wantError {
				t.Fatalf("unexpected locator result: value=%v error=%v", value, err)
			}
			if !tc.wantError && (tc.responseMode == "not-recorded" || tc.responseMode == "unknown-no-run") && value != nil {
				t.Fatal("unacknowledged job was not preserved as unknown", value)
			}
			if !tc.wantError && tc.responseMode == "unknown" && (value == nil || value["status"] != "unknown") {
				t.Fatal("unavailable stored run must remain unknown", value)
			}
			if !tc.wantError && tc.responseMode == "" && (value == nil || value["runId"] != runID || value["operationId"] != operationID || value["status"] != "ERROR") {
				t.Fatal("bound original run was not recovered", value)
			}
			if original != tc.wantOriginal || history != 0 || writes != 0 {
				t.Fatalf("unexpected reads or writes: original=%d history=%d writes=%d", original, history, writes)
			}
		})
	}
}
