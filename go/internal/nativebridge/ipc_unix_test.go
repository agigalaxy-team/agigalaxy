//go:build linux || darwin

package nativebridge

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestUnixEndpointLongCacheAndPrivateSocket(t *testing.T) {
	t.Setenv("TMPDIR", "/tmp")
	root := t.TempDir()
	short, err := endpoint(root)
	if err != nil {
		t.Fatal(err)
	}
	if short != filepath.Join(root, "service.sock") {
		t.Fatalf("short endpoint changed: %q", short)
	}
	long := filepath.Join(root, strings.Repeat("x", 120))
	if err = os.Mkdir(long, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", long)
	ep, err := endpoint(long)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(filepath.Dir(ep)) })
	limit := len(syscall.RawSockaddrUnix{}.Path) - 1
	if len([]byte(ep)) > limit {
		t.Fatalf("endpoint too long: %q", ep)
	}
	again, err := endpoint(long)
	if err != nil || again != ep {
		t.Fatalf("endpoint not stable: %q %v", again, err)
	}
	if err = os.WriteFile(ep, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = listen(ep); err == nil {
		t.Fatal("ordinary file accepted as socket")
	}
	if _, err = dial(context.Background(), ep); err == nil {
		t.Fatal("ordinary file accepted for dial")
	}
	if b, e := os.ReadFile(ep); e != nil || string(b) != "keep" {
		t.Fatalf("ordinary file changed: %v", e)
	}
	if err = os.Remove(ep); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "target")
	if err = os.WriteFile(target, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(target, ep); err != nil {
		t.Fatal(err)
	}
	if _, err = listen(ep); err == nil {
		t.Fatal("symlink accepted as socket")
	}
	if _, err = dial(context.Background(), ep); err == nil {
		t.Fatal("symlink accepted for dial")
	}
	if b, e := os.ReadFile(target); e != nil || string(b) != "keep" {
		t.Fatalf("symlink target changed: %v", e)
	}
	if err = os.Remove(ep); err != nil {
		t.Fatal(err)
	}
	listener, err := listen(ep)
	if err != nil {
		t.Fatal(err)
	}
	c, err := dial(context.Background(), ep)
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	_ = c.Close()
	_ = listener.Close()
	cleanupEndpoint(ep)
}
