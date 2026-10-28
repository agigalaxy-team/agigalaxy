package main

import (
	"context"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	contextdata "github.com/agigalaxy-team/agigalaxy/go/internal/context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
)

// Fact consumers keep the owning source's authority and transaction.
func selectedFactSources(source *cases.Service, tasks *taskmaterials.Service) (*configurations.Service, *contextdata.Service) {
	cfg := &configurations.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, ResourceWrite: configurations.ResourceWrite(source.ResourceWrite)}
	source.ConfigurationCondition = cfg.ConditionWithin
	prior := source.Sources
	source.Sources = func(ctx context.Context, tx pgx.Tx, actor *deviceauth.Actor, ref, info cases.Object) (cases.Object, error) {
		if ref["kind"] == "configuration" {
			return cfg.RequireReferenceWithin(ctx, tx, actor, ref)
		}
		if prior != nil {
			return prior(ctx, tx, actor, ref, info)
		}
		return nil, fault.New("source_adapter_unavailable", 503)
	}
	materials := &contextdata.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, ResourceWrite: contextdata.ResourceWrite(source.ResourceWrite)}
	materials.LegacyLoad = func(ctx context.Context, tx pgx.Tx, id string) (contextdata.Object, error) {
		loaded, err := tasks.LegacyLoadWithin(ctx, tx, id, false)
		if err != nil {
			return nil, err
		}
		return contextdata.Object{"row": loaded.Row, "paused": loaded.Paused}, nil
	}
	materials.Participation = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, taskID, id string) (contextdata.Object, error) {
		return tasks.RequireParticipationWithin(ctx, tx, actor, taskID, id, true)
	}
	return cfg, materials
}

func consumeFactSearchPage(r *http.Request, actor *deviceauth.Actor, after any) error {
	position, _ := after.(string)
	kind, id := "", ""
	if actor != nil {
		kind, id = "subject", actor.SubjectID
	}
	return httpboundary.ConsumeSearchPage(r.Context(), &position, kind, id)
}

func selectedFactHandler(cfg *configurations.Service, materials *contextdata.Service, next http.Handler) http.Handler {
	return configurations.Handler{Service: cfg, Devices: cfg.Devices, ConsumeSearchPage: consumeFactSearchPage, Next: contextdata.Handler{Service: materials, Devices: materials.Devices, ConsumeSearchPage: consumeFactSearchPage, Next: next}}
}

func currentHistory(source *cases.Service, tasks *taskmaterials.Service) *historyv2.Service {
	return &historyv2.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Cases: source, Tasks: tasks.ReadHistoryWireWithin}
}
