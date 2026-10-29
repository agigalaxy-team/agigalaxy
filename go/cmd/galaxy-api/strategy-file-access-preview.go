package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/jackc/pgx/v5"
)

// previewAccessFile returns only the owning file service's current scoped
// source facts; it does not select or authorize a stop or restore action.
func previewAccessFile(ctx context.Context, tx pgx.Tx, id string, lookup func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error)) (operationsstrategies.Object, error) {
	var selected operationsstrategies.Object
	for _, kind := range []string{"chat", "forum"} {
		source, err := lookup(ctx, tx, kind, id)
		if fault.Status(err) == 404 {
			continue
		}
		if err != nil {
			return nil, err
		}
		if selected != nil {
			return operationsstrategies.Object{"available": false, "version": nil}, nil
		}
		available, valid := source["available"].(bool)
		version, versionOK := source["version"].(string)
		if !valid || !versionOK || version == "" {
			selected = operationsstrategies.Object{"kind": kind + "-file", "available": false, "version": nil}
			continue
		}
		selected = operationsstrategies.Object{"kind": kind + "-file", "available": available, "version": version}
	}
	if selected != nil {
		return selected, nil
	}
	return operationsstrategies.Object{"available": false, "version": nil}, nil
}
