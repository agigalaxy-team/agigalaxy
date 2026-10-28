package capsules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) attributionResponses(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, attribution Object, cache map[string]Object) (Object, error) {
	base := Object{"meaning": "responses-to-exact-original-intervention; not-capsule-coauthorship", "coverage": "currently-authorized-latest-response-per-actor; hidden-responses-not-inferred", "coauthorApproval": false}
	empty := func(status string) Object {
		base["status"] = status
		base["confirmation"] = nil
		base["responses"] = []any{}
		return base
	}
	ref := obj(attribution["source"])
	if ref["kind"] != "intervention" {
		return empty("not-an-intervention"), nil
	}
	result, e := func() (Object, error) {
		id := text(ref, "caseId")
		c := cache[id]
		if c == nil {
			var e error
			c, e = s.caseWithin(ctx, tx, id)
			if e != nil {
				return nil, e
			}
			cache[id] = c
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
		if _, e := s.Cases.RequireEventVisibleWithin(ctx, tx, a, root); e != nil {
			return nil, e
		}
		fact, e := s.Cases.RequireFactWithin(ctx, tx, a, rows, facts, "intervention", ref, cases.FactOptions{})
		if e != nil {
			return nil, e
		}
		responses := []any{}
		for _, value := range list(fact["responses"]) {
			r := obj(value)
			var row Object
			for _, candidate := range rows {
				if candidate["id"] == r["id"] {
					row = candidate
					break
				}
			}
			if row == nil {
				return nil, fault.New("case_event_unavailable", 404)
			}
			retainedNewer := false
			for _, candidate := range rows {
				if candidate["kind"] == "intervention-response" && candidate["subject_id"] == r["actorId"] && number(candidate, "version") > number(row, "version") && text(candidate, "payload_text") == "" {
					retainedNewer = true
					break
				}
			}
			if retainedNewer {
				continue
			}
			if _, e := s.Cases.RequireEventVisibleWithin(ctx, tx, a, row); e != nil {
				switch fault.Code(e) {
				case "consent_required", "origin_not_authorized", "case_event_unavailable":
					continue
				}
				return nil, e
			}
			responses = append(responses, Object{"eventId": r["id"], "actorId": r["actorId"], "relationship": r["relationship"], "state": r["state"], "interventionRef": r["interventionRef"]})
		}
		confirmation := "unconfirmed"
		accepted, partial, disputed := false, false, false
		for _, value := range responses {
			r := obj(value)
			if r["relationship"] == "self" {
				continue
			}
			accepted = accepted || r["state"] == "accepted"
			partial = partial || r["state"] == "partial"
			disputed = disputed || r["state"] == "disputed"
		}
		if disputed {
			confirmation = "disputed"
		} else if partial {
			confirmation = "partially-confirmed"
		} else if accepted {
			confirmation = "confirmed"
		}
		current, e := s.currentness(ctx, tx, a, rows, facts, "intervention", ref)
		if e != nil {
			return nil, e
		}
		status := "current"
		if current == "unavailable" {
			status = "source-currentness-unavailable"
		} else if current != "current" {
			status = "source-version-superseded"
		}
		base["status"] = status
		base["source"] = ref
		base["taskId"] = fact["taskId"]
		base["confirmation"] = confirmation
		base["responses"] = responses
		return base, nil
	}()
	if e != nil {
		if absent(e) && fault.Status(e) != 400 {
			return empty("source-not-readable"), nil
		}
		return nil, e
	}
	return result, nil
}
func (s *Service) attributions(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input []any) ([]any, error) {
	cache := map[string]Object{}
	out := []any{}
	for _, value := range input {
		attr := obj(value)
		o := Object{}
		for k, v := range attr {
			o[k] = v
		}
		r, e := s.attributionResponses(ctx, tx, a, attr, cache)
		if e != nil {
			return nil, e
		}
		o["contributionResponses"] = r
		out = append(out, o)
	}
	return out, nil
}
func (s *Service) resolutionReading(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, resolution Object) (Object, error) {
	resultRef := Object{"kind": "result", "id": resolution["resultId"], "version": resolution["resultVersion"], "caseId": resolution["caseId"]}
	out := Object{"case": Object{"status": "unavailable"}, "result": Object{"status": "unavailable", "ref": resultRef}}
	readCase := func() error {
		c, e := s.caseWithin(ctx, tx, text(resolution, "caseId"))
		if e != nil {
			return e
		}
		var root Object
		for _, r := range rowsOf(c["rows"]) {
			if r["kind"] == "case" || r["kind"] == "case-created" {
				root = r
				break
			}
		}
		if root == nil {
			return fault.New("capsule_source_unavailable", 403)
		}
		ref := Object{"kind": "case-root", "id": root["id"], "version": int64(1), "caseId": resolution["caseId"]}
		source, e := s.SourceWithin(ctx, tx, a, ref, false, nil)
		if e != nil {
			return e
		}
		reading := obj(source["caseReading"])
		out["case"] = Object{"status": "available", "ref": ref, "authorId": source["authorId"], "title": reading["title"], "summary": reading["summary"]}
		return nil
	}
	if e := readCase(); e != nil && (!absent(e) || fault.Status(e) == 400) {
		return nil, e
	}
	source, e := s.SourceWithin(ctx, tx, a, resultRef, false, nil)
	if e != nil {
		if !absent(e) || fault.Status(e) == 400 {
			return nil, e
		}
	} else {
		fact := obj(source["fact"])
		out["result"] = Object{"status": "available", "ref": resultRef, "authorId": source["authorId"], "summary": fact["summary"], "reportedOutcome": fact["reportedOutcome"], "limitations": fact["limitations"], "currentness": source["currentness"]}
	}
	return out, nil
}
