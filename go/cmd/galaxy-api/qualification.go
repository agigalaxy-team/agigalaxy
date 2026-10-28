package main

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
)

func qualificationService(ctx context.Context, configuration community.GovernanceRuntime, source *cases.Service, tasks *taskmaterials.Service, proofs *evidence.ProofService, inbox *notifications.Service, budget *resourcebudget.Service, deferRegistry ...bool) (*qualification.Service, error) {
	raw, ok := configuration.Configuration["qualificationPolicies"].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	policies := make([]qualification.Object, 0, len(raw))
	for _, value := range raw {
		item, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		policies = append(policies, item)
	}
	service, err := qualification.New(source.Pool, source.Endpoint, source.Devices, policies, nil)
	if err != nil {
		return nil, err
	}
	service.Assistance, service.Cases, service.Proofs, service.Resources = tasks, source, proofs, budget
	service.IsBlockedWithin = inbox.IsBlockedWithin
	if len(deferRegistry) == 0 || !deferRegistry[0] {
		if err = service.UseRegistry(ctx); err != nil {
			return nil, err
		}
	}
	tasks.ValidateQualification = service.ValidatePolicyWithin
	tasks.LegacyQualification = service.EvaluateLegacyTaskWithin
	tasks.ValidateParticipationQualification = service.ValidateParticipationWithin
	return service, nil
}
