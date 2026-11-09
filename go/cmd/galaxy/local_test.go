package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
)

func TestSetupWritePermissionHasActionableFault(t *testing.T) {
	for _, cause := range []error{os.ErrPermission, syscall.EROFS} {
		err := &os.PathError{Op: "mkdir", Path: "test", Err: cause}
		if got := fault.Code(setupWriteError(err)); got != "setup_write_permission_required" {
			t.Errorf("write restriction was reported as %s", got)
		}
	}
	original := fault.New("setup_host_invalid", 400)
	if setupWriteError(original) != original {
		t.Fatal("unrelated fault changed")
	}
}

func TestLocalCLIReadThenExplicitInitPreservesOriginalIdentity(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "local")
	ctx := context.Background()
	for _, name := range []string{"status", "export"} {
		if err := run(ctx, []string{name, "--data-dir", directory}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("read command created local data")
	}
	if err := run(ctx, []string{"init", "--data-dir", directory}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(directory, "galaxy-id.json"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(filepath.Join(directory, "galaxy-id-private-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if err = run(ctx, []string{"init", "--data-dir", directory}); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(directory, "galaxy-id.json"))
	afterKey, _ := os.ReadFile(filepath.Join(directory, "galaxy-id-private-key.pem"))
	if !bytes.Equal(before, after) || !bytes.Equal(key, afterKey) {
		t.Fatal("repeat init replaced identity or key")
	}
	if _, err = os.Stat(filepath.Join(directory, "native-v2")); !os.IsNotExist(err) {
		t.Fatal("offline fallback created a service connection")
	}
	store, _ := native.NewStore(directory, "")
	if _, err = store.ExportLocalData(ctx); err != nil {
		t.Fatal(err)
	}
	if fault.Code(run(ctx, []string{"status", "--data-dir", directory, "--config", "unused"})) != "native_arguments_invalid" {
		t.Fatal("unrelated arguments were accepted")
	}
}

func TestInstallationPrivacyOptionUsesUserTier(t *testing.T) {
	levels := []string{"local-only", "history-overview", "work-content", "conversation-archive"}
	for index, level := range levels {
		selected, err := installationPrivacyOption("--sync-tier", strconv.Itoa(index+1))
		if err != nil || selected.Level != level {
			t.Fatalf("tier %d: got %v, %v, want %s", index+1, selected, err, level)
		}
	}
	for _, value := range []string{"", "0", "5", "local-only"} {
		if _, err := installationPrivacyOption("--sync-tier", value); err == nil {
			t.Errorf("accepted invalid tier %q", value)
		}
	}
	selected, err := installationPrivacyOption("--upload-privacy", "conversation-archive")
	if err != nil || selected.Level != "conversation-archive" {
		t.Fatalf("existing named selection: %v, %v", selected, err)
	}
}

func TestSetupRequiresFirstSyncChoiceBeforeWriting(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "new-identity")
	install := filepath.Join(root, "install")
	err := run(context.Background(), []string{"setup", "--local-only", "--host", "cursor", "--data-dir", data, "--destination", install, "--json"})
	if fault.Code(err) != "setup_sync_choice_required" {
		t.Fatalf("got %v, want an explicit sync choice", err)
	}
	for _, path := range []string{data, install} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("setup created %s or could not check it: %v", path, err)
		}
	}
}
