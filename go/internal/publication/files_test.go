package publication

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/google/uuid"
)

func node(t *testing.T, dsn string, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", append([]string{filepath.Join(root, "scripts/go/publication-interop.mjs")}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS fixture: %v %s", e, out)
	}
	return out
}
func fixtureFiles(t *testing.T) (Config, *Filesystem, Snapshot, []byte, string) {
	t.Helper()
	root, e := os.MkdirTemp("", "galaxy-publication-test-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	config := Config{Version: 1, Endpoint: "https://events.invalid", PublicOrigin: "https://website.invalid", AdminOrigin: "https://admin.invalid", BaseDirectory: filepath.Join(root, "base"), ReleaseDirectory: filepath.Join(root, "releases"), CurrentLink: filepath.Join(root, "current"), MediaDirectory: filepath.Join(root, "media")}
	for _, path := range []string{config.BaseDirectory, config.ReleaseDirectory, config.MediaDirectory} {
		if e = os.Mkdir(path, 0750); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(filepath.Join(config.BaseDirectory, "release.json"), []byte(`{"version":"original-software-1"}`), 0640)
	image, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	filename := "配图 +.png"
	os.WriteFile(filepath.Join(config.MediaDirectory, filename), image, 0640)
	value := Object{"version": 1, "settings": Object{"siteTitle": "银河", "description": "公开内容", "footerLinks": []any{Object{"label": "指南", "href": "/guide/"}}}, "pages": []any{Object{"id": "guide", "path": "/guide/", "title": "指南", "description": "", "updatedAt": "2026-10-28T00:00:00Z", "blocks": []any{Object{"blockType": "image", "mediaId": "selected/image", "caption": "选中的图"}, Object{"blockType": "prose", "heading": "说明", "body": "动态正文保持由Next呈现。"}}}}, "media": []any{Object{"id": "selected/image", "filename": filename, "url": "https://admin.invalid/api/media/file/" + component(filename), "alt": "选择图", "mimeType": "image/png", "filesize": len(image)}, Object{"id": "unused", "filename": "PRIVATE_DRAFT.png", "url": "https://admin.invalid/api/media/file/PRIVATE_DRAFT.png", "alt": "未选草稿", "mimeType": "image/png", "filesize": 10}}}
	raw, _ := json.Marshal(value)
	snapshot, e := ParseSnapshot(raw)
	if e != nil {
		t.Fatal(e)
	}
	configPath := filepath.Join(root, "publisher.json")
	b, _ := json.Marshal(config)
	if e = os.WriteFile(configPath, b, 0600); e != nil {
		t.Fatal(e)
	}
	loaded, e := LoadConfiguration(configPath)
	if e != nil {
		t.Fatal(e)
	}
	files, e := NewFilesystem(loaded)
	if e != nil {
		t.Fatal(e)
	}
	return config, files, snapshot, image, configPath
}
func TestOriginalJSReadsGoSnapshotAndSelectedMedia(t *testing.T) {
	config, files, snapshot, image, configPath := fixtureFiles(t)
	ctx := context.Background()
	id := uuid.NewString()
	artifact, e := files.Prepare(ctx, id, snapshot)
	if e != nil {
		t.Fatal(e)
	}
	if current, e := files.Current(ctx); e != nil || current != nil {
		t.Fatalf("prepare changed pointer %v %v", current, e)
	}
	var original struct {
		Snapshot Object
		Marker   Object
		Media    map[string]string
		Current  any
		Files    []string
	}
	if e = json.Unmarshal(node(t, "", "read-files", configPath, artifact.Directory), &original); e != nil {
		t.Fatal(e)
	}
	if len(original.Media) != 1 || original.Media["配图 +.png"] != base64.StdEncoding.EncodeToString(image) {
		t.Fatal("original JS read different selected media bytes")
	}
	if len(original.Snapshot["media"].([]any)) != 1 {
		t.Fatal("unselected draft became public")
	}
	for _, name := range original.Files {
		if name == "index.html" || name == "app" {
			t.Fatal("publisher generated/copied static application")
		}
	}
	// Original JS preparation is accepted by the Go activation path as well.
	snapshotFile := filepath.Join(filepath.Dir(configPath), "snapshot.json")
	b, _ := json.Marshal(snapshot)
	os.WriteFile(snapshotFile, b, 0600)
	var jsArtifact struct {
		PublicationID string `json:"publicationId"`
		SiteVersion   string `json:"siteVersion"`
		Directory     string `json:"directory"`
	}
	if e = json.Unmarshal(node(t, "", "prepare", configPath, snapshotFile, uuid.NewString()), &jsArtifact); e != nil {
		t.Fatal(e)
	}
	if e = files.Activate(ctx, Artifact{jsArtifact.PublicationID, jsArtifact.SiteVersion, jsArtifact.Directory}); e != nil {
		t.Fatalf("first activation: %v", e)
	}
	current, e := files.Current(ctx)
	if e != nil || current.PublicationID != jsArtifact.PublicationID {
		t.Fatalf("Go did not accept JS marker: %v %v", current, e)
	}
	// Replacement must use the same directory symlink protocol on supported hosts.
	t.Run("atomic replacement of existing directory symlink", func(t *testing.T) {
		if e = files.Activate(ctx, artifact); e != nil {
			if runtime.GOOS == "windows" && os.IsPermission(e) {
				t.Skip("Windows cannot atomically replace the directory symlink used by the original publisher; Linux host verification is required")
			}
			t.Fatalf("replace current publication link: %v", e)
		}
		var activeOriginal struct {
			Current struct {
				PublicationID string `json:"publicationId"`
			}
		}
		if e = json.Unmarshal(node(t, "", "read-files", configPath, artifact.Directory), &activeOriginal); e != nil || activeOriginal.Current.PublicationID != id {
			t.Fatalf("original JS did not recognize Go replacement marker: %+v %v", activeOriginal, e)
		}
	})
	// A mismatched marker, foreign origin and changed selected media fail before
	// switching; the first valid publication remains the current authority.
	forged := artifact
	forged.PublicationID = uuid.NewString()
	if e = files.Activate(ctx, forged); e == nil {
		t.Fatal("forged marker accepted")
	}
	foreign := snapshot.value["media"].([]any)[0].(map[string]any)
	old := foreign["url"]
	foreign["url"] = "https://other.invalid/api/media/file/" + component("配图 +.png")
	if _, e = files.Prepare(ctx, uuid.NewString(), snapshot); e == nil {
		t.Fatal("foreign CMS media origin accepted")
	}
	foreign["url"] = old
	bytes, e := os.ReadFile(filepath.Join(config.MediaDirectory, "配图 +.png"))
	if e != nil || !reflect.DeepEqual(bytes, image) {
		t.Fatal("source media changed")
	}
}
