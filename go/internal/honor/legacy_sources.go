package honor

import (
	"context"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
)

var evidenceKinds = []string{"confirm", "change-scope", "confirm-scope", "deliver", "accept", "cancel", "dispute", "propose-resolution", "confirm-resolution"}

type legacySources struct {
	Contributions []Object
	Complete      bool
}

func (s *Service) legacySources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string, rule Object, network, withProofs bool, cache map[string]Object) (legacySources, error) {
	result := legacySources{Contributions: []Object{}, Complete: true}
	if s.Assistance == nil {
		return result, fail("honor_assistance_unavailable", 503)
	}
	var viewer any
	viewerID := ""
	if a != nil {
		viewer = a.SubjectID
		viewerID = a.SubjectID
	}
	providers := []string{subject}
	if network {
		providers = []string{}
		for _, v := range array(rule["members"]) {
			providers = append(providers, text(v))
		}
	}
	members := []string{}
	for _, v := range array(rule["members"]) {
		members = append(members, text(v))
	}
	var after any
	for {
		candidates, e := rows(ctx, tx, `SELECT jsonb_build_object('id',a.id) FROM assistance_requests a JOIN assistance_events root ON root.id=a.id JOIN consents c ON c.id=root.consent_id WHERE a.snapshot->'selected'->>'providerId'=ANY($1::text[]) AND a.snapshot->'request'->>'capabilityId'=$2 AND a.requester_id=ANY($3::text[]) AND (a.requester_id=$4 OR c.intent->'viewers' ? COALESCE($4,'') OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile') AND ($5::uuid IS NULL OR a.id>$5) ORDER BY a.id LIMIT 100`, providers, rule["capabilityId"], members, viewer, after)
		if e != nil {
			return result, e
		}
		for _, candidate := range candidates {
			id := str(candidate, "id")
			if cached, exists := cache[id]; exists {
				if cached != nil {
					result.Contributions = append(result.Contributions, cached)
				}
				continue
			}
			cache[id] = nil
			contribution, e := func() (Object, error) {
				loaded, e := s.Assistance.LegacyLoadWithin(ctx, tx, id, true)
				if e != nil {
					return nil, e
				}
				state := object(loaded.Row["snapshot"])
				provider := str(object(state["selected"]), "providerId")
				if !s.Assistance.LegacySourceVisible(loaded.Grants[id], viewerID) {
					return nil, nil
				}
				work := []Object{}
				var confirmation Object
				for _, v := range array(state["events"]) {
					item := object(v)
					if has(evidenceKinds, str(object(item["event"]), "kind")) {
						work = append(work, item)
						if confirmation == nil && object(item["event"])["kind"] == "confirm" && item["actorId"] == provider {
							confirmation = item
						}
					}
				}
				if confirmation == nil {
					return nil, nil
				}
				for _, item := range work {
					if !s.Assistance.LegacySourceVisible(loaded.Grants[str(object(item["event"]), "id")], viewerID) {
						return nil, nil
					}
				}
				if number(confirmation["at"]) < number(rule["windowFrom"]) || number(confirmation["at"]) >= number(rule["windowUntil"]) {
					return nil, nil
				}
				revisions, e := s.Assistance.LegacyCaseReviewEventsWithin(ctx, tx, str(loaded.Row, "case_id"), viewerID)
				if e != nil {
					return nil, e
				}
				review := taskmaterials.LegacyReviewProjection(revisions, state)
				related := false
				for _, group := range array(rule["relatedPartyGroups"]) {
					if has(group, provider) && has(group, str(loaded.Row, "requester_id")) {
						related = true
					}
				}
				valid := review["accepted"] == true && !loaded.Paused && review["correctionPending"] != true && review["disputed"] != true
				delivery := object(state["delivery"])
				acceptance := object(review["acceptance"])
				corrections := array(review["textCorrections"])
				var latest any
				if len(corrections) > 0 {
					latest = object(corrections[len(corrections)-1])["version"]
				}
				correctionState := "awaiting-requester-acceptance"
				if review["corrected"] != true {
					correctionState = "not-required"
				} else if review["correctionPending"] == true {
					correctionState = "new-delivery-required"
				} else if review["accepted"] == true {
					correctionState = "participant-reaccepted"
				}
				correctionReview := ordered("version", 1, "state", correctionState, "deliveredCaseReviewVersion", delivery["caseReviewVersion"], "latestTextCorrectionVersion", latest, "deliveryEventId", delivery["id"], "acceptanceEventId", object(acceptance["event"])["id"], "authority", "provider-versioned-delivery-and-requester-acceptance", "independenceVerified", false, "capabilityVerified", false)
				linked, observations := []any{}, []any{}
				evidenceIDs := []string{}
				for _, v := range array(delivery["evidenceIds"]) {
					evidenceIDs = append(evidenceIDs, text(v))
				}
				if withProofs && len(evidenceIDs) > 0 {
					if s.Proofs == nil {
						return nil, fail("honor_proof_unavailable", 503)
					}
					var proofAfter any
					for {
						proofRows, e := rows(ctx, tx, "SELECT jsonb_build_object('id',id,'evidence_id',evidence_id,'payload_text',payload_text) FROM proofs WHERE evidence_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 50", evidenceIDs, proofAfter)
						if e != nil {
							return nil, e
						}
						for _, proof := range proofRows {
							observation, e := s.legacyObservation(ctx, tx, a, proof, rule)
							if e != nil {
								if !serviceError(e) {
									return nil, e
								}
								continue
							}
							if observation == nil {
								continue
							}
							observations = append(observations, observation)
							if valid && object(observation)["conclusion"] == "success" {
								linked = append(linked, observation)
							}
						}
						if len(proofRows) < 50 {
							break
						}
						proofAfter = proofRows[len(proofRows)-1]["id"]
					}
				}
				sourceEvents := []any{}
				for _, item := range work {
					event := object(item["event"])
					source := ordered("eventId", event["id"], "kind", event["kind"], "actorId", item["actorId"], "at", item["at"])
					if v, ok := event["caseReviewVersion"]; ok {
						source.Set("caseReviewVersion", v)
					}
					if v := event["outcome"]; v != nil && v != "" {
						source.Set("outcome", v)
					}
					sourceEvents = append(sourceEvents, source)
				}
				revisionIDs := []any{}
				for _, r := range revisions {
					revisionIDs = append(revisionIDs, r["id"])
				}
				independence := "unverified-relationship"
				if related {
					independence = "issuer-declared-related-party"
				}
				return Object{"assistanceId": loaded.Row["id"], "caseId": loaded.Row["case_id"], "subjectId": provider, "requesterId": loaded.Row["requester_id"], "capabilityId": rule["capabilityId"], "collaboration": object(state["request"])["collaboration"], "participatedAt": confirmation["at"], "state": state["state"], "paused": loaded.Paused, "corrected": review["corrected"], "correctionPending": review["correctionPending"], "correctionReview": correctionReview, "disputed": review["disputed"], "accepted": review["accepted"], "eligible": valid, "independence": independence, "sourceEvents": sourceEvents, "revisionIds": revisionIDs, "proofs": linked, "observations": observations, "authority": "participant-reported collaboration; CI retains its limited scope", "capabilityVerified": false}, nil
			}()
			if e != nil {
				if s.Proofs == nil && fault.Code(e) == "honor_proof_unavailable" {
					return result, e
				}
				if !serviceError(e) {
					return result, e
				}
				continue
			}
			if contribution != nil {
				cache[id] = contribution
				result.Contributions = append(result.Contributions, contribution)
			}
		}
		if len(candidates) < 100 {
			break
		}
		after = candidates[len(candidates)-1]["id"]
	}
	return result, nil
}
func (s *Service) legacyObservation(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, proof, rule Object) (*protocol.OrderedObject, error) {
	view, e := s.Proofs.ReadWithin(ctx, tx, a, str(proof, "id"), false)
	if e != nil {
		return nil, e
	}
	value, e := protocol.DecodeOrdered([]byte(str(proof, "payload_text")))
	if e != nil {
		return nil, e
	}
	payload := object(value)
	source := object(payload["source"])
	if number(payload["observedAt"]) < number(rule["windowFrom"]) || number(payload["observedAt"]) >= number(rule["windowUntil"]) {
		return nil, nil
	}
	matched := false
	for _, v := range array(rule["repositories"]) {
		repo := object(v)
		if strings.EqualFold(str(repo, "owner"), str(source, "owner")) && strings.EqualFold(str(repo, "repository"), str(source, "repository")) {
			matched = true
			break
		}
	}
	if !matched {
		return nil, nil
	}
	return ordered("proofId", proof["id"], "evidenceId", proof["evidence_id"], "sourceKey", object(view["provenance"])["sourceKey"], "commit", source["commit"], "conclusion", payload["conclusion"], "strength", "ci-execution-fact", "independence", payload["independence"], "attribution", payload["attribution"], "independentExecutionVerified", false, "capabilityVerified", false), nil
}
func orderedLegacySource(source Object) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, key := range []string{"assistanceId", "caseId", "subjectId", "requesterId", "capabilityId", "collaboration", "participatedAt", "state", "paused", "corrected", "correctionPending", "correctionReview", "disputed", "accepted", "eligible", "independence", "sourceEvents", "revisionIds", "proofs", "observations", "authority", "capabilityVerified"} {
		out.Set(key, source[key])
	}
	return out
}
