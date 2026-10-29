package managementaccounts

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type caseTransport struct{ mode string }

func (c caseTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("X-Fixture-Case", c.mode)
	return http.DefaultTransport.RoundTrip(r)
}
func TestOriginalNativeEmailVerificationSubmission(t *testing.T) {
	operationID := uuid.NewString()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		c := r.Header.Get("X-Fixture-Case")
		if r.Header.Get("X-Fixture-Original") == "" && r.Host != "management.example.invalid" {
			t.Error("native extension lost public Host")
		}
		if r.URL.Path == "/realms/galaxy-operations/protocol/openid-connect/token" {
			json.NewEncoder(w).Encode(Object{"access_token": "isolated-token", "expires_in": 300})
			return
		}
		if r.Method == "GET" {
			json.NewEncoder(w).Encode(Object{"version": 1, "available": c != "unavailable", "mode": "native-update-email", "verificationBeforeChange": true, "metadataOnly": true})
			return
		}
		var body Object
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["operationId"] != operationID || body["newEmail"] != "new@example.invalid" {
			t.Error("email submission changed selected target or operation")
		}
		if c == "invalid" {
			w.Write([]byte("invalid"))
			return
		}
		if c == "forbidden" {
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(Object{"code": "management_identity_write_forbidden"})
			return
		}
		if c == "server-error" {
			w.WriteHeader(503)
			json.NewEncoder(w).Encode(Object{})
			return
		}
		if c == "redirect" {
			w.Header().Set("Location", "https://never-follow.example.invalid")
			w.WriteHeader(302)
			return
		}
		status := 202
		if c == "unexpected" {
			status = 200
		}
		w.WriteHeader(status)
		state := "submitted"
		var code any
		if c == "unknown" {
			state = "unknown"
			code = "management_identity_submission_unknown"
		}
		json.NewEncoder(w).Encode(Object{"version": 1, "operationId": operationID, "state": state, "code": code, "metadataOnly": true, "expiresAt": 2000000030})
	}))
	defer provider.Close()
	cases := []string{"submitted", "unknown", "invalid", "forbidden", "server-error", "unexpected", "unavailable", "redirect"}

	goResults := []Object{}
	for _, c := range cases {
		adapter, e := NewNativeEmail("https://management.example.invalid/realms/galaxy-operations", provider.URL, &Credential{"galaxy-management-account-maintenance", "isolated-writer"}, caseTransport{c}, func() time.Time { return time.Unix(2000000000, 0) })
		if e != nil {
			t.Fatal(e)
		}
		available := adapter.Available(context.Background())
		result, e := adapter.Request(context.Background(), "human", "new@example.invalid", operationID, func() error { return nil })
		if e != nil {
			result = Object{"error": fault.Code(e)}
		}
		goResults = append(goResults, Object{"available": available, "result": result})
	}
	expectedStates := []string{"submitted", "unknown", "unknown", "failed", "unknown", "unknown", "", "unknown"}
	for i, result := range goResults {
		available := result["available"].(bool)
		body := result["result"].(Object)
		if cases[i] == "unavailable" {
			if available || body["error"] != "management_email_verification_not_configured" {
				t.Fatalf("%s: %v", cases[i], result)
			}
			continue
		}
		if !available || body["state"] != expectedStates[i] {
			t.Fatalf("%s: %v", cases[i], result)
		}
	}
}
