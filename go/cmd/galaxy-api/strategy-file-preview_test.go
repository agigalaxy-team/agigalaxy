package main

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/jackc/pgx/v5"
)

func TestStrategyScanPreviewUsesScopedFileSource(t *testing.T) {
	ctx := context.Background()
	calls := []string{}
	lookup := func(_ context.Context, _ pgx.Tx, kind, id string) (filegovernance.Object, error) {
		calls = append(calls, kind+":"+id)
		if kind == "chat" {
			return nil, fault.New("not_found", 404)
		}
		return filegovernance.Object{"revision": 7}, nil
	}
	got, err := previewScanFile(ctx, nil, "selected-id", lookup)
	if err != nil || got["kind"] != "forum-file" || got["available"] != true || got["version"] != 7 || len(calls) != 2 {
		t.Fatalf("unexpected preview: %#v, %v, calls %v", got, err, calls)
	}
	got, err = previewScanFile(ctx, nil, "selected-id", func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error) {
		return filegovernance.Object{"revoked_at": "present"}, nil
	})
	if err != nil || got["available"] != false {
		t.Fatalf("revoked file was available: %#v, %v", got, err)
	}
	_, err = previewScanFile(ctx, nil, "selected-id", func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error) {
		return nil, fault.New("permission_denied", 403)
	})
	if fault.Status(err) != 403 {
		t.Fatalf("scope error lost: %v", err)
	}
}
