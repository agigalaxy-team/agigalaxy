package attachments

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExistingProtectedAttachmentConfiguration(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "galaxy-attachments.json")
	if x, e := LoadConfiguration("", ""); e != nil || x != nil {
		t.Fatal("unconfigured storage was materialized")
	}
	if x, e := LoadConfiguration("", dir); e != nil || x != nil {
		t.Fatal("missing systemd credential was not optional")
	}
	if _, e := LoadConfiguration(file, ""); e == nil {
		t.Fatal("explicit missing credential ignored")
	}
	x := map[string]any{"version": 1, "store": map[string]any{"endpoint": "http://127.0.0.1:9999", "bucket": "galaxy-private", "credentials": map[string]any{"accessKeyId": "fixture-id", "secretAccessKey": "fixture-private"}, "sseKeyId": "fixture-key", "sseKeyBase64": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}, "scanner": map[string]any{"port": 3310, "timeoutMs": 2000, "maxSignatureAgeSeconds": 86400}, "policy": DefaultPolicy()}
	save := func() {
		t.Helper()
		b, _ := json.Marshal(x)
		if e := os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	save()
	c, e := LoadConfiguration(file, "")
	if e != nil {
		t.Fatal(e)
	}
	if c.Store == nil || c.Scanner == nil || c.DraftRetentionDays != 7 || c.SubmittedRetentionDays != 30 || c.Policy != DefaultPolicy() {
		t.Fatal("original defaults lost")
	}
	x["feedbackPolicy"] = map[string]any{"draftRetentionDays": 3, "submittedRetentionDays": 15}
	save()
	c, e = LoadConfiguration(file, "")
	if e != nil || c.DraftRetentionDays != 3 || c.SubmittedRetentionDays != 15 {
		t.Fatal("explicit feedback policy lost")
	}
	x["feedbackPolicy"] = nil
	save()
	if _, e = LoadConfiguration(file, ""); e == nil {
		t.Fatal("null policy silently defaulted")
	}
	delete(x, "feedbackPolicy")
	x["unknown"] = true
	save()
	if _, e = LoadConfiguration(file, ""); e == nil {
		t.Fatal("unknown config accepted")
	}
	delete(x, "unknown")
	x["scanner"].(map[string]any)["host"] = "remote.example.invalid"
	save()
	if _, e = LoadConfiguration(file, ""); e == nil {
		t.Fatal("scanner gained remote address scope")
	}
}
