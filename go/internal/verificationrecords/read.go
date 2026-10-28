package verificationrecords

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

func receiptView(o *recordObject, event *recordEvent) Object {
	state := "recorded"
	if event.Payload["kind"] == "revoke" {
		state = "revoked"
	}
	return Object{"id": o.ID, "type": o.Type, "version": event.Version, "operationId": event.Payload["operationId"], "state": state, "currentVersion": o.Version, "currentState": o.State, "sourceStrength": event.Context["sourceStrength"], "independentExecutionVerified": false, "capabilityVerified": false, "taskOutcomeVerified": false, "synthetic": event.Context["synthetic"]}
}
func view(o *recordObject, event *recordEvent, sourceSynthetic bool) Object {
	derived := copyObject(event.Context)
	derived["synthetic"] = derived["synthetic"] == true || event.Payload["synthetic"] == true || sourceSynthetic
	copyEvent := *event
	copyEvent.Context = derived
	out := receiptView(o, &copyEvent)
	out["record"] = cases.PublicFacts(event.Payload)
	out["provenance"] = derived
	out["integrity"] = "payload-hash-matches-storage"
	out["authorization"] = "current"
	out["externalOwnershipVerified"] = false
	out["availability"] = Object{"record": "available", "upstream": "not-checked", "upstreamRevocation": "unknown"}
	out["revocation"] = "not-revoked"
	if o.State == "revoked" {
		out["revocation"] = "revoked"
	}
	return out
}

type ReferenceOptions struct {
	CaseID       string
	ScopeVersion *int64
	Visited      map[string]bool
}

func (s *Service) RequireReferenceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object, opts ReferenceOptions) (Object, error) {
	kind := str(ref, "kind")
	if kind == "" {
		kind = "verification"
	}
	if !one(kind, "evidence", "verification") {
		return nil, fault.New("source_adapter_unavailable", 503)
	}
	peek, e := loadObject(ctx, tx, str(ref, "id"), "")
	if e != nil {
		return nil, e
	}
	if peek == nil {
		return nil, fault.New("evidence_reference_unavailable", 404)
	}
	context, e := s.CaseWithin(ctx, tx, peek.CaseID)
	if e != nil {
		return nil, e
	}
	o, e := s.readObject(ctx, tx, str(ref, "id"))
	if e != nil {
		return nil, e
	}
	if o == nil || o.Type != kind {
		return nil, fault.New("evidence_reference_unavailable", 404)
	}
	version := int64(1)
	if _, ok := ref["version"]; ok {
		version = num(ref, "version")
	}
	if !reference(Object{"id": ref["id"], "version": version}, false) {
		return nil, fault.New("invalid_evidence_reference", 422)
	}
	event, e := loadEvent(ctx, tx, o.ID, version, false)
	if e != nil {
		return nil, e
	}
	visibility := event
	if visibility == nil {
		visibility, e = loadEvent(ctx, tx, o.ID, o.Version, false)
		if e != nil {
			return nil, e
		}
	}
	if visibility == nil {
		return nil, fault.New("evidence_reference_unavailable", 404)
	}
	if e = s.visibleWithin(ctx, tx, a, o, visibility); e != nil {
		return nil, e
	}
	if opts.CaseID != "" && opts.CaseID != o.CaseID {
		return nil, fault.New("evidence_case_mismatch", 422)
	}
	if o.State != "active" {
		return nil, fault.New("evidence_revoked", 409)
	}
	if o.Version != version {
		return nil, fault.New("evidence_version_changed", 409)
	}
	if event == nil {
		return nil, fault.New("evidence_reference_unavailable", 404)
	}
	if obj(context["parent"])["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	if str(event.Payload, "expiresAt") != "" && !at(event.Payload, "expiresAt").After(time.Unix(s.now(), 0)) {
		return nil, fault.New("evidence_expired", 409)
	}
	visited := opts.Visited
	if visited == nil {
		visited = map[string]bool{}
	}
	key := fmt.Sprintf("%s:%s:%d", kind, o.ID, version)
	if visited[key] {
		return nil, fault.New("circular_evidence_reference", 422)
	}
	visited[key] = true
	defer delete(visited, key)
	sourceSynthetic := obj(context["facts"])["synthetic"] == true
	if kind == "verification" {
		scope := num(event.Payload, "scopeVersion")
		if opts.ScopeVersion != nil {
			scope = *opts.ScopeVersion
		}
		target, e := s.TargetWithin(ctx, tx, a, obj(event.Payload["target"]), TargetOptions{CaseID: o.CaseID, ScopeVersion: &scope, Latest: true, Visited: visited})
		if e != nil {
			return nil, e
		}
		sourceSynthetic = sourceSynthetic || obj(target["fact"])["synthetic"] == true
		for _, ref := range arr(event.Payload["evidenceRefs"]) {
			ref := copyObject(obj(ref))
			ref["kind"] = "evidence"
			source, e := s.RequireReferenceWithin(ctx, tx, a, ref, ReferenceOptions{CaseID: o.CaseID, Visited: visited})
			if e != nil {
				return nil, e
			}
			sourceSynthetic = sourceSynthetic || source["synthetic"] == true
		}
	}
	return view(o, event, sourceSynthetic), nil
}
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object) (Object, error) {
	kind, id := str(ref, "type"), str(ref, "id")
	if !one(kind, "evidence", "verification") {
		return nil, fault.New("invalid_record_type", 422)
	}
	peek, e := loadObject(ctx, tx, id, "")
	if e != nil {
		return nil, e
	}
	if peek == nil {
		return nil, fault.New("record_not_found", 404)
	}
	context, e := s.CaseWithin(ctx, tx, peek.CaseID)
	if e != nil {
		return nil, e
	}
	o, e := loadObject(ctx, tx, id, "SHARE")
	if e != nil {
		return nil, e
	}
	if o == nil || o.Type != kind {
		return nil, fault.New("record_not_found", 404)
	}
	selected := o.Version
	if _, ok := ref["version"]; ok {
		selected = num(ref, "version")
	}
	event, e := loadEvent(ctx, tx, id, selected, false)
	if e != nil {
		return nil, e
	}
	if event == nil {
		return nil, fault.New("record_not_found", 404)
	}
	if e = s.visibleWithin(ctx, tx, a, o, event); e != nil {
		return nil, e
	}
	if obj(context["parent"])["state"] == "withdrawn" {
		return nil, fault.New("case_unavailable", 409)
	}
	out := view(o, event, obj(context["facts"])["synthetic"] == true)
	viewer := s.viewer(a)
	if o.State == "revoked" && (viewer == nil || *viewer != o.Subject) {
		return Object{"id": id, "type": kind, "version": selected, "currentVersion": o.Version, "referenceStatus": "revoked", "record": nil, "capabilityVerified": false, "taskOutcomeVerified": false}, nil
	}
	out["current"] = o.State == "active" && o.Version == selected
	status := "current"
	if o.State == "revoked" {
		status = "revoked"
	} else if o.Version != selected {
		status = "superseded"
	}
	out["referenceStatus"] = status
	if str(event.Payload, "expiresAt") != "" && !at(event.Payload, "expiresAt").After(time.Unix(s.now(), 0)) {
		out["referenceStatus"] = "expired"
		out["current"] = false
	}
	if kind == "verification" && event.Payload["kind"] != "revoke" {
		target, e := s.TargetWithin(ctx, tx, a, obj(event.Payload["target"]), TargetOptions{CaseID: o.CaseID, ScopeVersion: pointer(num(event.Payload, "scopeVersion"))})
		if e == nil {
			synthetic := obj(target["fact"])["synthetic"] == true
			for _, ref := range arr(event.Payload["evidenceRefs"]) {
				ref := copyObject(obj(ref))
				ref["kind"] = "evidence"
				source, err := s.RequireReferenceWithin(ctx, tx, a, ref, ReferenceOptions{CaseID: o.CaseID})
				if err != nil {
					e = err
					break
				}
				synthetic = synthetic || source["synthetic"] == true
			}
			if e == nil {
				out["synthetic"] = out["synthetic"] == true || synthetic
				obj(out["provenance"])["synthetic"] = out["synthetic"]
				out["targetCurrentVersion"] = target["currentVersion"]
				if num(target, "currentVersion") != num(obj(event.Payload["target"]), "version") {
					out["referenceStatus"] = "target-version-changed"
					out["current"] = false
				}
			}
		}
		if e != nil {
			if !isService(e) {
				return nil, e
			}
			return Object{"id": id, "type": kind, "version": selected, "currentVersion": o.Version, "referenceStatus": "dependency-unavailable", "reason": fault.Code(e), "observedAt": event.Context["recordedAt"], "capabilityVerified": false, "taskOutcomeVerified": false, "record": nil}, nil
		}
	}
	return out, nil
}
func pointer(v int64) *int64 { return &v }
