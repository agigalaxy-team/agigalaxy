package main

import (
	"context"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/jackc/pgx/v5"
)

func previewOrdinaryStrategy(ctx context.Context, tx pgx.Tx, actor p.Actor, id string, inspect func(context.Context, pgx.Tx, p.Actor, string) (p.Actor, operationsstrategies.Object, operationsstrategies.Object, operationsstrategies.Object, error)) (operationsstrategies.Object, error) {
	_, head, version, strategy, err := inspect(ctx, tx, actor, id)
	if err != nil {
		return nil, err
	}
	return operationsstrategies.Object{"kind": "strategy", "available": strategy["ordinaryBounds"] != nil && strategy["mode"] != "human-led", "version": version["id"], "revision": head["revision"]}, nil
}
