package verificationrecords

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type Service struct {
	grantAuthor   string
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Cases         *cases.Service
	Proofs        *evidence.ProofService
	Now           func() time.Time
	ResourceWrite ResourceWrite
	TaskWrite     func(context.Context, pgx.Tx, deviceauth.Actor, string) (Object, error)
	Participation func(context.Context, pgx.Tx, deviceauth.Actor, string, string) (Object, error)
	CIProofWithin func(context.Context, pgx.Tx, *deviceauth.Actor, string) (Object, error)
	// These ports serve only the original signed-request-bound CI reader.
	// They confer no entry credential and cannot be selected by an HTTP caller.
	CaseRead      func(context.Context, pgx.Tx, string) (Object, error)
	RecordRead    func(context.Context, pgx.Tx, string) (Object, error)
	ConsentReader func(context.Context, pgx.Tx, deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error)
	ReadRecipient string
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("verification_records_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error { var e error; auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, "evidence"); return e }
		operation := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, control, authorize, operation)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	})
}
func (s *Service) require(ctx context.Context, tx pgx.Tx, r deviceauth.ConsentRequirement) (deviceauth.ConsentIntent, error) {
	if s.ConsentReader != nil {
		return s.ConsentReader(ctx, tx, r)
	}
	if s.Devices == nil {
		return deviceauth.ConsentIntent{}, fault.New("verification_records_unavailable", 503)
	}
	return s.Devices.RequireConsentWithin(ctx, tx, r)
}
func (s *Service) viewer(a *deviceauth.Actor) *string {
	if s.ReadRecipient != "" {
		return &s.ReadRecipient
	}
	if a != nil {
		return &a.SubjectID
	}
	return nil
}
func (s *Service) visible(intent deviceauth.ConsentIntent, a *deviceauth.Actor) bool {
	viewer := s.viewer(a)
	if intent.IssuedAt > s.now() || intent.ExpiresAt <= s.now() {
		return false
	}
	if viewer != nil && *viewer == intent.SubjectID {
		return true
	}
	if intent.CurrentVisibility != nil && intent.CurrentVisibility.DeletionPending {
		return false
	}
	if intent.Visibility == "Public" {
		return intent.Purpose == "public-profile"
	}
	if viewer != nil && (intent.Visibility == "Private" || intent.Visibility == "Hub-scoped" && intent.Recipient == s.Endpoint) {
		for _, id := range intent.Viewers {
			if *viewer == id {
				return true
			}
		}
	}
	return false
}
func (s *Service) CaseWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if s.CaseRead != nil {
		return s.CaseRead(ctx, tx, id)
	}
	if s.Cases == nil {
		return nil, fault.New("case_service_unavailable", 503)
	}
	return s.Cases.CaseWithin(ctx, tx, id)
}
func (s *Service) readObject(ctx context.Context, tx pgx.Tx, id string) (*recordObject, error) {
	if s.RecordRead == nil {
		return loadObject(ctx, tx, id, "SHARE")
	}
	v, e := s.RecordRead(ctx, tx, id)
	if e != nil || v == nil {
		return nil, e
	}
	return &recordObject{ID: str(v, "id"), Type: str(v, "object_type"), CaseID: str(v, "case_id"), Subject: str(v, "subject_id"), Version: num(v, "version"), State: str(v, "state")}, nil
}
func (s *Service) caseReadEvent(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) error {
	if s.ReadRecipient == "" {
		if s.Cases == nil {
			return fault.New("case_service_unavailable", 503)
		}
		_, e := s.Cases.RequireEventVisibleWithin(ctx, tx, a, row)
		return e
	}
	if row == nil || str(row, "payload_text") == "" {
		return fault.New("case_event_unavailable", 404)
	}
	grant, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: str(row, "consent_id"), SubjectID: str(row, "subject_id"), Action: "case.teaser.publish", ObjectID: str(row, "id"), Recipient: s.Endpoint, PayloadJSON: str(row, "payload_text")})
	if e != nil {
		return e
	}
	if !s.visible(grant, a) {
		return fault.New("origin_not_authorized", 403)
	}
	return nil
}

type TargetOptions struct {
	CaseID       string
	ScopeVersion *int64
	Latest       bool
	Visited      map[string]bool
}

func (s *Service) TargetWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, target Object, opts TargetOptions) (Object, error) {
	if s.Cases == nil {
		return nil, fault.New("case_service_unavailable", 503)
	}
	context, e := s.CaseWithin(ctx, tx, opts.CaseID)
	if e != nil {
		return nil, e
	}
	parent, facts := obj(context["parent"]), obj(context["facts"])
	if parent["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	current := cases.LatestFact(facts, str(target, "type"), str(target, "id"))
	if current == nil {
		return nil, fault.New("target_not_found", 422)
	}
	if opts.Latest && num(current, "version") != num(target, "version") {
		return nil, fault.New("target_version_changed", 409)
	}
	rows, ok := context["rows"].([]Object)
	if !ok {
		return nil, fmt.Errorf("case source rows unavailable")
	}
	options := cases.FactOptions{Visited: opts.Visited}
	if s.ReadRecipient != "" {
		options.ReadEventWithin = func(row Object) error { return s.caseReadEvent(ctx, tx, a, row) }
	}
	var fact Object
	if s.grantAuthor != "" {
		fact, e = s.Cases.RequireFactGrantAuthorWithin(ctx, tx, s.grantAuthor, rows, facts, str(target, "type"), target, options)
	} else {
		fact, e = s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, str(target, "type"), target, options)
	}
	if e != nil {
		return nil, e
	}
	if opts.ScopeVersion != nil && num(fact, "scopeVersion") != *opts.ScopeVersion {
		return nil, fault.New("target_scope_changed", 409)
	}
	return Object{"fact": fact, "currentVersion": current["version"], "requesterId": parent["subject_id"]}, nil
}
func (s *Service) visibleWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, o *recordObject, event *recordEvent) error {
	if identity.Digest([]byte(event.PayloadText)) != event.Hash {
		return fault.New("stored_integrity_mismatch", 500)
	}
	grant, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: event.ConsentID, SubjectID: o.Subject, Action: "evidence.submit", ObjectID: event.OperationID, Recipient: s.Endpoint, PayloadJSON: event.PayloadText})
	if e != nil {
		return e
	}
	if !s.visible(grant, a) {
		return fault.New("record_not_authorized", 403)
	}
	return nil
}
func isService(e error) bool          { var se *fault.Error; return errors.As(e, &se) }
func at(o Object, k string) time.Time { v, _ := time.Parse(time.RFC3339Nano, str(o, k)); return v }
