package capsules

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func sourceKey(ref Object) string {
	return fmt.Sprintf("%s:%s:%d", text(ref, "kind"), text(ref, "id"), number(ref, "version"))
}
func fmtVersion(ref Object) string         { return fmt.Sprintf("%d", number(ref, "version")) }
func dependency(key, author string) Object { return Object{"key": key, "authorId": author} }
func dependenciesUnique(values []any) []any {
	out := []any{}
	indices := map[string]int{}
	for _, v := range values {
		k := text(obj(v), "key")
		if i, ok := indices[k]; ok {
			out[i] = v
		} else {
			indices[k] = len(out)
			out = append(out, v)
		}
	}
	return out
}
func (s *Service) caseWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if s.Cases == nil {
		return nil, fault.New("capsule_source_unavailable", 503)
	}
	o, e := s.Cases.CaseWithin(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if obj(o["parent"])["state"] == "withdrawn" {
		return nil, fault.New("capsule_source_unavailable", 403)
	}
	return o, nil
}
func (s *Service) currentness(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, rows []Object, facts Object, kind string, ref Object) (string, error) {
	_, e := s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, kind, ref, cases.FactOptions{Latest: true})
	if e == nil {
		return "current", nil
	}
	switch fault.Code(e) {
	case "fact_version_conflict":
		return "superseded", nil
	case "fact_currentness_unavailable":
		return "unavailable", nil
	}
	return "", e
}
func rowsOf(v any) []Object {
	if r, ok := v.([]Object); ok {
		return r
	}
	out := []Object{}
	for _, x := range list(v) {
		out = append(out, obj(x))
	}
	return out
}

// SourceWithin is an owning selected-content read. Its caller has already
// authorized the request or an exact stored publication/permission. The viewer
// identity here does not manufacture a session or widen any underlying ACL.
func (s *Service) SourceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object, latest bool, visited map[string]bool) (Object, error) {
	if visited == nil {
		visited = map[string]bool{}
	}
	key := sourceKey(ref)
	if visited[key] {
		return nil, fault.New("capsule_source_cycle", 409)
	}
	visited[key] = true
	defer delete(visited, key)
	kind := text(ref, "kind")
	switch kind {
	case "configuration":
		if s.Configurations == nil {
			return nil, fault.New("capsule_configuration_source_unavailable", 503)
		}
		o, e := s.Configurations.RequireReferenceWithin(ctx, tx, a, ref)
		if e != nil {
			return nil, e
		}
		return Object{"ref": ref, "authorId": o["subjectId"], "dependencies": []any{dependency(key, text(o, "subjectId"))}, "synthetic": obj(o["record"])["synthetic"], "sourceState": o["sourceStatus"], "rightsScope": "selected-registered-conditions-only; no-local-prompt-or-file-rights-inferred"}, nil
	case "selected-message":
		if s.Selected == nil {
			return nil, fault.New("capsule_chat_source_unavailable", 503)
		}
		o, e := s.Selected(ctx, tx, a, Object{"messageId": ref["id"], "revision": ref["version"]})
		if e != nil {
			return nil, e
		}
		return Object{"ref": ref, "authorId": o["authorId"], "contentHash": o["contentHash"], "dependencies": []any{dependency(key, text(o, "authorId"))}, "sourceState": "current", "reading": Object{"text": o["text"], "roomId": o["roomId"], "expiresAt": o["expiresAt"], "permission": "current-room-read-only", "publicationPermission": false}, "rightsScope": "exact-message-content; room-read-is-not-publication-permission"}, nil
	case "outcome-material":
		if s.Materials == nil {
			return nil, fault.New("capsule_outcome_material_source_unavailable", 503)
		}
		o, e := s.Materials(ctx, tx, a, text(ref, "id"))
		if e != nil {
			return nil, e
		}
		allowed := false
		for _, v := range list(o["uses"]) {
			allowed = allowed || v == "capsule-publication"
		}
		if o["caseId"] != ref["caseId"] || o["contentAvailable"] != true || !allowed {
			return nil, fault.New("capsule_outcome_material_source_unavailable", 403)
		}
		return Object{"ref": ref, "authorId": o["authorId"], "contentHash": o["sha256"], "dependencies": []any{dependency(key, text(o, "authorId"))}, "sourceState": o["state"], "rightsScope": "independently-authorised-outcome-copy; capsule-publication-use-only"}, nil
	}
	c, e := s.caseWithin(ctx, tx, text(ref, "caseId"))
	if e != nil {
		return nil, e
	}
	rows := rowsOf(c["rows"])
	facts := obj(c["facts"])
	var root Object
	for _, row := range rows {
		if row["kind"] == "case" || row["kind"] == "case-created" {
			root = row
			break
		}
	}
	if root == nil {
		return nil, fault.New("capsule_source_unavailable", 403)
	}
	if _, e = s.Cases.RequireEventVisibleWithin(ctx, tx, a, root); e != nil {
		return nil, e
	}
	rootDep := dependency("case-event:"+text(root, "id"), text(root, "subject_id"))
	if kind == "case-root" {
		if ref["id"] != root["id"] || number(ref, "version") != 1 {
			return nil, fault.New("capsule_source_version_mismatch", 409)
		}
		return Object{"ref": ref, "authorId": root["subject_id"], "dependencies": []any{rootDep}, "synthetic": facts["synthetic"], "sourceState": "current", "caseReading": Object{"title": obj(root["payload"])["title"], "summary": obj(root["payload"])["summary"]}}, nil
	}
	if kind == "attempt" || kind == "intervention" || kind == "result" {
		fact, e := s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, kind, ref, cases.FactOptions{Latest: latest})
		if e != nil {
			return nil, e
		}
		deps := []any{rootDep}
		synthetic := facts["synthetic"] == true
		for _, id := range list(fact["recordEventIds"]) {
			var event Object
			for _, row := range rows {
				if row["id"] == id {
					event = row
					break
				}
			}
			if event == nil {
				return nil, fault.New("capsule_source_unavailable", 409)
			}
			deps = append(deps, dependency("case-event:"+text(event, "id"), text(event, "subject_id")))
			p := obj(event["payload"])
			refs := append(append([]any{}, list(p["sourceRefs"])...), list(p["deliverableRefs"])...)
			for _, value := range refs {
				nestedRef := Object{}
				for k, v := range obj(value) {
					nestedRef[k] = v
				}
				nestedKind := text(nestedRef, "kind")
				if nestedKind != "configuration" && nestedKind != "selected-message" && nestedKind != "outcome-material" {
					nestedRef["caseId"] = ref["caseId"]
				}
				nested, e := s.SourceWithin(ctx, tx, a, nestedRef, false, visited)
				if e != nil {
					return nil, e
				}
				deps = append(deps, list(nested["dependencies"])...)
				synthetic = synthetic || nested["synthetic"] == true
			}
		}
		current := "current"
		if !latest {
			current, e = s.currentness(ctx, tx, a, rows, facts, kind, ref)
			if e != nil {
				return nil, e
			}
		}
		author := fact["actorId"]
		if author == "unknown" {
			author = fact["reportedBy"]
		}
		return Object{"ref": ref, "authorId": author, "fact": fact, "currentness": current, "synthetic": synthetic, "dependencies": dependenciesUnique(deps), "sourceState": "current", "provenance": fact["provenance"]}, nil
	}
	if s.Records == nil {
		return nil, fault.New("capsule_source_unavailable", 503)
	}
	record, e := s.Records.RequireReferenceWithin(ctx, tx, a, Object{"kind": kind, "id": ref["id"], "version": ref["version"]}, verificationrecords.ReferenceOptions{CaseID: text(ref, "caseId")})
	if e != nil {
		return nil, e
	}
	r := obj(record["record"])
	deps := []any{rootDep, dependency(key, text(r, "reportedBy"))}
	if kind == "verification" {
		target := obj(r["target"])
		nested, e := s.SourceWithin(ctx, tx, a, Object{"kind": target["type"], "id": target["id"], "version": target["version"], "caseId": ref["caseId"]}, false, visited)
		if e != nil {
			return nil, e
		}
		deps = append(deps, list(nested["dependencies"])...)
		for _, value := range list(r["evidenceRefs"]) {
			ev := obj(value)
			nested, e = s.SourceWithin(ctx, tx, a, Object{"kind": "evidence", "id": ev["id"], "version": ev["version"], "caseId": ref["caseId"]}, false, visited)
			if e != nil {
				return nil, e
			}
			deps = append(deps, list(nested["dependencies"])...)
		}
	}
	return Object{"ref": ref, "authorId": r["reportedBy"], "record": record, "dependencies": dependenciesUnique(deps), "synthetic": record["synthetic"], "sourceState": "current", "rightsScope": "registered-report-metadata-only; external-linked-content-rights-not-inferred"}, nil
}
