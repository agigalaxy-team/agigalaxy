package main

import (
	"context"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func recordService(source *cases.Service, proofs *evidence.ProofService) *verificationrecords.Service {
	service := &verificationrecords.Service{Pool: source.Pool, Endpoint: source.Endpoint, Devices: source.Devices, Cases: source, Proofs: proofs, Now: source.Now,
		ResourceWrite: verificationrecords.ResourceWrite(source.ResourceWrite), TaskWrite: source.TaskWrite, Participation: source.Participation}
	prior := source.Sources
	source.Sources = func(ctx context.Context, tx pgx.Tx, actor *deviceauth.Actor, reference, contextInfo cases.Object) (cases.Object, error) {
		if kind := reference["kind"]; kind != "evidence" && kind != "verification" {
			if prior != nil {
				return prior(ctx, tx, actor, reference, contextInfo)
			}
			return nil, fault.New("source_adapter_unavailable", 503)
		}
		caseID, _ := contextInfo["caseId"].(string)
		visited, _ := contextInfo["visited"].(map[string]bool)
		return service.RequireReferenceWithin(ctx, tx, actor, reference, verificationrecords.ReferenceOptions{CaseID: caseID, Visited: visited})
	}
	source.VerificationReference = func(ctx context.Context, tx pgx.Tx, actor *deviceauth.Actor, reference cases.Object, caseID string, scope int64) (cases.Object, error) {
		return service.RequireReferenceWithin(ctx, tx, actor, reference, verificationrecords.ReferenceOptions{CaseID: caseID, ScopeVersion: &scope})
	}
	return service
}

func recordsHandler(service *verificationrecords.Service, next http.Handler) http.Handler {
	handler := verificationrecords.Handler{Service: service, Next: next}
	if service.Devices != nil {
		handler.Devices = service.Devices
	}
	return handler
}
