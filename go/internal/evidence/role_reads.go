package evidence

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) require(ctx context.Context, tx pgx.Tx, r deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error) {
	if s.ConsentReader != nil {
		return s.ConsentReader(ctx, tx, r)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("evidence_service_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, r)
}

// WorkerCaseStateWithin uses the already provisioned original narrow worker
// function; runtime code never provisions roles or grants UPDATE on Case.
func (s *Service) WorkerCaseStateWithin(ctx context.Context, tx pgx.Tx, id, subject string) (string, error) {
	var state string
	e := tx.QueryRow(ctx, `SELECT state FROM public.galaxy_worker_lock_case($1,$2)`, id, subject).Scan(&state)
	return state, e
}
