package main

import (
	"context"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func evidenceServices(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, budget *resourcebudget.Service, policy *resourcebudget.Policy, caseService *cases.Service) (*evidence.Service, *evidence.ProofService) {
	source := &evidence.Service{Pool: pool, Endpoint: endpoint, Devices: devices, ResourceBudgetPolicy: policy}
	source.BudgetPolicyNow = budget.SnapshotPolicy
	source.ResourceWrite = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, authorize func() error, operation func() (evidence.Object, error)) (evidence.Object, error) {
		if err := deviceauth.CheckInformationWatchWrite(actor, "evidence"); err != nil {
			return nil, err
		}
		value, err := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: actor.SubjectID}, func(context.Context, pgx.Tx) error { return authorize() }, func(context.Context, pgx.Tx) (any, error) { return operation() }, resourcebudget.Options{})
		if err != nil || value == nil {
			return nil, err
		}
		result, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("internal_error", 503)
		}
		return result, nil
	}
	proofs := &evidence.ProofService{Evidence: source, CaseContext: caseService.ProofCaseContextWithin}
	if devices != nil {
		if signer, ok := devices.Signer.(evidence.ProofSigner); ok {
			proofs.Signer = signer
		}
	}
	return source, proofs
}

func evidenceHandler(service *evidence.Service, proofs *evidence.ProofService, next http.Handler) http.Handler {
	handler := evidence.Handler{Evidence: service, Proofs: proofs, Next: next}
	if service.Devices != nil {
		handler.Devices = service.Devices
	}
	return handler
}
