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
	row := Conversation{ID: uuid.NewString(), SessionID: uuid.NewString(), Domain: "overview"}
	command := &conversationCommand{ID: uuid.NewString(), Result: Object{"runId": "owned-native-run"}}
	for _, mode := range []string{"current", "forbidden", "missing", "not-recorded", "unknown", "wrong-conversation", "wrong-session", "wrong-operation", "wrong-run", "wrong-native-operation", "legacy"} {
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
					case "unknown":
						value["state"], value["native"] = "unknown", nil
					case "wrong-conversation":
						value["conversationId"] = uuid.NewString()
					case "wrong-session":
						value["sessionId"] = uuid.NewString()
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
			value, err := (&Conversations{Client: client}).nativeOperation(context.Background(), row, command)
			switch {
			case mode == "forbidden":
				if fault.Status(err) != 403 {
					t.Fatal("current denial was hidden", value, err)
				}
			case strings.HasPrefix(mode, "wrong-"):
				if err == nil {
					t.Fatal("foreign original context was accepted", value)
				}
			case mode == "missing" || mode == "not-recorded":
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
			if writes != 0 || mode != "legacy" && (history != 0 || original != 1) || mode == "legacy" && (history != 1 || original != 0) {
				t.Fatal("read transport scanned history or issued a command", mode, history, original, writes)
			}
		})
	}
}
