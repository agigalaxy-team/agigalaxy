package evidence

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ModerationTargetWithin is the original exact Case/result evidence target.
// viewer is a recipient already established by the signed moderation consumer,
// not a fabricated device session or a public HTTP identity parameter.
func (s *Service) ModerationTargetWithin(ctx context.Context, tx pgx.Tx, viewer, caseID, targetEventID, evidenceID string) (Object, error) {
	r, e := load(ctx, tx, evidenceID, "", "")
	if e != nil {
		return nil, e
	}
	if r == nil || r.CaseID != caseID || r.ResultID != targetEventID {
		return nil, fault.New("not_found", 404)
	}
	if e = s.LiveWithin(ctx, tx, *r); e != nil {
		return nil, e
	}
	g, e := s.require(ctx, tx, deviceauth.ConsentRequirement{ID: r.ConsentID, SubjectID: r.Subject, Action: "evidence.submit", ObjectID: r.ID, Recipient: s.Endpoint, PayloadJSON: r.Payload})
	if e != nil {
		return nil, e
	}
	if !readableFor(g, &viewer, s.now(), true) {
		return nil, fault.New("not_found", 404)
	}
	return Object{"id": r.ID, "subject_id": r.Subject, "case_id": r.CaseID, "result_id": r.ResultID, "consent_id": r.ConsentID, "source_key": r.SourceKey, "payload_text": r.Payload, "payload_hash": r.Hash, "state": r.State}, nil
}
func (s *Service) ModerationVerificationWithin(ctx context.Context, tx pgx.Tx, evidenceID string) (Object, error) {
	source, e := s.source()
	if e != nil {
		return nil, e
	}
	latest, e := currentJob(ctx, tx, evidenceID, source.JobKind())
	if e != nil {
		return nil, e
	}
	attempts, e := observations(ctx, tx, evidenceID, 1)
	if e != nil {
		return nil, e
	}
	state := "unavailable"
	if latest != nil {
		state = str(latest, "state")
	}
	var observed any
	if len(attempts) > 0 && latest != nil && attempts[0].JobID == latest["id"] {
		last := attempts[0]
		wire := protocol.NewOrderedObject()
		wire.Set("id", last.ID)
		if original, ok := last.Value.(*protocol.OrderedObject); ok {
			for _, key := range original.Keys() {
				wire.Set(key, original.Values()[key])
			}
		}
		observed = wire
	}
	return Object{"evidenceId": evidenceID, "generation": num(obj(obj(latest["payload"])["revalidation"]), "generation"), "state": state, "observation": observed}, nil
}

// Prepare is called after the owning moderation transaction has checked the
// exact target and original moderator/Consent authority. It never inserts a job.
func (s *Service) PrepareModerationRevalidationWithin(ctx context.Context, tx pgx.Tx, evidenceID, eventID, reportID, consentID, subjectID string) (Object, error) {
	source, e := s.source()
	if e != nil {
		return nil, e
	}
	latest, e := currentJob(ctx, tx, evidenceID, source.JobKind())
	if e != nil {
		return nil, e
	}
	if latest != nil && one(latest["state"], "pending", "running") {
		return nil, fault.New("verification_already_pending", 409)
	}
	generation := num(obj(obj(latest["payload"])["revalidation"]), "generation") + 1
	if generation > 20 {
		return nil, fault.New("verification_revalidation_limit", 429)
	}
	return Object{"id": uuid.NewString(), "kind": source.JobKind(), "payload": Object{"evidenceId": evidenceID, "revalidation": Object{"generation": generation, "eventId": eventID, "reportId": reportID, "consentId": consentID, "subjectId": subjectID}}}, nil
}

// Enqueue follows insertion of the original moderation event in this same
// transaction. The worker still rechecks that event's exact signed grant.
func (s *Service) EnqueueModerationRevalidationWithin(ctx context.Context, tx pgx.Tx, job Object) error {
	payload := obj(job["payload"])
	command := obj(payload["revalidation"])
	if _, e := tx.Exec(ctx, `INSERT INTO jobs(id,kind,deduplication_key,payload) VALUES($1,$2,$3,$4::jsonb)`, job["id"], job["kind"], "revalidate:"+str(command, "eventId"), string(encode(payload))); e != nil {
		return e
	}
	if s.Tasks != nil {
		return s.Tasks(ctx, tx, str(job, "id"), str(payload, "evidenceId"), str(job, "kind"))
	}
	return nil
}
