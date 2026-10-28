package experiencereviews

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) visible(g deviceauth.ConsentIntent, viewer string) bool {
	if g.IssuedAt > s.now() || g.ExpiresAt <= s.now() {
		return false
	}
	if viewer == g.SubjectID {
		return true
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return false
	}
	if g.Visibility == "Public" {
		return g.Purpose == "public-profile"
	}
	if g.Visibility == "Private" && viewer != "" {
		for _, id := range g.Viewers {
			if id == viewer {
				return true
			}
		}
	}
	return false
}
func (s *Service) visibleEvent(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, object, event Object, read func(Object) error) error {
	if event == nil || str(event, "payload_text") == "" {
		return fail("experience_unavailable", 404)
	}
	if read != nil {
		source := Object{}
		for k, v := range event {
			source[k] = v
		}
		source["id"], source["subject_id"] = event["operation_id"], object["subject_id"]
		return read(source)
	}
	g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(event, "consent_id"), SubjectID: str(object, "subject_id"), ObjectID: str(event, "operation_id"), Action: "experience.submit", Recipient: s.Endpoint, PayloadJSON: str(event, "payload_text")})
	if e != nil {
		return e
	}
	viewer := ""
	if a != nil {
		viewer = a.SubjectID
	}
	if !s.visible(g, viewer) {
		return fail("experience_unavailable", 404)
	}
	return nil
}
func (s *Service) readWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, version int64, visited map[string]bool, read func(Object) error) (Object, error) {
	if visited[id] {
		return nil, fail("experience_source_cycle")
	}
	visited[id] = true
	defer delete(visited, id)
	current, e := row(ctx, tx, "SELECT to_jsonb(o) FROM experience_objects o WHERE id=$1 FOR SHARE", id)
	if e != nil {
		return nil, e
	}
	if current == nil {
		return nil, fail("experience_unavailable", 404)
	}
	if version == 0 {
		version = number(current["version"])
	}
	event, e := row(ctx, tx, "SELECT to_jsonb(e) FROM experience_events e WHERE object_id=$1 AND version=$2", id, version)
	if e != nil {
		return nil, e
	}
	if e = s.visibleEvent(ctx, tx, a, current, event, read); e != nil {
		return nil, e
	}
	decoded, e := decodeValue([]byte(str(event, "payload_text")))
	if e != nil {
		return nil, e
	}
	record := object(decoded)
	base := Object{"id": id, "type": current["object_type"], "subjectId": current["subject_id"], "version": event["version"], "currentVersion": current["version"], "synthetic": record["synthetic"], "sourceGroup": current["source_key"], "capabilityVerified": false, "taskOutcomeVerified": false, "authority": "signed-author-or-registered-reviewer-report; not-automatic-external-verification"}
	if current["state"] == "revoked" {
		base["record"], base["referenceStatus"] = nil, "revoked"
		return base, nil
	}
	status := "superseded"
	if number(event["version"]) == number(current["version"]) {
		status = "current"
	}
	if v := record["expiresAt"]; v != nil {
		if t, e := date(v); e == nil && t.UnixMilli() <= s.now()*1000 {
			status = "expired"
		}
	}
	if current["object_type"] != "review" {
		base["record"], base["referenceStatus"], base["verification"] = record, status, "not-reviewed-by-this-statement"
		return base, nil
	}
	return s.reviewProjection(ctx, tx, a, current, record, base, status, visited, read)
}
func (s *Service) reviewProjection(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, current, record, base Object, status string, visited map[string]bool, read func(Object) error) (Object, error) {
	source, e := func() (Object, error) {
		ref := object(record["experienceRef"])
		source, e := s.readWithin(ctx, tx, a, str(ref, "id"), number(ref["version"]), visited, read)
		if e != nil {
			return nil, e
		}
		sourceRecord := object(source["record"])
		if source["referenceStatus"] != "current" || sourceRecord == nil {
			return nil, fail("experience_source_unavailable")
		}
		reviewer, e := s.reviewerWithin(ctx, tx, str(current, "subject_id"), str(record, "capabilityId"), str(sourceRecord, "kind"))
		if e != nil {
			return nil, e
		}
		if e = s.independent(ctx, tx, str(current, "subject_id"), str(sourceRecord, "subjectId")); e != nil {
			return nil, e
		}
		out := Object{}
		for k, v := range base {
			out[k] = v
		}
		out["sourceGroup"], out["experienceSubjectId"], out["experienceKind"], out["record"], out["referenceStatus"], out["source"] = source["sourceGroup"], sourceRecord["subjectId"], sourceRecord["kind"], record, status, source
		out["reviewer"] = Object{"subjectId": reviewer["subjectId"], "scope": reviewer["scope"], "authorityReference": reviewer["authorityReference"]}
		out["synthetic"], out["registeredRuntimeReviewer"], out["independence"] = record["synthetic"] == true || source["synthetic"] == true || reviewer["synthetic"] == true, s.registryEnabled, "registered-nonparty-claim; undisclosed-control-relationships-not-inferred"
		return out, nil
	}()
	if e != nil {
		if !unavailable(e) {
			return nil, e
		}
		base["record"], base["referenceStatus"], base["reason"] = nil, "dependency-unavailable", fault.Code(e)
		return base, nil
	}
	return source, nil
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, version int64) (Object, error) {
	return s.readWithin(ctx, tx, a, id, version, map[string]bool{}, nil)
}
func (s *Service) ReadCalculationWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object, read func(Object) error) (Object, error) {
	if read == nil {
		return nil, fail("qualification_calculation_unavailable", 503)
	}
	return s.readWithin(ctx, tx, &a, str(ref, "id"), number(ref["version"]), map[string]bool{}, read)
}

// QualificationReadWithin consumes the existing {id,version} exact reference
// inside the caller's real assistance transaction, without an extra scope gate.
func (s *Service) QualificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object) (Object, error) {
	if e := ParseRead(ref); e != nil {
		return nil, e
	}
	return s.ReadWithin(ctx, tx, &a, str(ref, "id"), number(ref["version"]))
}
func (s *Service) Read(ctx context.Context, a Actor, input Object) (any, error) {
	if e := ParseRead(input); e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return s.ReadWithin(ctx, tx, &a.Actor, str(input, "id"), number(input["version"]))
	})
}
