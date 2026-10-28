package main

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func searchService(history *historyv2.Service, ci *civ2.Service, tasks *taskmaterials.Service, opportunitySource *opportunities.Service) *searchv2.Service {
	service := &searchv2.Service{Pool: history.Pool, Devices: history.Devices, History: history, CI: ci}
	service.Tasks = func(ctx context.Context, actor *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var query struct {
			View  string  `json:"view"`
			Query string  `json:"query"`
			After *string `json:"after"`
			Limit int     `json:"limit"`
		}
		if err := protocol.Decode(raw, &query); err != nil {
			return nil, err
		}
		var viewer *taskmaterials.Actor
		if actor != nil {
			viewer = &taskmaterials.Actor{Actor: *actor}
		}
		after := ""
		if query.After != nil {
			after = *query.After
		}
		return tasks.QueryTasksWire(ctx, viewer, query.View, query.Query, after, query.Limit)
	}
	service.Opportunities = func(ctx context.Context, actor *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var query opportunities.Object
		if err := protocol.Decode(raw, &query); err != nil {
			return nil, err
		}
		return opportunitySource.QueryWire(ctx, actor, query)
	}
	return service
}

func legacySearchService(source *history.Service, proofs *evidence.ProofService, buildersSource *builders.Service, capsuleSource *capsules.Service) *discovery.LegacySearch {
	index := &discovery.LegacyIndex{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Evidence: proofs.Evidence}
	s := &discovery.LegacySearch{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Proofs: proofs, HistoryQuery: source.QueryWire, CapsulesQuery: capsuleSource.QueryWire, Index: index}
	s.BuildersQuery = func(ctx context.Context, actor *deviceauth.Actor, raw []byte, candidates []string) (json.RawMessage, error) {
		return buildersSource.QueryWire(ctx, actor, raw, builders.QueryOptions{PublicOnly: true, SourceSearch: true, CandidateIDs: candidates})
	}
	return s
}
