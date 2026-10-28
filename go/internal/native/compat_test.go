package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func fixture(t *testing.T) (*Store, map[string]any) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	dir := t.TempDir()
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/native-fixture.mjs"), dir)
	cmd.Dir = root
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("native Node fixture: %v: %s", e, b)
	}
	var expected map[string]any
	b, e := os.ReadFile(filepath.Join(dir, "expected.json"))
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &expected); e != nil {
		t.Fatal(e)
	}
	s, e := NewStore(dir, "https://galaxy.invalid")
	if e != nil {
		t.Fatal(e)
	}
	return s, expected
}
func same(t *testing.T, want, got any) {
	t.Helper()
	normalize := func(v any) any {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		var out any
		if e = json.Unmarshal(b, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	if !reflect.DeepEqual(normalize(want), normalize(got)) {
		t.Fatalf("projection changed\nwant %s\ngot  %s", mustJSON(want), mustJSON(got))
	}
}
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
func TestNativeReadsActualNodeDataAndSignsExactPayload(t *testing.T) {
	s, want := fixture(t)
	ctx := context.Background()
	original, e := os.ReadFile(filepath.Join(s.Directory, "galaxy-id.json"))
	if e != nil {
		t.Fatal(e)
	}
	got, e := s.Identity(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, want["identity"], got)
	list, e := s.WorkList(ctx, WorkQuery{})
	if e != nil {
		t.Fatal(e)
	}
	same(t, want["list"], list)
	id := want["get"].(map[string]any)["work"].(map[string]any)["workId"].(string)
	detail, e := s.WorkGet(ctx, WorkQuery{WorkID: id})
	if e != nil {
		t.Fatal(e)
	}
	same(t, want["get"], detail)
	ar, e := s.ArchiveSettings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, want["archive"], ar)
	after, _ := os.ReadFile(filepath.Join(s.Directory, "galaxy-id.json"))
	if !bytes.Equal(original, after) {
		t.Fatal("read changed original identity")
	}
	keyBytes, e := os.ReadFile(filepath.Join(s.Directory, "galaxy-id-private-key.pem"))
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM(keyBytes)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(key, want["payloadText"].(string), "")
	if e != nil {
		t.Fatal(e)
	}
	if signature != want["signature"] {
		t.Fatal("signature changed exact protocol bytes")
	}
	if _, e = s.WorkList(ctx, WorkQuery{GalaxyID: "other-owner"}); e == nil {
		t.Fatal("foreign owner accepted")
	}
}
func TestMissingIdentityReadCreatesNothing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	s, _ := NewStore(dir, "")
	out, e := s.WorkList(context.Background(), WorkQuery{})
	if e != nil {
		t.Fatal(e)
	}
	same(t, map[string]any{"galaxyId": nil, "items": []any{}, "nextAfter": nil}, out)
	if _, e = os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("read materialized data directory")
	}
}
func TestCorruptLocalRecordsAreNotPresentedAsEmptyData(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	file := filepath.Join(s.Directory, "work-history", "history.sqlite")
	db, e := openSQLite(file, true)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("UPDATE work_observations SET details_json='not-json' WHERE sequence=(SELECT min(sequence) FROM work_observations)")
	db.Close()
	if e != nil {
		t.Fatal(e)
	}
	list, e := s.WorkList(ctx, WorkQuery{})
	if e != nil {
		t.Fatal(e)
	}
	work := list.(map[string]any)["items"].([]any)[0].(map[string]any)["workId"].(string)
	if _, e = s.WorkGet(ctx, WorkQuery{WorkID: work}); fault.Code(e) != "native_record_invalid" {
		t.Fatalf("corrupt observation returned as empty: %v", e)
	}
}
func TestPersonChoiceCannotFollowAChangedDeviceSelection(t *testing.T) {
	s, want := fixture(t)
	ctx := context.Background()
	scope, e := s.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	e = s.With(ctx, true, func(dir string) error {
		folder := filepath.Join(dir, "native-v2", "records")
		if e := os.MkdirAll(folder, 0700); e != nil {
			return e
		}
		return writeJSON(filepath.Join(folder, identity.Digest([]byte("native-selection:"+s.Endpoint))+".json"), map[string]any{"version": 1, "revision": 1, "active": map[string]any{"subjectId": scope.Owner, "deviceId": "changed-device"}, "permission": nil})
	})
	if e != nil {
		t.Fatal(e)
	}
	enabled := false
	_, e = s.configureArchive(ctx, ArchiveInput{GalaxyID: scope.Owner, Enabled: &enabled, Sessions: []ArchiveSession{}}, &scope)
	if fault.Code(e) != "native_choice_binding_changed" {
		t.Fatalf("old approval followed new selection: %v", e)
	}
	current, e := s.ArchiveSettings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, want["archive"], current)
}
func TestCrossProcessNodeLockBlocksGoWithoutDeletingLock(t *testing.T) {
	s, _ := fixture(t)
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	script := "import {withLocalWrite} from './packages/galaxy-core/src/storage/write-lock.mjs';await withLocalWrite(process.argv[1],async()=>{console.log('locked');await new Promise(r=>setTimeout(r,550));});"
	cmd := exec.Command("node", "--input-type=module", "-e", script, s.Directory)
	cmd.Dir = root
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer cmd.Wait()
	b := make([]byte, 7)
	if _, e = out.Read(b); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
	defer cancel()
	if e = s.With(ctx, false, func(string) error { t.Fatal("Go ignored Node exclusive lock"); return nil }); !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("lock wait did not preserve cancellation: %v", e)
	}
	if _, e = os.Stat(filepath.Join(s.Directory, CoordinationFile)); e != nil {
		t.Fatal("coordination file removed")
	}
}
func connectMCP(t *testing.T, store *Store, version string, answer bool) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	s, e := NewToolServer(store)
	if e != nil {
		t.Fatal(e)
	}
	ct, st := mcp.NewInMemoryTransports()
	ss, e := s.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "native-compatibility", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": answer}}, nil
	}})
	cs, e := c.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cs.Close(); ss.Close() })
	return cs
}
func TestActualMCPVersionsRequirePersonChoiceAndPreserveArchive(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(version, func(t *testing.T) {
			s, want := fixture(t)
			ctx := context.Background()
			cs := connectMCP(t, s, version, false)
			params := map[string]any{"enabled": false, "sessions": []any{}, "autoCleanAfterDays": nil}
			result, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_local_archive_configure", Arguments: params})
			if e != nil {
				t.Fatal(e)
			}
			if result.IsError {
				t.Fatalf("decline failed %v", result)
			}
			got, e := s.ArchiveSettings(ctx)
			if e != nil {
				t.Fatal(e)
			}
			same(t, want["archive"], got)
			yes := connectMCP(t, s, version, true)
			result, e = yes.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_local_archive_configure", Arguments: params})
			if e != nil {
				t.Fatal(e)
			}
			if result.IsError {
				t.Fatalf("accepted native choice failed %v", result)
			}
			got, e = s.ArchiveSettings(ctx)
			if e != nil {
				t.Fatal(e)
			}
			raw, _ := protocol.Encode(got)
			var actual struct {
				Settings ArchiveSettings `json:"settings"`
			}
			_ = json.Unmarshal(raw, &actual)
			if actual.Settings.Enabled {
				t.Fatal("person's exact selection was not saved")
			}
			if actual.Settings.Sessions == nil {
				t.Fatal("empty selected list became null")
			}
		})
	}
}
