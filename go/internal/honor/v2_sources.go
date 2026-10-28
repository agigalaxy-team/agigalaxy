package honor

import (
	"context"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type permittedSource struct {
	Row        Object
	Kind       string
	Permission contributions.Permission
}

func (s *Service) ciProofs(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input civ2.ProofQuery) ([]any, error) {
	if s.CI == nil {
		return []any{}, nil
	}
	raw, e := s.CI.ProofsForWireWithin(ctx, tx, a, input)
	if e != nil {
		return nil, e
	}
	value, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	return array(value), nil
}
func (s *Service) v2Sources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, subject string, policy Object) ([]Object, error) {
	if s.Qualification == nil || s.Sharing == nil {
		return nil, fail("honor_source_unavailable", 503)
	}
	items := []Object{}
	var after any
	for {
		candidates, e := rows(ctx, tx, "SELECT to_jsonb(p) FROM task_participations p JOIN task_requests t ON t.id=p.task_id WHERE p.subject_id=$1 AND t.snapshot->'request'->>'capabilityId'=$2 AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT 100", subject, policy["capabilityId"], after)
		if e != nil {
			return nil, e
		}
		for _, candidate := range candidates {
			scope := object(candidate["snapshot"])
			if scope["contentDeleted"] == true || scope["confirmedAt"] == nil || number(scope["confirmedAt"]) < number(policy["windowFrom"]) || number(scope["confirmedAt"]) >= number(policy["windowUntil"]) {
				continue
			}
			task, e := row(ctx, tx, "SELECT to_jsonb(t) FROM task_requests t WHERE id=$1", candidate["task_id"])
			if e != nil {
				return nil, e
			}
			if task == nil || object(task["snapshot"])["contentDeleted"] == true {
				continue
			}
			if policy["kind"] == "open-contributor" && object(object(task["snapshot"])["request"])["collaboration"] != "open-assistance" {
				continue
			}
			permitted := []permittedSource{}
			indices := map[string]int{}
			trace := &qualification.SourceTrace{ReadEventWithin: func(kind string, row Object) error {
				p, e := s.Sharing.AuthorizeWithin(ctx, tx, a, kind, row, "honor")
				if e != nil {
					return e
				}
				key := kind + ":" + str(row, "id")
				entry := permittedSource{row, kind, p}
				if i, ok := indices[key]; ok {
					permitted[i] = entry
				} else {
					indices[key] = len(permitted)
					permitted = append(permitted, entry)
				}
				return nil
			}, ReadEvidenceWithin: func(ref, sourceContext Object) error {
				if s.Qualification.Cases == nil || s.Qualification.Cases.Sources == nil {
					return fail("source_access_unavailable", 503)
				}
				source := Object{"kind": "evidence"}
				for k, v := range ref {
					source[k] = v
				}
				_, e := s.Qualification.Cases.Sources(ctx, tx, a, source, Object{"caseId": sourceContext["caseId"]})
				if e == nil {
					return nil
				}
				if !absent(e) || s.CI == nil {
					return e
				}
				proofs, proofErr := s.ciProofs(ctx, tx, a, civ2.ProofQuery{SubjectID: subject, CaseID: str(sourceContext, "caseId"), ResultRef: object(sourceContext["resultRef"]), EvidenceRefs: []Object{ref}})
				if proofErr != nil {
					return proofErr
				}
				if len(proofs) == 0 {
					return e
				}
				return nil
			}}
			eligibilityPolicy := clone(policy).(Object)
			eligibilityPolicy["historyWindowSeconds"] = int64(9007199254740991)
			fact, e := s.Qualification.ParticipationSourceWithin(ctx, tx, a, str(candidate, "id"), subject, eligibilityPolicy, trace)
			problem := ""
			if e != nil {
				if !absent(e) {
					return nil, e
				}
				problem = fault.Code(e)
			}
			visibleParticipant := false
			for _, p := range permitted {
				if p.Kind == "task-event" && p.Row["participation_id"] == candidate["id"] && p.Row["subject_id"] == subject {
					visibleParticipant = true
					break
				}
			}
			if !visibleParticipant {
				continue
			}
			projections := []any{}
			for _, p := range permitted {
				projection, e := s.Sharing.ProjectOrderedWithin(ctx, tx, a, p.Row, p.Permission.Fields, p.Permission)
				if e != nil {
					return nil, e
				}
				projections = append(projections, ordered("source", s.Sharing.ReferenceOrdered(p.Row, p.Kind, p.Permission), "projection", projection, "publicationIds", p.Permission.PublicationIDs))
			}
			observations := []any{}
			if fact["usable"] == true && s.CI != nil {
				refs := []Object{}
				for _, v := range array(fact["evidenceRefs"]) {
					refs = append(refs, object(v))
				}
				observations, e = s.ciProofs(ctx, tx, a, civ2.ProofQuery{SubjectID: subject, CaseID: str(fact, "caseId"), ResultRef: object(fact["resultRef"]), EvidenceRefs: refs, Policy: policy})
				if e != nil {
					return nil, e
				}
			}
			proofs := []any{}
			for _, v := range observations {
				if object(v)["conclusion"] == "success" {
					proofs = append(proofs, v)
				}
			}
			related := false
			for _, group := range array(policy["relatedPartyGroups"]) {
				if has(group, subject) && has(group, str(task, "requester_id")) {
					related = true
					break
				}
			}
			independence := "relationship-not-independently-verified"
			if related {
				independence = "issuer-declared-related-party"
			}
			sourceStatus := problem
			if sourceStatus == "" {
				sourceStatus = str(fact, "reason")
				if sourceStatus == "" {
					if fact["synthetic"] == true {
						sourceStatus = "synthetic-excluded"
					} else {
						sourceStatus = "current"
					}
				}
			}
			caseID := fact["caseId"]
			if caseID == nil {
				caseID = task["case_id"]
			}
			idRaw, _ := protocol.EncodeJS([]any{s.Endpoint, subject, policy["id"], policy["version"], candidate["id"]})
			items = append(items, Object{"id": identity.Digest(idRaw), "_caseId": caseID, "_eligible": fact["usable"] == true, "_synthetic": fact["synthetic"] != false, "subjectId": subject, "eligible": fact["usable"] == true && fact["synthetic"] == false, "sourceStatus": sourceStatus, "projections": projections, "proofs": proofs, "observations": observations, "independence": independence, "contributionMeaning": "accepted scoped work; not necessarily a successful Case or independent capability verification"})
		}
		if len(candidates) < 100 {
			break
		}
		after = candidates[len(candidates)-1]["id"]
	}
	c := collate.New(language.English)
	sort.SliceStable(items, func(i, j int) bool { return c.CompareString(str(items[i], "id"), str(items[j], "id")) < 0 })
	return items, nil
}
