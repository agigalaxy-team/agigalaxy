package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/httpboundary"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/jackc/pgx/v5"
)

type profileSources struct {
	Current     *historyv2.Service
	Moderation  history.AuthorizedSource
	CapsuleUses history.AuthorizedSource
	Legacy      *history.Service
}

func legacyHistoryProjection(service *profiles.Service, proofs *evidence.ProofService) *history.Service {
	projection := &history.Service{Pool: service.Pool, Endpoint: service.Endpoint, Devices: service.Devices, Profiles: service}
	projection.Proofs = func(ctx context.Context, tx pgx.Tx, actor *deviceauth.Actor, id string) (json.RawMessage, error) {
		return proofs.ReadWireWithin(ctx, tx, actor, id, false)
	}
	return projection
}

func profileHandler(service *profiles.Service, proofs *evidence.ProofService, next http.Handler, current ...profileSources) http.Handler {
	var projection *history.Service
	if len(current) == 1 {
		projection = current[0].Legacy
	}
	if projection == nil {
		projection = legacyHistoryProjection(service, proofs)
	}
	readHistory := history.Handler{Service: projection, Next: next,
		ConsumeSearchPage: func(r *http.Request, viewer *deviceauth.Actor, after any) error {
			position, _ := after.(string)
			kind, id := "", ""
			if viewer != nil {
				kind, id = "subject", viewer.SubjectID
			}
			return httpboundary.ConsumeSearchPage(r.Context(), &position, kind, id)
		}}
	if len(current) == 1 {
		projection.Moderation = current[0].Moderation
		projection.CapsuleUses = current[0].CapsuleUses
		if current[0].Current != nil {
			readHistory.QueryV2 = current[0].Current.Query
		}
	}
	handler := profiles.Handler{Service: service, HistoryQuery: projection.Query, Next: readHistory}
	if service.Devices != nil {
		handler.Devices = service.Devices
		readHistory.Devices = service.Devices
		handler.Next = readHistory
	}
	// One current-authorized projection owns both the original history query
	// and public profile. Unmigrated source readers fail explicitly when needed.
	return handler
}
