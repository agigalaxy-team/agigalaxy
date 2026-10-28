package maintenance

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOriginalProtectedNativeConfigurationAndKeyShape(t *testing.T) {
	file := filepath.Join(t.TempDir(), "native.json")
	keyFile := filepath.Join(filepath.Dir(file), "service.key")
	config := map[string]any{"version": json.Number("1e0"), "socketPath": "/run/galaxy-maintenance/api.sock", "keyFile": keyFile}
	key := strings.Repeat("😀", 16)
	read := func(path string, max int64) ([]byte, error) {
		if path == file {
			return json.Marshal(config)
		}
		if path == keyFile {
			return []byte("\ufeff" + key + "\n"), nil
		}
		return nil, os.ErrNotExist
	}
	value, e := load(file, read)
	if e != nil || value == nil || value.Key != key {
		t.Fatal("original explicit UTF16 key/version shape rejected")
	}
	key = "isolated key has whitespace inside 1234567890"
	if _, e = load(file, read); e == nil {
		t.Fatal("service key whitespace accepted")
	}
	key = strings.Repeat("x", 31)
	if _, e = load(file, read); e == nil {
		t.Fatal("short native service key accepted")
	}
	key = strings.Repeat("x", 32)
	config["socketPath"] = "/tmp/arbitrary.sock"
	if _, e = load(file, read); e == nil {
		t.Fatal("non-original socket path accepted")
	}
	config["socketPath"] = "/run/galaxy-maintenance/api.sock"
	config["extra"] = true
	if _, e = load(file, read); e == nil {
		t.Fatal("unknown protected configuration field accepted")
	}
	if value, e = Load(""); e != nil || value != nil {
		t.Fatal("absent optional native configuration acquired service identity")
	}
}

func TestActualUnixSocketSignatureBoundaryAndNoLostAckResend(t *testing.T) {
	dir, e := os.MkdirTemp("", "galaxy-socket-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.Remove(dir) })
	socket := filepath.Join(dir, "control.sock")
	listener, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatalf("actual Unix listener unavailable: %v", e)
	}
	defer listener.Close()
	key := strings.Repeat("isolated-key-", 4)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	client := New(Configuration{SocketPath: socket, Key: key}, Options{Now: now})
	verifier := New(Configuration{Key: key}, Options{Now: now})
	var posts atomic.Int32
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		raw, _ := io.ReadAll(r.Body)
		verified, e := verifier.VerifyService(r)
		if e != nil || verifier.VerifyBody(verified, raw) != nil || r.Method != "POST" || r.URL.Path != "/v1/system-settings" || r.Header.Get("Cookie") != "" {
			w.WriteHeader(401)
			return
		}
		if strings.Contains(string(raw), "lost") {
			c, _, _ := w.(http.Hijacker).Hijack()
			c.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"state":"observed"}`)
	})}
	go server.Serve(listener)
	defer server.Close()
	raw, status, e := client.SystemSettings(context.Background(), []byte(`{"kind":"settings-overview","section":"mail"}`))
	if e != nil || status != 200 || string(raw) != `{"state":"observed"}` {
		t.Fatalf("actual socket %d %s %v", status, raw, e)
	}
	if _, _, e = client.SystemSettings(context.Background(), []byte(`{"kind":"lost"}`)); e == nil {
		t.Fatal("lost ACK became success")
	}
	if posts.Load() != 2 {
		t.Fatalf("socket implicit POST resend count%d", posts.Load())
	}
	req, _ := http.NewRequest("POST", "http://localhost/v1/internal/system-settings/authorize", nil)
	req.Header.Set("X-Galaxy-Service-Key", key)
	req.Header.Set("X-Galaxy-Request-Id", "11111111-1111-4111-8111-111111111111")
	req.Header.Set("X-Galaxy-Request-At", "2000000000")
	body := []byte(`{"section":"mail"}`)
	req.Header.Set("X-Galaxy-Service-Signature", Signature(key, req.Header.Get("X-Galaxy-Request-Id"), req.Header.Get("X-Galaxy-Request-At"), body))
	v, e := verifier.VerifyService(req)
	if e != nil || verifier.VerifyBody(v, body) != nil {
		t.Fatal("current signed request denied")
	}
	if verifier.VerifyBody(v, append(body, ' ')) == nil || client.VerifyBody(v, body) == nil {
		t.Fatal("changed raw bytes or foreign verified context accepted")
	}
	req.Header.Set("X-Galaxy-Request-At", "1999999969")
	if _, e = verifier.VerifyService(req); e == nil {
		t.Fatal("stale private service request accepted")
	}
	req.Header.Set("X-Galaxy-Request-At", "2000000000")
	req.Header.Add("X-Galaxy-Service-Key", key)
	if _, e = verifier.VerifyService(req); e == nil {
		t.Fatal("duplicate credential header accepted")
	}
}
