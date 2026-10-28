package taskmaterials

import (
	"context"
	"errors"
	"unicode/utf16"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

var requesterFactKinds = []string{"select", "confirm", "change-scope", "confirm-scope", "deliver", "accept", "cancel", "dispute", "propose-resolution", "confirm-resolution", "requester-feedback"}

func requesterProjection(state Object, visible func(string) bool) Object {
	events := []Object{}
	facts := []any{}
	counts := Object{"acceptances": 0, "cancellations": 0, "disputes": 0}
	for _, v := range arr(state["events"]) {
		item := v.(map[string]any)
		event := obj(item, "event")
		if !visible(str(event, "id")) {
			continue
		}
		events = append(events, item)
		if !contains(requesterFactKinds, str(event, "kind")) {
			continue
		}
		var summary any
		for _, k := range []string{"summary", "reason", "note"} {
			if event[k] != nil {
				summary = event[k]
				break
			}
		}
		fact := Object{"eventId": event["id"], "actorId": item["actorId"], "at": item["at"], "kind": event["kind"], "summary": summary, "authority": "signed-participant-event"}
		if event["kind"] == "requester-feedback" {
			fact["descriptionClarity"], fact["scopeMatched"], fact["authority"] = event["descriptionClarity"], event["scopeMatched"], "provider-reported"
		}
		facts = append(facts, fact)
		for k, kind := range map[string]string{"acceptances": "accept", "cancellations": "cancel", "disputes": "dispute"} {
			if event["kind"] == kind {
				counts[k] = num(counts[k]) + 1
			}
		}
	}
	var offer, response Object
	for _, item := range events {
		if obj(item, "event")["kind"] == "offer" {
			offer = item
			break
		}
	}
	if offer != nil {
		for _, item := range events {
			if item["actorId"] == state["requesterId"] && num(item["at"]) >= num(offer["at"]) && contains([]string{"select", "cancel", "change-scope"}, str(obj(item, "event"), "kind")) {
				response = item
				break
			}
		}
	}
	var seconds, sources any
	if response != nil {
		seconds = num(response["at"]) - num(offer["at"])
		sources = Object{"offerEventId": obj(offer, "event")["id"], "responseEventId": obj(response, "event")["id"]}
	}
	r := obj(state, "request")
	return Object{"assistanceId": r["id"], "requesterId": state["requesterId"], "title": r["title"], "createdAt": state["createdAt"], "description": Object{"problem": r["problem"], "scope": r["scope"], "attemptedApproaches": r["attemptedApproaches"]}, "facts": facts, "visibleFactCount": len(facts), "counts": counts, "countBasis": "visible-events; repeated-acceptance-is-not-another-request", "responseSeconds": seconds, "responseBasis": "first visible offer and requester response", "responseSources": sources, "capabilityVerified": false, "independentQualityRating": false}
}
func requesterPreview(projection Object) Object {
	facts := arr(projection["facts"])
	page := []any{}
	for _, v := range facts[:min(8, len(facts))] {
		fact := clone(v.(map[string]any))
		var summary any
		units := jsText(utf16.Encode([]rune(text(fact["summary"]))))
		if fact["summary"] != nil {
			summary = units[:min(300, len(units))]
		}
		fact["summary"], fact["summaryTruncated"] = summary, len(units) > 300
		page = append(page, fact)
	}
	var after any
	if len(facts) > len(page) {
		after = page[len(page)-1].(map[string]any)["eventId"]
	}
	projection["facts"], projection["nextFactsAfter"], projection["factsSupported"] = page, after, 1
	return projection
}
func requesterOptions(input Object, facts bool) (string, any, int64, error) {
	optional := []string{"subjectId", "after", "limit"}
	required := []string{}
	if facts {
		required = []string{"assistanceId"}
		optional = []string{"after", "limit"}
	}
	if !exactFields(input, required, optional) {
		return "", nil, 0, fail("invalid_requester_history_query", 400)
	}
	subject := ""
	if v, exists := input["subjectId"]; exists {
		subject = text(v)
		if !subjectPattern.MatchString(subject) {
			return "", nil, 0, fail("invalid_requester_history_query", 400)
		}
	}
	if facts && !validID(str(input, "assistanceId")) {
		return "", nil, 0, fail("invalid_requester_history_query", 400)
	}
	var after any
	if v, exists := input["after"]; exists {
		if !validID(text(v)) {
			return "", nil, 0, fail("invalid_requester_history_query", 400)
		}
		after = v
	}
	limit := int64(8)
	if v, exists := input["limit"]; exists {
		if !validInt(v, 1, 20) {
			return "", nil, 0, fail("invalid_requester_history_query", 400)
		}
		limit = num(v)
	}
	return subject, after, limit, nil
}
func (s *Service) RequesterHistory(ctx context.Context, a Actor, input Object) (any, error) {
	subject, after, limit, e := requesterOptions(input, false)
	if e != nil {
		return nil, e
	}
	if subject == "" {
		subject = a.SubjectID
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		page, e := s.legacyQueryWithin(ctx, tx, a.Actor, legacyQuery{View: "requester-history", RequesterID: subject, After: after, Limit: limit})
		if e != nil {
			return nil, e
		}
		items := []any{}
		acceptances, cancellations, disputes := int64(0), int64(0), int64(0)
		for _, v := range arr(page["items"]) {
			candidate := v.(map[string]any)
			loaded, e := s.LegacyLoadWithin(ctx, tx, str(candidate, "assistanceId"), false)
			if e != nil {
				var f *fault.Error
				if !errors.As(e, &f) || (f.Status != 403 && f.Status != 404) {
					return nil, e
				}
				continue
			}
			if !s.visible(loaded.Grants[str(loaded.Row, "id")], a.SubjectID) {
				continue
			}
			projection := requesterPreview(requesterProjection(obj(loaded.Row, "snapshot"), func(id string) bool { return s.visible(loaded.Grants[id], a.SubjectID) }))
			items = append(items, projection)
			counts := obj(projection, "counts")
			acceptances += num(counts["acceptances"])
			cancellations += num(counts["cancellations"])
			disputes += num(counts["disputes"])
		}
		return Object{"subjectId": subject, "items": items, "nextAfter": page["nextAfter"], "summaryScope": "visible-page-only", "counts": Object{"requests": len(items), "acceptances": acceptances, "cancellations": cancellations, "disputes": disputes}, "countBasis": "visible-events; repeated-acceptance-is-not-another-request"}, nil
	})
}
func (s *Service) RequesterHistoryFacts(ctx context.Context, a Actor, input Object) (any, error) {
	_, after, limit, e := requesterOptions(input, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, "assistance", false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		loaded, e := s.LegacyLoadWithin(ctx, tx, str(input, "assistanceId"), true)
		if e != nil {
			return nil, e
		}
		if !s.visible(loaded.Grants[str(loaded.Row, "id")], a.SubjectID) {
			return nil, fail("not_found", 404)
		}
		state := obj(loaded.Row, "snapshot")
		projection := requesterProjection(state, func(id string) bool { return s.visible(loaded.Grants[id], a.SubjectID) })
		tail := map[string]bool{}
		found := after == nil
		for _, v := range arr(state["events"]) {
			event := obj(v.(map[string]any), "event")
			if found {
				tail[str(event, "id")] = true
			} else if event["id"] == after && contains(requesterFactKinds, str(event, "kind")) {
				found = true
			}
		}
		if !found {
			return nil, fail("invalid_requester_history_cursor", 400)
		}
		remaining := []any{}
		for _, v := range arr(projection["facts"]) {
			if after == nil || tail[str(v.(map[string]any), "eventId")] {
				remaining = append(remaining, v)
			}
		}
		facts := remaining[:min(len(remaining), int(limit))]
		var next any
		if len(remaining) > len(facts) {
			next = facts[len(facts)-1].(map[string]any)["eventId"]
		}
		projection["facts"], projection["nextAfter"], projection["summaryScope"], projection["factsSupported"] = facts, next, "visible-request-only", 1
		return projection, nil
	})
}
