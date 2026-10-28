package main

import (
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
)

func ciService(records *verificationrecords.Service, source *cases.Service, proofs *evidence.ProofService, policy *resourcebudget.Policy) *civ2.Service {
	service := &civ2.Service{Pool: records.Pool, Endpoint: records.Endpoint, Devices: records.Devices, Records: records, Signer: proofs.Signer, ResourceWrite: civ2.ResourceWrite(source.ResourceWrite), ResourceBudgetPolicy: policy}
	records.CIProofWithin = service.ProofWithin
	return service
}

func ciHandler(service *civ2.Service, next http.Handler) http.Handler {
	handler := civ2.Handler{Service: service, Next: next}
	if service.Devices != nil {
		handler.Devices = service.Devices
	}
	return handler
}
