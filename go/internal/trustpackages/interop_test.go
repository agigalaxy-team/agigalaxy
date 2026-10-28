package trustpackages

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOriginalCurrentAuthorPermissionAndReceipt(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/trust-package-interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_TRUST_DIR="+dir)
	out, _ := cmd.StdoutPipe()
	in, _ := cmd.StdinPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		_, _ = io.WriteString(in, "stop\n")
		_ = in.Close()
		if e := cmd.Wait(); e != nil && ctx.Err() == nil {
			t.Errorf("original fixture %v %s", e, stderr.String())
		}
	}()
	scan := bufio.NewScanner(out)
	ready := false
	for scan.Scan() {
		if scan.Text() == "ready" {
			ready = true
			break
		}
	}
	if !ready {
		t.Fatalf("original fixture %s", stderr.String())
	}
	var f struct {
		Endpoint, Token, OtherToken, Bridge string
		Now                                 int64
		Preview                             Object
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	pool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	cs.TaskRead = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &a, id, false)
	}
	cs.GrantAuthorTaskRead = tasks.ReadGrantAuthorWithin
	reader := &SourceReader{Endpoint: f.Endpoint, Cases: cs, ReadCaseAsAuthor: cs.ReadV2GrantAuthorWithin, Now: now}
	s := New(pool, f.Endpoint, devices, now)
	s.ReadSource = reader.ReadWithin
	s.ReadAuthorSource = reader.ReadAuthorWithin
	h := Handler{Service: s}
	request := func(other bool, path string, input Object) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v2/trust-package/"+path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		token := f.Token
		if other {
			token = f.OtherToken
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("HTTP %s %d %s", path, w.Code, w.Body.String())
		}
		var result Object
		if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
		return result
	}
	bridge := func(other bool, action string, input Object, text string) Object {
		t.Helper()
		raw, _ := json.Marshal(Object{"action": action, "other": other, "input": input, "text": text})
		req, _ := http.NewRequestWithContext(ctx, "POST", f.Bridge, bytes.NewReader(raw))
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var result Object
		if e = json.NewDecoder(res.Body).Decode(&result); e != nil {
			t.Fatal(e)
		}
		if res.StatusCode != 200 {
			t.Fatalf("original %s %d %v", action, res.StatusCode, result)
		}
		return result
	}
	check := func(label string, a, b Object) {
		t.Helper()
		aa, _ := json.Marshal(a)
		bb, _ := json.Marshal(b)
		if !bytes.Equal(aa, bb) {
			t.Fatalf("%s Go %s JS %s", label, aa, bb)
		}
	}
	preview := request(false, "permissions/preview", f.Preview)
	check("preview", preview, bridge(false, "preview", f.Preview, ""))
	signed := bridge(false, "sign", nil, str(preview, "payloadJson"))
	receipt := request(false, "permissions/submit", signed)
	check("grant replay", receipt, bridge(false, "submit", signed, ""))
	check("lost ACK", receipt, request(false, "permissions/submit", signed))
	lookup := Object{"id": f.Preview["id"]}
	check("receipt", request(true, "permissions/receipt", lookup), bridge(true, "receipt", lookup, ""))
	check("status", request(true, "permissions/status", lookup), bridge(true, "status", lookup, ""))
	selection := Object{"selections": []any{Object{"ref": f.Preview["source"], "mode": "copy", "permissionId": f.Preview["id"]}}, "audience": f.Preview["audience"], "expiresAt": f.Now + 900}
	check("current author copy", request(true, "sources", selection), bridge(true, "sources", selection, ""))
	revoke := Object{"id": f.Preview["id"], "operationId": uuid.NewString()}
	p := request(false, "permissions/revoke-preview", revoke)
	check("revoke preview", p, bridge(false, "revokePreview", revoke, ""))
	revoked := bridge(false, "sign", nil, str(p, "payloadJson"))
	r := request(false, "permissions/submit", revoked)
	check("revoke replay", r, bridge(false, "submit", revoked, ""))
	check("revoked status", request(true, "permissions/status", lookup), bridge(true, "status", lookup, ""))
	check("revoked copy", request(true, "sources", selection), bridge(true, "sources", selection, ""))
	check("historical ACK", request(false, "permissions/receipt", lookup), bridge(false, "receipt", lookup, ""))
}
