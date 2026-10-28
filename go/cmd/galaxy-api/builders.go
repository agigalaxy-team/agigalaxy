package main

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
)

func builderService(configuration community.GovernanceRuntime, source *cases.Service, records *verificationrecords.Service, proofs *evidence.ProofService, configs *configurations.Service) (*builders.Service, error) {
	assessors, ok := configuration.Configuration["builderAssessorIds"].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	pins, ok := configuration.Configuration["conformanceSuitePins"].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	s := &builders.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Cases: source,
		Configurations: configs, VerificationRecords: records, Proofs: proofs, ResourceWrite: builders.ResourceWrite(source.ResourceWrite),
		AssessorIDs: []string{}, SuitePins: []builders.Object{}}
	for _, raw := range assessors {
		value, ok := raw.(string)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		s.AssessorIDs = append(s.AssessorIDs, value)
	}
	for _, raw := range pins {
		value, ok := raw.(map[string]any)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		s.SuitePins = append(s.SuitePins, value)
	}
	if source.Devices != nil {
		if signer, ok := source.Devices.Signer.(*deviceauth.SessionKeyring); ok {
			s.SignConformance = func(ctx context.Context, kind string, data any, id string, ttl int64) (string, error) {
				return signer.SignConformance(ctx, kind, data, id, time.Now().Unix(), ttl)
			}
		}
	}
	return s, nil
}
