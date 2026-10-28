package capsules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func stamp(v any) any {
	if at, ok := v.(time.Time); ok {
		return at.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}
func (s *Service) useWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, row Object) (Object, error) {
	if text(row, "payload_text") == "" {
		return nil, fault.New("capsule_use_unavailable", 404)
	}
	g, e := s.grant(ctx, tx, row, "capsule.use")
	if e != nil {
		return nil, e
	}
	if !s.visible(g, a) {
		return nil, fault.New("capsule_use_unavailable", 404)
	}
	wire, e := parsePayload(text(row, "payload_text"), "use", true)
	if e != nil {
		return nil, e
	}
	p := wire.Values()
	base := Object{"eventId": row["id"], "capsuleId": row["capsule_id"], "versionId": row["version_id"], "caseId": row["case_id"], "subjectId": row["subject_id"], "kind": row["kind"], "recordedAt": stamp(row["created_at"]), "actualExecutionIndependentlyVerified": false, "verifiedReuse": false, "capabilityVerified": false}
	if own := ownControl(a, row, "use"); own != nil {
		base["ownerControl"] = own
	}
	unavailable := func(status string) Object { base["sourceStatus"] = status; base["record"] = nil; return base }
	current, e := s.versionWithin(ctx, tx, a, text(row, "capsule_id"), text(row, "version_id"), true, false)
	if e != nil {
		if !absent(e) {
			return nil, e
		}
		return unavailable("capsule-unavailable"), nil
	}
	owner := deviceauth.Actor{SubjectID: text(row, "subject_id")}
	var applied Object
	if p["kind"] == "reference" {
		if s.Cases == nil {
			e = fault.New("capsule_case_unavailable", 503)
		} else {
			_, e = s.Cases.ReadV2Within(ctx, tx, owner, text(row, "case_id"), text(p, "taskId"))
		}
	} else {
		applied, e = s.application(ctx, tx, &owner, p, false)
	}
	if e != nil {
		if !absent(e) {
			return nil, e
		}
		return unavailable("application-source-unavailable"), nil
	}
	if current.status == "source-unavailable" {
		return unavailable("capsule-source-unavailable"), nil
	}
	verifications := []any{}
	for _, value := range list(p["verificationRefs"]) {
		ref := obj(value)
		var v any
		var e error
		if s.Records == nil {
			e = fault.New("capsule_source_unavailable", 503)
		} else {
			raw, err := s.Records.ReadWireWithin(ctx, tx, a, Object{"type": "verification", "id": ref["id"], "version": ref["version"]})
			e = err
			if e == nil {
				v, e = protocol.DecodeOrdered(raw)
			}
		}
		if e != nil {
			if !absent(e) {
				return nil, e
			}
			v = orderedFields(Object{"id": ref["id"], "version": ref["version"], "referenceStatus": "unavailable", "record": nil}, "id", "version", "referenceStatus", "record")
		}
		verifications = append(verifications, v)
	}
	if p["kind"] == "reverify" {
		prior, e := one(ctx, tx, `SELECT * FROM capsule_uses_v2 WHERE id=$1`, p["priorUseId"])
		if e != nil {
			return nil, e
		}
		e = func() error {
			if text(prior, "payload_text") == "" {
				return fault.New("capsule_application_required", 409)
			}
			g, e := s.grant(ctx, tx, prior, "capsule.use")
			if e != nil {
				return e
			}
			if !s.visible(g, a) {
				return fault.New("capsule_application_required", 409)
			}
			return nil
		}()
		if e != nil {
			if !absent(e) {
				return nil, e
			}
			return unavailable("prior-application-unavailable"), nil
		}
	}
	status := "current"
	if applied != nil && applied["currentResult"] != true {
		status = "application-result-superseded"
		if applied["resultCurrentness"] == "unavailable" {
			status = "application-currentness-unavailable"
		}
	}
	base["record"] = wire
	base["sourceStatus"] = status
	if applied != nil {
		base["originRef"] = originRef(p)
		base["environmentSource"] = applied["environmentSource"]
	}
	base["capsuleSourceStatus"] = current.status
	base["capsuleDeprecated"] = current.deprecated
	base["capsuleSecurityIssue"] = current.security
	base["synthetic"] = nil
	if applied["synthetic"] == true || current.source["synthetic"] == true {
		base["synthetic"] = true
	} else if applied["synthetic"] == false && current.source["synthetic"] == false {
		base["synthetic"] = false
	}
	base["verifications"] = verifications
	base["verificationMeaning"] = "current-scoped-reports; not-independent-causality-or-expertise"
	base["reportedOutcome"] = p["outcome"]
	base["readingIsReuse"] = false
	return base, nil
}
func useWire(o Object) *protocol.OrderedObject {
	x := orderedFields(o, "eventId", "capsuleId", "ownerControl", "versionId", "caseId", "subjectId", "kind", "recordedAt", "actualExecutionIndependentlyVerified", "verifiedReuse", "capabilityVerified", "record", "sourceStatus", "originRef", "environmentSource", "capsuleSourceStatus", "capsuleDeprecated", "capsuleSecurityIssue", "synthetic", "verifications", "verificationMeaning", "reportedOutcome", "readingIsReuse")
	if o["record"] == nil {
		x = orderedFields(o, "eventId", "capsuleId", "ownerControl", "versionId", "caseId", "subjectId", "kind", "recordedAt", "actualExecutionIndependentlyVerified", "verifiedReuse", "capabilityVerified", "sourceStatus", "record")
	}
	if c := obj(o["ownerControl"]); c != nil {
		x.Set("ownerControl", orderedFields(c, "type", "operationId", "consentId", "payloadHash"))
	}
	if r := obj(o["originRef"]); r != nil {
		x.Set("originRef", orderedFields(r, "kind", "id", "version"))
	}
	return x
}
func (s *Service) HistoryWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, caseID string) (Object, error) {
	rows, e := query(ctx, tx, `SELECT * FROM capsule_uses_v2 WHERE case_id=$1 ORDER BY id`, caseID)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, row := range rows {
		o, e := s.useWithin(ctx, tx, a, row)
		if e != nil {
			if absent(e) {
				continue
			}
			return nil, e
		}
		items = append(items, o)
	}
	return Object{"items": items, "readingIsReuse": false, "capabilityVerified": false, "sourceScope": "currently-authorized-v2-use-records; no-aggregate-capability"}, nil
}
func (s *Service) HistoryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, caseID string) (json.RawMessage, error) {
	o, e := s.HistoryWithin(ctx, tx, a, caseID)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range list(o["items"]) {
		items = append(items, useWire(obj(v)))
	}
	o["items"] = items
	b, e := protocol.EncodeJS(orderedFields(o, "items", "readingIsReuse", "capabilityVerified", "sourceScope"))
	return json.RawMessage(b), e
}
func (s *Service) UsesV2Within(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, p Object) (Object, error) {
	items := []any{}
	var cursor any
	for {
		rows, e := query(ctx, tx, `SELECT * FROM capsule_uses_v2 WHERE($1::uuid IS NULL OR capsule_id=$1)AND($2::uuid IS NULL OR version_id=$2)AND($3::uuid IS NULL OR case_id=$3)AND($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT 100`, p["capsuleId"], p["versionId"], p["caseId"], cursor)
		if e != nil {
			return nil, e
		}
		for _, row := range rows {
			o, e := s.useWithin(ctx, tx, a, row)
			if e != nil {
				if absent(e) {
					continue
				}
				return nil, e
			}
			items = append(items, o)
		}
		if len(rows) < 100 {
			break
		}
		cursor = rows[len(rows)-1]["id"]
	}
	groups := map[string]map[string]bool{}
	counts := Object{"references": 0, "applications": 0, "reverifications": 0, "syntheticApplications": 0, "distinctTargetCases": 0, "reportedSuccessfulTargetCases": 0, "mixedOutcomeTargetCases": 0, "independentlyVerifiedReuseCases": 0}
	for _, v := range items {
		o := obj(v)
		if o["record"] == nil {
			continue
		}
		switch o["kind"] {
		case "reference":
			counts["references"] = number(counts, "references") + 1
		case "apply":
			counts["applications"] = number(counts, "applications") + 1
			if o["synthetic"] == true {
				counts["syntheticApplications"] = number(counts, "syntheticApplications") + 1
			}
		case "reverify":
			counts["reverifications"] = number(counts, "reverifications") + 1
		}
		if o["kind"] != "reference" && o["sourceStatus"] == "current" && o["synthetic"] == false {
			id := text(o, "caseId")
			if groups[id] == nil {
				groups[id] = map[string]bool{}
			}
			groups[id][text(o, "reportedOutcome")] = true
		}
	}
	counts["distinctTargetCases"] = len(groups)
	for _, set := range groups {
		if len(set) == 1 && set["succeeded"] {
			counts["reportedSuccessfulTargetCases"] = number(counts, "reportedSuccessfulTargetCases") + 1
		}
		if len(set) > 1 {
			counts["mixedOutcomeTargetCases"] = number(counts, "mixedOutcomeTargetCases") + 1
		}
	}
	return page(items, "eventId", p, Object{"countsScope": "currently-visible-v2-records-for-requested-filter", "readingIsReuse": false, "capabilityVerified": false, "counts": counts, "legacyUses": "available-separately-through-v1; counts-not-merged"}), nil
}
func (s *Service) UsesV2(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "uses")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.UsesV2Within(ctx, tx, a, p)
	})
}
