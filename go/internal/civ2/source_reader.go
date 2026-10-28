package civ2

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"time"
)

func options(context Object) verificationrecords.ReferenceOptions {
	opts := verificationrecords.ReferenceOptions{CaseID: str(context, "caseId")}
	if v, ok := context["visited"].(map[string]bool); ok {
		opts.Visited = v
	}
	return opts
}
func (s *Service) recipientReader(subject string) (*verificationrecords.Service, error) {
	if s.Records == nil || s.Records.Cases == nil {
		return nil, fault.New("ci_source_reader_unavailable", 503)
	}
	r := *s.Records
	r.ReadRecipient = subject
	if s.ConsentReader != nil {
		r.ConsentReader = s.ConsentReader
	}
	c := *r.Cases
	r.Cases = &c
	c.Sources = func(ctx context.Context, tx pgx.Tx, _ *deviceauth.Actor, ref, context Object) (Object, error) {
		if one(ref["kind"], "evidence", "verification") {
			return r.RequireReferenceWithin(ctx, tx, nil, ref, options(context))
		}
		if s.ReferenceForRecipient != nil {
			return s.ReferenceForRecipient(ctx, tx, subject, ref, context)
		}
		return nil, fault.New("source_adapter_unavailable", 503)
	}
	c.VerificationReference = func(ctx context.Context, tx pgx.Tx, _ *deviceauth.Actor, ref Object, caseID string, scope int64) (Object, error) {
		return r.RequireReferenceWithin(ctx, tx, nil, ref, verificationrecords.ReferenceOptions{CaseID: caseID, ScopeVersion: &scope})
	}
	return &r, nil
}
func (s *Service) reader(row *requestRow) (*verificationrecords.Service, error) {
	if s.SourceReader != nil {
		return s.SourceReader(row.ID, row.Subject)
	}
	return s.recipientReader(row.Subject)
}

// WorkerSourceReader creates the original signed-request-bound reader. It has
// no user session, cannot select an account and cannot write Case/record data.
func (s *Service) WorkerSourceReader(requestID, subject string) (*verificationrecords.Service, error) {
	r, e := s.recipientReader(subject)
	if e != nil {
		return nil, e
	}
	r.CaseRead = func(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
		var parentID, owner, localRef, sourceRef, state string
		var version int64
		var created time.Time
		e := tx.QueryRow(ctx, `SELECT id::text,subject_id,local_ref,source_ref,version,state,created_at FROM public.galaxy_worker_lock_ci_case($1,$2)`, requestID, id).Scan(&parentID, &owner, &localRef, &sourceRef, &version, &state, &created)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fault.New("case_unavailable", 404)
		}
		if e != nil {
			return nil, e
		}
		// The retained SQL function has a case_id name collision. Require its
		// returned identity to match before reading the requested event ledger.
		if parentID != id {
			return nil, fault.New("case_unavailable", 404)
		}
		parent := Object{"id": parentID, "subject_id": owner, "local_ref": localRef, "source_ref": sourceRef, "version": version, "state": state, "created_at": created.UTC().Format("2006-01-02T15:04:05.000Z")}
		rows, e := r.Cases.RowsForLockedCaseWithin(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		return Object{"parent": parent, "rows": rows, "facts": cases.ProjectFacts(rows, parent)}, nil
	}
	r.RecordRead = func(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
		var recordID, kind, caseID, owner, state string
		var version int64
		e := tx.QueryRow(ctx, `SELECT id::text,object_type,case_id::text,subject_id,version,state FROM public.galaxy_worker_lock_ci_record($1,$2)`, requestID, id).Scan(&recordID, &kind, &caseID, &owner, &version, &state)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		return Object{"id": recordID, "object_type": kind, "case_id": caseID, "subject_id": owner, "version": version, "state": state}, nil
	}
	r.Cases.Sources = func(ctx context.Context, tx pgx.Tx, _ *deviceauth.Actor, ref, context Object) (Object, error) {
		return r.RequireReferenceWithin(ctx, tx, nil, ref, options(context))
	}
	return r, nil
}
