package retirement

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func samplePolicy() Policy {
	return Policy{1, "isolated-retirement", "https://device.example.invalid", "Synthetic operator", "Controlled original retirement policy", 2000000010, 2000000020, 2000000120, 2000000180, "https://device.example.invalid/contact", "https://device.example.invalid/deletion"}
}
func TestOriginalRetirementPolicyAndExactRouteParity(t *testing.T) {
	policy := samplePolicy()
	uuid := "11111111-1111-4111-8111-111111111111"
	guid := "GUID15" + strings.Repeat("A", 26)
	routes := []map[string]string{}
	for _, method := range []string{"GET", "POST", "OPTIONS"} {
		for _, path := range []string{"/v1/service-status", "/v1/policy", "/.well-known/galaxy-signing-keys.json", "/v1/signing-keys/status", "/v1/deletion-requests/status", "/.well-known/galaxy-network.json", "/v1/consents", "/v1/consents/" + uuid + "/revoke", "/v1/bindings/" + uuid, "/v1/bindings/" + uuid + "/revoke", "/v1/proofs/" + uuid + "/status", "/v1/cases/" + uuid, "/v1/profiles/" + guid, "/v1/honor/" + guid + "/example/1.2.3", "/v2/honor/" + guid + "/example/1.2.3", "/v2/identity/" + guid + "/control", "/v2/identity/control/challenges", "/v2/identity/control/commit", "/v2/identity/control/status", "/v2/identity/control/cancel", "/v1/consents/extra", "/v2/chat/rooms/" + uuid + "/leave", "/v2/chat/rooms/" + uuid + "/messages/" + uuid + "/hide", "/v2/tasks/" + uuid + "/owner-control/prepare", "/v2/context/" + uuid + "/metadata", "/v2/chat/attachments/" + uuid + "/export-content", "/v2/chat/attachments/" + uuid + "/content", "/v2/community/attachments/" + uuid + "/content", "/v2/recruitment/" + uuid + "/receipt", "/v1/consents/" + strings.ToUpper(uuid) + "/revoke", "/v1/bindings/%31" + uuid[1:]} {
			routes = append(routes, map[string]string{"method": method, "path": path})
		}
	}
	times := []int64{2000000000, policy.AnnouncedAt, policy.StopWritesAt, policy.TakeoutUntil - 1, policy.TakeoutUntil, policy.StatusUntil - 1, policy.StatusUntil}
	var validMap map[string]any
	data, _ := json.Marshal(policy)
	_ = json.Unmarshal(data, &validMap)
	invalidPolicies := []map[string]any{}
	for _, key := range []string{"version", "operator", "reason", "announcedAt", "stopWritesAt", "takeoutUntil", "statusUntil", "contactUrl", "deletionPolicyUrl"} {
		copy := map[string]any{}
		for k, v := range validMap {
			copy[k] = v
		}
		copy[key] = nil
		invalidPolicies = append(invalidPolicies, copy)
	}
	extra := map[string]any{}
	for k, v := range validMap {
		extra[k] = v
	}
	extra["newRule"] = true
	invalidPolicies = append(invalidPolicies, extra)
	input, _ := json.Marshal(map[string]any{"endpoint": policy.Endpoint, "policy": policy, "routes": routes, "times": times, "invalidPolicies": invalidPolicies})
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/retirement-interop.mjs"))
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(input))
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS oracle: %v %s", e, output)
	}
	var oracle struct {
		Routes []struct {
			Method, Path string
			Access       *string
		}
		Observations []struct {
			At               int64
			Snapshot         json.RawMessage
			Gate             []*string
			DownloadCode     *string
			DownloadDeadline *float64
		}
		Validations []bool
	}
	if e = json.Unmarshal(output, &oracle); e != nil {
		t.Fatal(e)
	}
	current := int64(0)
	controller, e := New(&policy, Options{Endpoint: policy.Endpoint, Now: func() time.Time { return time.Unix(current, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	for i, r := range oracle.Routes {
		got := ServiceAccessV2(r.Method, r.Path)
		want := ""
		if r.Access != nil {
			want = *r.Access
		}
		if got != want {
			t.Errorf("classification %d %s %s: %q want %q", i, r.Method, r.Path, got, want)
		}
	}
	for _, observation := range oracle.Observations {
		current = observation.At
		snapshot, _ := json.Marshal(controller.Snapshot())
		var got, want any
		_ = json.Unmarshal(snapshot, &got)
		_ = json.Unmarshal(observation.Snapshot, &want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("snapshot at %d differs\nGo %s\nJS %s", current, snapshot, observation.Snapshot)
		}
		for i, r := range oracle.Routes {
			code := fault.Code(controller.AssertRoute(r.Method, r.Path))
			if code == "internal_error" {
				code = ""
			}
			expected := ""
			if observation.Gate[i] != nil {
				expected = *observation.Gate[i]
			}
			if code != expected {
				t.Fatalf("phase=%s %s %s got=%s want=%s", controller.Phase(), r.Method, r.Path, code, expected)
			}
		}
		code := ""
		if e = controller.AssertDownload(); e != nil {
			code = fault.Code(e)
		}
		wantCode := ""
		if observation.DownloadCode != nil {
			wantCode = *observation.DownloadCode
		}
		if code != wantCode || controller.DownloadDeadline() != *observation.DownloadDeadline {
			t.Fatal("download lifecycle differs from original")
		}
	}
	directory := t.TempDir()
	file := filepath.Join(directory, "retirement.json")
	if e = os.WriteFile(file, data, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = Load(file, Options{Endpoint: policy.Endpoint}); e != nil {
		t.Fatal(e)
	}
	for i, value := range invalidPolicies {
		if oracle.Validations[i] {
			t.Fatal("original invalid policy fixture unexpectedly accepted")
		}
		raw, _ := json.Marshal(value)
		if e = os.WriteFile(file, raw, 0600); e != nil {
			t.Fatal(e)
		}
		if _, e = Load(file, Options{Endpoint: policy.Endpoint}); e == nil {
			t.Fatalf("invalid policy %d accepted", i)
		}
	}
	normal, e := Load("", Options{Endpoint: policy.Endpoint})
	if e != nil || normal.Phase() != "normal" || !normal.CanProcessEvidence() {
		t.Fatal("unconfigured policy changed normal runtime")
	}
	t.Logf("original parity: %d exact route/method cases across %d timeline observations", len(oracle.Routes), len(oracle.Observations))
}
