package publication

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

func TestSelectedSourceAndCandidateBoundaries(t *testing.T) {
	config, files, snapshot, _, configPath := fixtureFiles(t)
	ctx := context.Background()
	raw, _ := json.Marshal(snapshot)
	mutate := func(fn func(Object)) Snapshot {
		t.Helper()
		var value Object
		json.Unmarshal(raw, &value)
		fn(value)
		b, _ := json.Marshal(value)
		v, e := ParseSnapshot(b)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	changed := mutate(func(v Object) { v["media"].([]any)[0].(map[string]any)["filesize"] = 1 })
	if _, e := files.Prepare(ctx, uuid.NewString(), changed); e == nil {
		t.Fatal("changed selected media size accepted")
	}
	outside := filepath.Join(filepath.Dir(configPath), "private.png")
	if e := os.WriteFile(outside, []byte("PRIVATE"), 0600); e != nil {
		t.Fatal(e)
	}
	linked := filepath.Join(config.MediaDirectory, "linked.png")
	if e := os.Symlink(outside, linked); e != nil {
		t.Fatal(e)
	}
	selectedLink := mutate(func(v Object) {
		m := v["media"].([]any)[0].(map[string]any)
		m["filename"] = "linked.png"
		m["url"] = "https://admin.invalid/api/media/file/linked.png"
		m["filesize"] = 7
	})
	if _, e := files.Prepare(ctx, uuid.NewString(), selectedLink); e == nil {
		t.Fatal("private media link copied into publication")
	}
	invalidConfig := config
	invalidConfig.ReleaseDirectory = config.BaseDirectory
	if _, e := NewFilesystem(invalidConfig); e == nil {
		t.Fatal("source and output directories merged")
	}
	candidate := filepath.Join(filepath.Dir(configPath), "outside-candidate")
	os.Mkdir(candidate, 0750)
	id := uuid.NewString()
	os.WriteFile(filepath.Join(candidate, marker), []byte(`{"publicationId":"`+id+`"}`), 0640)
	if e := files.Activate(ctx, Artifact{PublicationID: id, Directory: candidate}); e == nil {
		t.Fatal("candidate outside release root activated")
	}
	bad := filepath.Join(config.ReleaseDirectory, "bad-baseline")
	os.Mkdir(bad, 0750)
	os.WriteFile(filepath.Join(bad, marker), []byte(`{"version":1,"mode":"baseline"}`), 0640)
	config.CurrentLink = filepath.Join(filepath.Dir(configPath), "bad-current")
	os.Symlink(bad, config.CurrentLink)
	other, e := NewFilesystem(config)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = other.Current(ctx); e == nil {
		t.Fatal("missing publicationId fabricated baseline")
	}
}

func TestPublisherConfigurationUsesExactOrigins(t *testing.T) {
	for _, value := range []string{"https://events.invalid/", "https://events.invalid:443", "https://events.invalid:0443", "https://EVENTS.invalid", "https://events.invalid:", "https://events.invalid?"} {
		if exactOrigin(value) {
			t.Fatalf("noncanonical origin accepted: %s", value)
		}
	}
	if !exactOrigin("https://events.invalid:8443") {
		t.Fatal("nondefault canonical port rejected")
	}
}
