package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
)

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
