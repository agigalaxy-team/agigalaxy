package systemsettings

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestServiceAdoptionUsesActualBindingAndOriginalAtomicReceipt(t *testing.T) {
	ctx := context.Background()
	version := uuid.NewString()
	secret := strings.Repeat("x", 32)
	ids := map[string]string{}
	for _, kind := range serviceKinds {
		ids[kind] = uuid.NewString()
	}
	connections := []any{Object{"id": ids["analysis"], "kind": "analysis", "url": "https://analysis.example.invalid", "projectId": uuid.NewString(), "clientId": uuid.NewString(), "readClientId": uuid.NewString(), "credentialRef": "system-key:" + uuid.NewString()}, Object{"id": ids["recommendation"], "kind": "recommendation", "url": "https://recommend.example.invalid", "credentialRef": nil}, Object{"id": ids["search"], "kind": "search", "url": "https://search.example.invalid", "index": "original_index", "credentialRef": "system-key:" + uuid.NewString()}, Object{"id": ids["ai-execution"], "kind": "ai-execution", "url": "https://agentos.example.invalid", "credentialRef": "system-key:" + uuid.NewString()}, Object{"id": ids["file-scanning"], "kind": "file-scanning", "host": "127.0.0.1", "port": 3310, "timeoutMs": 30000}}
	analysis := obj(connections[0])
	actual := Object{"discoveryRuntime": Object{"openpanel": Object{"origin": analysis["url"], "projectId": analysis["projectId"], "headers": Object{"openpanel-client-id": analysis["clientId"], "openpanel-client-secret": secret}, "reader": Object{"origin": analysis["url"], "headers": Object{"openpanel-client-id": analysis["readClientId"], "openpanel-client-secret": secret}}}, "gorse": Object{"origin": "https://recommend.example.invalid", "headers": Object{"X-API-Key": secret}}, "meili": Object{"origin": "https://search.example.invalid", "index": "original_index", "headers": Object{"Authorization": "Bearer " + secret}}}, "agentOsClient": Object{"url": "https://agentos.example.invalid", "signingKey": secret, "serviceKey": secret}, "attachmentConfiguration": Object{"scanner": Object{"host": "127.0.0.1", "port": 3310, "timeoutMs": 30000}}}
	current := []any{Object{"id": ids["search"], "kind": "search", "credentialConfigured": true, "state": "available", "appliedVersionId": version}}
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	node := func(component string) Object {
		t.Helper()
		input := Object{"actual": actual, "component": component, "versionId": version, "connections": connections, "current": current}
		raw, _ := json.Marshal(input)
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/system-settings-interop.mjs"), "adoption")
		cmd.Dir = root
		cmd.Stdin = strings.NewReader(string(raw))
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("source readback %v %s", e, out)
		}
		var v Object
		if json.Unmarshal(out, &v) != nil {
			t.Fatal("invalid source readback")
		}
		return v
	}
	equal := func(a, b any) {
		t.Helper()
		normalize := func(v any) any { raw, _ := json.Marshal(v); var out any; json.Unmarshal(raw, &out); return out }
		if !reflect.DeepEqual(normalize(a), normalize(b)) {
			left, _ := json.Marshal(a)
			right, _ := json.Marshal(b)
			t.Fatalf("original adoption differed\nGo%s\nJS%s", left, right)
		}
	}
	calledAI := 0
	bound := func(_ context.Context, kind, id string) (Object, *bool, error) {
		if kind == "ai-execution" {
			calledAI++
		}
		for _, v := range connections {
			row := obj(v)
			if row["id"] == id && row["kind"] == kind {
				copy := clone(row)
				delete(copy, "credentialRef")
				if kind == "file-scanning" {
					return copy, nil, nil
				}
				configured := true
				return copy, &configured, nil
			}
		}
		return nil, nil, nil
	}
	options := AdoptionOptions{PID: 1234, Now: func() time.Time { return time.Unix(2000000000, 0) }}
	for _, component := range []string{"api", "worker"} {
		calledAI = 0
		value, e := CreateServiceConnectionReadback(ctx, component, version, connections, bound, options)
		if e != nil {
			t.Fatal(e)
		}
		expected := node(component)
		equal(value, expected["value"])
		adopted := []bool{}
		for _, v := range connections {
			adopted = append(adopted, ServiceConnectionAdopted(value, obj(v), version, component, 1234))
		}
		equal(adopted, expected["adopted"])
		description, e := DescribeServiceConnections(connections, current, 2000000000)
		if e != nil {
			t.Fatal(e)
		}
		equal(description, expected["described"])
		if component == "worker" && calledAI != 0 {
			t.Fatal("worker acquired AI execution consumer")
		}
		if ServiceConnectionAdopted(value, obj(connections[0]), version, component, 1235) {
			t.Fatal("stale process receipt accepted")
		}
	}
	dir := t.TempDir()
	metadata := filepath.Join(dir, "startup.json")
	raw, _ := json.Marshal(Object{"version": 1, "versionId": version, "connections": connections})
	if e := os.WriteFile(metadata, raw, 0600); e != nil {
		t.Fatal(e)
	}
	destination := filepath.Join(dir, "adopted.json")
	options.WriteReceipt = func(path string, value Object) error {
		if path != ServiceConnectionReceiptFiles["api"] {
			t.Fatal("request selected receipt destination")
		}
		return writeReceipt(destination, value)
	}
	result := ReportServiceConnectionAdoption(ctx, metadata, "api", bound, options)
	if result["state"] != "recorded" {
		t.Fatalf("atomic receipt %v", result)
	}
	b, e := os.ReadFile(destination)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), secret) {
		t.Fatal("credential escaped into adoption receipt")
	}
	var receipt Object
	json.Unmarshal(b, &receipt)
	if !ServiceConnectionAdopted(receipt, obj(connections[0]), version, "api", 1234) {
		t.Fatal("real receipt failed original binding gate")
	}
	different := func(ctx context.Context, kind, id string) (Object, *bool, error) {
		binding, configured, e := bound(ctx, kind, id)
		if kind == "search" {
			binding["url"] = "https://other.example.invalid"
		}
		return binding, configured, e
	}
	observed, e := CreateServiceConnectionReadback(ctx, "api", version, connections, different, options)
	if e != nil || ServiceConnectionAdopted(observed, obj(connections[2]), version, "api", 1234) {
		t.Fatal("submitted binding replaced actual runtime")
	}
	options.WriteReceipt = func(string, Object) error { return os.ErrPermission }
	if result = ReportServiceConnectionAdoption(ctx, metadata, "api", bound, options); result["state"] != "unavailable" {
		t.Fatal("receipt failure claimed adoption")
	}
	if result = ReportServiceConnectionAdoption(ctx, "", "api", bound, options); result["state"] != "not-configured" {
		t.Fatal("absent metadata acquired runtime adoption")
	}
}
