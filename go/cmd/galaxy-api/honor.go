package main

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func honorService(ctx context.Context, configuration community.GovernanceRuntime, q *qualification.Service, tasks *taskmaterials.Service, proofs *evidence.ProofService, sharing *contributions.Service, ci *civ2.Service, deferRegistry ...bool) (*honor.Service, error) {
	raw, ok := configuration.Configuration["honorRules"].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	rules := make([]honor.Object, 0, len(raw))
	for _, value := range raw {
		rule, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		rules = append(rules, rule)
	}
	s, err := honor.New(q.Pool, q.Endpoint, q.Devices, rules, nil)
	if err != nil {
		return nil, err
	}
	s.Assistance, s.Proofs, s.Qualification, s.Sharing, s.CI = tasks, proofs, q, sharing, ci
	if len(deferRegistry) == 0 || !deferRegistry[0] {
		if err = s.UseRegistry(ctx); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func honorInformationSource(s *honor.Service) information.SourceReader {
	return func(ctx context.Context, actor *deviceauth.Actor, raw []byte) (information.Object, error) {
		var input honor.Object
		if err := protocol.Decode(json.RawMessage(raw), &input); err != nil {
			return nil, err
		}
		var viewer *honor.Actor
		if actor != nil {
			viewer = &honor.Actor{Actor: *actor}
		}
		return s.QueryV2(ctx, viewer, input)
	}
}
