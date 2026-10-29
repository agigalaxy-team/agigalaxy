package main

import (
	"context"
	"errors"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/jackc/pgx/v5"
	"testing"
)

func TestPreviewOrdinaryStrategyUsesOriginalSource(t *testing.T) {
	ctx := context.Background()
	mode, bounds := "ai-autonomous", any(operationsstrategies.Object{})
	expectedErr := errors.New("source unavailable")
	var sourceErr error
	inspect := func(c context.Context, tx pgx.Tx, a p.Actor, id string) (p.Actor, operationsstrategies.Object, operationsstrategies.Object, operationsstrategies.Object, error) {
		if c != ctx || tx != nil || id != "selected-source" {
			t.Fatal("source or transaction changed")
		}
		return a, operationsstrategies.Object{"revision": 9}, operationsstrategies.Object{"id": "active-version"}, operationsstrategies.Object{"ordinaryBounds": bounds, "mode": mode}, sourceErr
	}
	result, err := previewOrdinaryStrategy(ctx, nil, p.Actor{}, "selected-source", inspect)
	if err != nil || result["available"] != true || result["version"] != "active-version" || result["revision"] != 9 {
		t.Fatalf("source mismatch: %#v %v", result, err)
	}
	bounds = nil
	result, err = previewOrdinaryStrategy(ctx, nil, p.Actor{}, "selected-source", inspect)
	if err != nil || result["available"] != false {
		t.Fatal("unbounded source available")
	}
	bounds, mode = operationsstrategies.Object{}, "human-led"
	result, err = previewOrdinaryStrategy(ctx, nil, p.Actor{}, "selected-source", inspect)
	if err != nil || result["available"] != false {
		t.Fatal("human-led source available")
	}
	sourceErr = expectedErr
	_, err = previewOrdinaryStrategy(ctx, nil, p.Actor{}, "selected-source", inspect)
	if !errors.Is(err, expectedErr) {
		t.Fatal("source error lost")
	}
}
