package identitygroups

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/jackc/pgx/v5"
)

func (s *Service) SourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object, authorApproval bool) (Object, error) {
	if a != nil && !authorApproval && !hasStrings(a.Scopes, "history") && !(ref["kind"] == "case-event" && hasStrings(a.Scopes, "case-teaser")) {
		return nil, fault.New("identity_group_source_scope_required", 403)
	}
	var row Object
	var e error
	if ref["kind"] == "case-event" {
		if ref["caseId"] == nil {
			return nil, fault.New("identity_group_source_unavailable", 404)
		}
		row, e = one(ctx, tx, "SELECT * FROM case_events WHERE id=$1 AND case_id=$2 AND version=$3", ref["id"], ref["caseId"], ref["version"])
		if e != nil {
			return nil, e
		}
		if txt(row, "payload_text") == "" {
			return nil, fault.New("identity_group_source_unavailable", 404)
		}
		if s.Cases == nil {
			return nil, fault.New("identity_group_case_source_unavailable", 503)
		}
		container, e := s.Cases.CaseWithin(ctx, tx, txt(ref, "caseId"))
		if e != nil {
			return nil, e
		}
		parent := obj(container["parent"])
		if parent == nil || parent["state"] == "withdrawn" {
			return nil, fault.New("identity_group_source_unavailable", 404)
		}
		rows := []Object{}
		for _, v := range arr(container["rows"]) {
			rows = append(rows, obj(v))
		}
		if typed, ok := container["rows"].([]map[string]any); ok {
			rows = typed
		}
		view, e := s.Cases.ProjectAuthorizedWithin(ctx, tx, a, parent, rows)
		if e != nil {
			return nil, e
		}
		found := false
		for _, v := range arr(obj(view["view"])["events"]) {
			event := obj(v)
			found = found || event["eventId"] == ref["id"] && num(event, "caseVersion") == num(ref, "version")
		}
		if !found {
			return nil, fault.New("identity_group_source_unavailable", 404)
		}
		if obj(row["payload"])["actorId"] != row["subject_id"] {
			return nil, fault.New("identity_group_legacy_author_unknown", 409)
		}
	} else {
		if s.Configurations == nil {
			return nil, fault.New("identity_group_configuration_source_unavailable", 503)
		}
		if _, e = s.Configurations.RequireReferenceWithin(ctx, tx, a, ref); e != nil {
			return nil, e
		}
		row, e = one(ctx, tx, "SELECT * FROM configuration_events WHERE configuration_id=$1 AND version=$2", ref["id"], ref["version"])
		if e != nil {
			return nil, e
		}
	}
	if txt(row, "payload_text") == "" || identity.Digest([]byte(txt(row, "payload_text"))) != row["payload_hash"] {
		return nil, fault.New("identity_group_source_unavailable", 404)
	}
	if row["subject_id"] != ref["originalSubjectId"] || row["payload_hash"] != ref["sourceHash"] {
		return nil, fault.New("identity_group_source_changed", 409)
	}
	pending, e := s.deletionPending(ctx, tx, []string{txt(row, "subject_id")})
	if e != nil {
		return nil, e
	}
	if pending {
		return nil, fault.New("identity_group_source_deletion_pending", 409)
	}
	record, e := jstext.DecodeJSON([]byte(txt(row, "payload_text")))
	if e != nil {
		return nil, e
	}
	return Object{"ref": ref, "originalSubjectId": row["subject_id"], "sourceHash": row["payload_hash"], "record": record, "signatureSubjectId": row["subject_id"], "sourceAuthority": "original-authored-record; not-execution-or-capability-certification", "accessGranted": false}, nil
}
func hasStrings(values []string, value string) bool {
	for _, x := range values {
		if x == value {
			return true
		}
	}
	return false
}
func (s *Service) Source(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("identityGroupSourceSelectionSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var row Object
		var e error
		if in["kind"] == "configuration" {
			row, e = one(ctx, tx, "SELECT subject_id,payload_hash FROM configuration_events WHERE configuration_id=$1 AND version=$2", in["id"], in["version"])
		} else {
			row, e = one(ctx, tx, "SELECT subject_id,payload_hash FROM case_events WHERE id=$1 AND version=$2 AND case_id=$3", in["id"], in["version"], in["caseId"])
		}
		if e != nil {
			return nil, e
		}
		if row == nil || row["subject_id"] != a.SubjectID {
			return nil, fault.New("identity_group_source_unavailable", 404)
		}
		ref := clone(in)
		ref["sourceHash"] = row["payload_hash"]
		ref["originalSubjectId"] = row["subject_id"]
		value, e := s.SourceWithin(ctx, tx, &a, ref, false)
		if e != nil {
			return nil, e
		}
		value["selectedOnly"] = true
		value["groupHasNotBeenPublished"] = true
		return value, nil
	})
}
func (s *Service) approvedSources(ctx context.Context, tx pgx.Tx, p Object) error {
	if p["kind"] == "revoke" {
		return nil
	}
	for _, raw := range arr(p["sourceRefs"]) {
		ref := obj(raw)
		actor := &deviceauth.Actor{SubjectID: txt(ref, "originalSubjectId")}
		source, e := s.SourceWithin(ctx, tx, actor, ref, true)
		if e != nil {
			return e
		}
		if source["originalSubjectId"] != ref["originalSubjectId"] {
			return fault.New("identity_group_source_author_changed", 409)
		}
	}
	return nil
}
func (s *Service) sources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, refs []any) ([]any, error) {
	out := []any{}
	for _, raw := range refs {
		ref := obj(raw)
		v, e := s.SourceWithin(ctx, tx, a, ref, false)
		if e != nil {
			if !unavailable(e) {
				return nil, e
			}
			out = append(out, Object{"ref": ref, "state": "unavailable", "record": nil})
		} else {
			v["state"] = "readable"
			out = append(out, v)
		}
	}
	return out, nil
}
