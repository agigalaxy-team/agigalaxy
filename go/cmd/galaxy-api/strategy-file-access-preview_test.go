package main

import (
	"context"
	"errors"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/jackc/pgx/v5"
)

func TestPreviewFileAccessUsesScopedSourceNotCurrentAction(t *testing.T) {
	ctx := context.Background()
	available := true
	lookup := func(c context.Context, tx pgx.Tx, kind, id string) (filegovernance.Object, error) {
		if c != ctx || tx != nil || id != "selected" {
			t.Fatal("source or transaction changed")
		}
		if kind == "chat" {
			return nil, fault.New("not_found", 404)
		}
		return filegovernance.Object{"kind": kind, "available": available, "version": "opaque-full-version", "private": "must-not-project", "canRestore": false}, nil
	}
	got, err := previewAccessFile(ctx, nil, "selected", lookup)
	if err != nil || got["kind"] != "forum-file" || got["available"] != true || got["version"] != "opaque-full-version" || len(got) != 3 {
		t.Fatalf("source facts mismatch: %#v %v", got, err)
	}
	available = false
	got, err = previewAccessFile(ctx, nil, "selected", lookup)
	if err != nil || got["available"] != false {
		t.Fatalf("unavailable source: %#v %v", got, err)
	}
	expected := errors.New("source failure")
	_, err = previewAccessFile(ctx, nil, "selected", func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error) { return nil, expected })
	if !errors.Is(err, expected) {
		t.Fatal("source failure was lost")
	}
	got, err = previewAccessFile(ctx, nil, "selected", func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error) {
		return filegovernance.Object{"available": true, "version": "same-id"}, nil
	})
	if err != nil || got["available"] != false || got["version"] != nil {
		t.Fatalf("ambiguous cross-kind source accepted: %#v %v", got, err)
	}
}
