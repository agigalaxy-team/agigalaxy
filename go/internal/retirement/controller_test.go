package retirement

import (
	"encoding/json"
	"os"
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

func TestRetirementPolicyExactRoutesAndPhaseBoundaries(t *testing.T) {
	policy := samplePolicy()
	id, guid := "abcdefab-1234-4234-8234-123456789abc", "GUID15"+strings.Repeat("A", 26)
	// Independent expected route/phase cases include exact suffixes, method
	// restrictions, ID case and encoded-path refusals. No source-text scan.
	routes := []struct {
		method, path, access    string
		takeout, status, closed bool
	}{
		{"GET", "/v1/service-status", "", true, true, true},
		{"GET", "/v1/policy", "", true, true, true},
		{"GET", "/.well-known/galaxy-signing-keys.json", "", true, true, true},
		{"GET", "/v1/signing-keys/status", "", true, true, true},
		{"POST", "/v1/deletion-requests/status", "", true, true, true},
		{"GET", "/.well-known/galaxy-network.json", "", true, false, false},
		{"GET", "/v1/consents", "control", true, false, false},
		{"POST", "/v1/consents/" + id + "/revoke", "", true, false, false},
		{"POST", "/v1/consents/" + strings.ToUpper(id) + "/revoke", "", false, false, false},
		{"GET", "/v1/bindings/" + id, "control", true, false, false},
		{"GET", "/v1/bindings/%61" + id[1:], "", false, false, false},
		{"GET", "/v1/proofs/" + id + "/status", "", true, true, false},
		{"GET", "/v1/cases/" + id, "", true, false, false},
		{"GET", "/v1/profiles/" + guid, "", true, false, false},
		{"GET", "/v2/honor/" + guid + "/example/1.2.3", "read", true, false, false},
		{"GET", "/v2/identity/" + guid + "/control", "control", true, false, false},
		{"POST", "/v2/identity/control/challenges", "", false, false, false},
		{"POST", "/v2/identity/control/commit", "", false, false, false},
		{"POST", "/v2/identity/control/status", "control", true, false, false},
		{"POST", "/v2/identity/control/cancel", "control", true, false, false},
		{"POST", "/v2/chat/rooms/" + id + "/leave", "stop", true, false, false},
		{"POST", "/v2/chat/rooms/" + id + "/messages/" + id + "/hide", "stop", true, false, false},
		{"POST", "/v2/tasks/" + id + "/owner-control/prepare", "read", true, false, false},
		{"GET", "/v2/context/" + id + "/metadata", "read", true, false, false},
		{"POST", "/v2/chat/attachments/" + id + "/export-content", "read", true, false, false},
		{"POST", "/v2/community/attachments/" + id + "/content", "read", true, false, false},
		{"GET", "/v2/recruitment/" + id + "/receipt", "read", true, false, false},
		{"POST", "/v2/receipt-status/challenges", "control", true, true, false},
		{"POST", "/v2/receipt-status/query", "read", true, true, false},
		{"POST", "/v2/choice-snapshots/receipt", "read", true, true, false},
		{"POST", "/v2/community/posts/publish", "", false, false, false},
		{"GET", "/v1/consents/extra", "", false, false, false},
		{"OPTIONS", "/v1/service-status", "", false, false, false},
	}
	current := int64(0)
	controller, err := New(&policy, Options{Endpoint: policy.Endpoint, Now: func() time.Time { return time.Unix(current, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range routes {
		if got := ServiceAccessV2(route.method, route.path); got != route.access {
			t.Fatalf("route classification %s %s: %q want %q", route.method, route.path, got, route.access)
		}
	}
	for _, row := range []struct {
		at                int64
		phase             string
		writes, downloads bool
	}{
		{2000000000, "normal", true, true},
		{policy.AnnouncedAt, "announced", true, true},
		{policy.StopWritesAt, "takeout", false, true},
		{policy.TakeoutUntil - 1, "takeout", false, true},
		{policy.TakeoutUntil, "status-only", false, false},
		{policy.StatusUntil - 1, "status-only", false, false},
		{policy.StatusUntil, "closed", false, false},
	} {
		current = row.at
		expected := Snapshot{1, policy.Endpoint, row.phase, current, &policy, row.writes, row.downloads, "revocation is not physical deletion; follow the published deletion policy", "an unavailable status is not proof of validity or deletion", false}
		if !reflect.DeepEqual(controller.Snapshot(), expected) || controller.CanProcessEvidence() != row.writes {
			t.Fatalf("phase boundary %d: %+v", current, controller.Snapshot())
		}
		for _, route := range routes {
			allowed := row.writes || row.phase == "takeout" && route.takeout || row.phase == "status-only" && route.status || row.phase == "closed" && route.closed
			err := controller.AssertRoute(route.method, route.path)
			if allowed {
				if err != nil {
					t.Fatalf("allowed phase %s %s %s: %v", row.phase, route.method, route.path, err)
				}
			} else {
				code := "service_retired"
				if row.phase == "takeout" {
					code = "service_writes_stopped"
				}
				if fault.Code(err) != code || fault.Status(err) != 410 {
					t.Fatalf("closed phase %s %s %s: %v", row.phase, route.method, route.path, err)
				}
			}
		}
		err = controller.AssertDownload()
		if (err == nil) != row.downloads || err != nil && fault.Code(err) != "service_takeout_closed" || controller.DownloadDeadline() != float64(policy.TakeoutUntil) {
			t.Fatal("download phase/deadline", row.phase, err)
		}
	}
	data, _ := json.Marshal(policy)
	var valid map[string]any
	_ = json.Unmarshal(data, &valid)
	invalid := []map[string]any{}
	for _, key := range []string{"version", "id", "endpoint", "operator", "reason", "announcedAt", "stopWritesAt", "takeoutUntil", "statusUntil", "contactUrl", "deletionPolicyUrl", "newRule"} {
		copy := map[string]any{}
		for k, v := range valid {
			copy[k] = v
		}
		copy[key] = nil
		invalid = append(invalid, copy)
	}
	file := filepath.Join(t.TempDir(), "retirement.json")
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(file, Options{Endpoint: policy.Endpoint}); err != nil {
		t.Fatal(err)
	}
	for i, value := range invalid {
		raw, _ := json.Marshal(value)
		if err = os.WriteFile(file, raw, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = Load(file, Options{Endpoint: policy.Endpoint}); err == nil {
			t.Fatalf("invalid policy %d accepted", i)
		}
	}
	normal, err := Load("", Options{Endpoint: policy.Endpoint})
	if err != nil || normal.Phase() != "normal" || !normal.CanProcessEvidence() {
		t.Fatal("unconfigured policy changed normal runtime", err)
	}
}
