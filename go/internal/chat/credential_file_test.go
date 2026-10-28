package chat

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSystemdCredentialSecretBoundary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file permissions")
	}
	directory := t.TempDir()
	t.Setenv("CREDENTIALS_DIRECTORY", directory)
	inside := filepath.Join(directory, "component-key")
	if e := os.WriteFile(inside, []byte("controlled fixture"), 0440); e != nil {
		t.Fatal(e)
	}
	if _, e := boundedFile(inside, 4096, true); e != nil {
		t.Fatal(e)
	}
	outside := filepath.Join(t.TempDir(), "component-key")
	if e := os.WriteFile(outside, []byte("controlled fixture"), 0440); e != nil {
		t.Fatal(e)
	}
	if _, e := boundedFile(outside, 4096, true); e == nil {
		t.Fatal("accepted ordinary group-readable secret")
	}
	if e := os.Chmod(inside, 0640); e != nil {
		t.Fatal(e)
	}
	if _, e := boundedFile(inside, 4096, true); e == nil {
		t.Fatal("accepted writable credential exception")
	}
	if e := os.Chmod(inside, 0440); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(directory, "linked-key")
	if e := os.Symlink(outside, link); e != nil {
		t.Fatal(e)
	}
	if _, e := boundedFile(link, 4096, true); e == nil {
		t.Fatal("accepted symlink credential")
	}
	if e := os.Chmod(directory, 0755); e != nil {
		t.Fatal(e)
	}
	if _, e := boundedFile(inside, 4096, true); e == nil {
		t.Fatal("accepted world-accessible credential directory")
	}
}
