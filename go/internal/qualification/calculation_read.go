package qualification

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

type CalculationContext struct {
	Payload         Object
	GrantID         string
	ReadEventWithin func(string, Object) error
}
type calculationRead struct {
	Row, Payload Object
	Grant        deviceauth.ConsentIntent
}

func readRow(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var out Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&out)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return out, e
}
func calculationAction(kind string) string {
	if kind == "compute" {
		return "qualification.compute"
	}
	return "qualification.source-permission"
}
func sourceKey(ref Object) string {
	return str(ref, "kind") + ":" + str(ref, "id") + ":" + str(ref, "payloadHash")
}
func (s *Service) calculationSourceWithin(ctx context.Context, tx pgx.Tx, ref Object) (Object, error) {
	var sql string
	switch ref["kind"] {
	case "experience-event":
		sql = "SELECT to_jsonb(e)||jsonb_build_object('id',e.operation_id,'subject_id',o.subject_id) FROM experience_events e JOIN experience_objects o ON o.id=e.object_id WHERE e.operation_id=$1"
	case "case-event":
		sql = "SELECT to_jsonb(e) FROM case_events e WHERE id=$1"
	case "task-event":
		sql = "SELECT to_jsonb(e) FROM task_events e WHERE id=$1"
	default:
		return nil, fail("qualification_source_unavailable", 403)
	}
	row, e := readRow(ctx, tx, sql, ref["id"])
	if e != nil {
		return nil, e
	}
	if row == nil || str(row, "payload_text") == "" || row["payload_hash"] != ref["payloadHash"] {
		return nil, fail("qualification_source_unavailable", 403)
	}
	return row, nil
}
func (s *Service) calculationSourceGrant(ctx context.Context, tx pgx.Tx, ref, row Object) (deviceauth.ConsentIntent, error) {
	action := "assistance.publish"
	if ref["kind"] == "case-event" {
		action = "case.teaser.publish"
	} else if ref["kind"] == "experience-event" {
		action = "experience.submit"
	}
	g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(row, "consent_id"), SubjectID: str(row, "subject_id"), ObjectID: str(row, "id"), Action: action, Recipient: s.Endpoint, PayloadJSON: str(row, "payload_text")})
	if e != nil {
		return g, e
	}
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending {
		return g, fail("qualification_source_unavailable", 403)
	}
	return g, nil
}
func (s *Service) readCalculationWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (calculationRead, error) {
	out := calculationRead{}
	r, e := readRow(ctx, tx, "SELECT to_jsonb(g) FROM qualification_calculation_grants g WHERE id=$1 FOR SHARE", id)
	if e != nil {
		return out, e
	}
	if r == nil || str(r, "payload_text") == "" || r["revoked_at"] != nil {
		return out, fail("qualification_calculation_unavailable", 403)
	}
	p, e := ParseCalculation([]byte(str(r, "payload_text")))
	if e != nil {
		return out, e
	}
	if p["kind"] == "revoke" {
		return out, fail("qualification_calculation_unavailable", 403)
	}
	g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(r, "consent_id"), SubjectID: str(r, "subject_id"), ObjectID: str(r, "id"), Action: calculationAction(str(p, "kind")), Recipient: s.Endpoint, PayloadJSON: str(r, "payload_text")})
	if e != nil {
		return out, e
	}
	if s.Assistance == nil {
		return out, fail("qualification_assistance_unavailable", 503)
	}
	expiry, _ := parseDatetime(p["expiresAt"])
	if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending || !s.Assistance.LegacySourceVisible(g, a.SubjectID) || expiry.UnixMilli() <= s.now()*1000 {
		return out, fail("qualification_calculation_unavailable", 403)
	}
	return calculationRead{Row: r, Payload: p, Grant: g}, nil
}
func (s *Service) calculationPermissions(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, compute Object) (map[string]string, error) {
	covered := map[string]string{}
	for _, id := range array(compute["permissionIds"]) {
		p, e := s.readCalculationWithin(ctx, tx, a, text(id))
		if e != nil {
			return nil, e
		}
		if p.Payload["kind"] != "source-permission" {
			return nil, fail("qualification_source_permission_required", 403)
		}
		for _, key := range []string{"taskId", "candidateId", "recipientId", "purpose", "disclosure"} {
			if p.Payload[key] != compute[key] {
				return nil, fail("qualification_source_permission_scope_mismatch", 403)
			}
		}
		for _, v := range array(p.Payload["sourceRefs"]) {
			ref := object(v)
			row, e := s.calculationSourceWithin(ctx, tx, ref)
			if e != nil {
				return nil, e
			}
			if row["subject_id"] != p.Row["subject_id"] {
				return nil, fail("qualification_source_permission_author_mismatch", 403)
			}
			if _, e = s.calculationSourceGrant(ctx, tx, ref, row); e != nil {
				return nil, e
			}
			covered[sourceKey(ref)] = str(row, "subject_id")
		}
	}
	return covered, nil
}
func (s *Service) authorizeCalculationRead(ctx context.Context, tx pgx.Tx, compute Object, covered map[string]string, kind string, row Object) error {
	if row == nil || row["id"] == nil || str(row, "payload_text") == "" {
		return fail("qualification_source_unavailable", 403)
	}
	var ref Object
	for _, v := range array(compute["sourceRefs"]) {
		r := object(v)
		if r["kind"] == kind && r["id"] == row["id"] && r["payloadHash"] == row["payload_hash"] {
			ref = r
			break
		}
	}
	if ref == nil {
		return fail("qualification_source_not_selected", 403)
	}
	g, e := s.calculationSourceGrant(ctx, tx, ref, row)
	if e != nil {
		return e
	}
	if !s.Assistance.LegacySourceVisible(g, str(compute, "candidateId")) {
		return fail("qualification_candidate_source_unavailable", 403)
	}
	if row["subject_id"] != compute["candidateId"] && covered[sourceKey(ref)] != row["subject_id"] {
		return fail("qualification_source_permission_required", 403)
	}
	return nil
}
func omitCalculationGrant(e Object) Object {
	out := Object{}
	for k, v := range e {
		if k != "calculationGrantId" {
			out[k] = v
		}
	}
	return out
}
func (s *Service) CalculationContextWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, q Object) (*CalculationContext, error) {
	id := str(object(q["evidence"]), "calculationGrantId")
	if id == "" {
		return nil, fail("qualification_calculation_required", 403)
	}
	read, e := s.readCalculationWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	c := read.Payload
	if c["kind"] != "compute" || read.Row["subject_id"] != q["subjectId"] || c["candidateId"] != q["subjectId"] || a.SubjectID != c["candidateId"] && a.SubjectID != c["recipientId"] || c["taskId"] != q["taskId"] {
		return nil, fail("qualification_calculation_scope_mismatch", 403)
	}
	var requester string
	if e = tx.QueryRow(ctx, "SELECT requester_id FROM task_requests WHERE id=$1", q["taskId"]).Scan(&requester); e != nil && e != pgx.ErrNoRows {
		return nil, e
	}
	if e == pgx.ErrNoRows || requester != c["recipientId"] {
		return nil, fail("qualification_calculation_recipient_mismatch", 403)
	}
	left, e := identity.Canonical(omitCalculationGrant(object(c["evidence"])))
	if e != nil {
		return nil, e
	}
	right, e := identity.Canonical(omitCalculationGrant(object(q["evidence"])))
	if e != nil {
		return nil, e
	}
	if string(left) != string(right) {
		return nil, fail("qualification_calculation_evidence_mismatch", 403)
	}
	covered, e := s.calculationPermissions(ctx, tx, a, c)
	if e != nil {
		return nil, e
	}
	return &CalculationContext{Payload: c, GrantID: str(read.Row, "id"), ReadEventWithin: func(kind string, row Object) error { return s.authorizeCalculationRead(ctx, tx, c, covered, kind, row) }}, nil
}
