package capsules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

const legacyCandidates = `SELECT p.id FROM capsules p WHERE ($1::uuid IS NULL OR p.id>$1) AND ($2::text IS NULL OR p.subject_id=$2)
 AND ($6::uuid[] IS NULL OR p.id=ANY($6))
 AND EXISTS(SELECT 1 FROM capsule_events v JOIN consents c ON c.id=v.consent_id JOIN bindings b ON b.id=c.binding_id
 JOIN cases source ON source.id=(NULLIF(v.payload_text,'')::jsonb->'sourceResolution'->>'caseId')::uuid
 WHERE v.capsule_id=p.id AND v.kind='version' AND source.subject_id=v.subject_id AND source.state<>'withdrawn'
 AND c.subject_id=v.subject_id AND b.subject_id=v.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL
 AND c.expires_at>$4 AND b.expires_at>$4 AND c.intent->>'recipient'=$5 AND c.intent->>'action'='capsule.publish'
 AND c.intent->>'objectId'=v.id::text AND c.intent->>'payloadHash'=v.payload_hash
 AND(v.subject_id=$3 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
 OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($3,''))
 AND NOT EXISTS(SELECT 1 FROM case_events e LEFT JOIN consents source_grant ON source_grant.id=e.consent_id LEFT JOIN bindings binding ON binding.id=source_grant.binding_id
 WHERE e.case_id=source.id AND(source_grant.id IS NULL OR binding.id IS NULL OR source_grant.revoked_at IS NOT NULL OR binding.revoked_at IS NOT NULL
 OR source_grant.expires_at<=$4 OR binding.expires_at<=$4 OR source_grant.subject_id<>source.subject_id OR binding.subject_id<>source.subject_id
 OR source_grant.intent->>'action'<>'case.teaser.publish' OR source_grant.intent->>'recipient'<>$5
 OR source_grant.intent->>'objectId'<>e.id::text OR source_grant.intent->>'payloadHash'<>e.payload_hash))) ORDER BY p.id LIMIT 201`

func viewer(a *deviceauth.Actor) any {
	if a != nil {
		return a.SubjectID
	}
	return nil
}
func (s *Service) QueryCandidates(ctx context.Context, a *deviceauth.Actor, raw []byte, candidateIDs []string) (Object, error) {
	p, e := parseInput(raw, "query")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, legacyCandidates, p["after"], p["authorId"], viewer(a), time.Unix(s.now(), 0), s.Endpoint, candidateIDs)
		if e != nil {
			return nil, e
		}
		items := []any{}
		var last any
		end := len(rows)
		if end > 200 {
			end = 200
		}
		limit := int(number(p, "limit"))
		for _, row := range rows[:end] {
			item, e := s.readLegacyWithin(ctx, tx, a, Object{"capsuleId": row["id"]})
			if e != nil {
				if serviceError(e) {
					continue
				}
				return nil, e
			}
			last = row["id"]
			v := obj(item["version"])
			if p["capabilityId"] != nil && v["capabilityId"] != p["capabilityId"] || !strings.Contains(lower(text(v, "title")+" "+text(v, "problemPattern")), lower(text(p, "query"))) {
				continue
			}
			items = append(items, Object{"capsuleId": row["id"], "versionId": item["versionId"], "version": v["version"], "title": v["title"], "capabilityId": v["capabilityId"], "deprecated": item["deprecated"], "securityIssue": item["securityIssue"], "sourceNeedsReview": item["sourceNeedsReview"]})
			if len(items) > limit {
				break
			}
		}
		limited := len(items) <= limit && len(rows) > 200
		var next any
		if len(items) > limit {
			items = items[:limit]
			next = obj(items[len(items)-1])["capsuleId"]
		} else if limited {
			next = last
		}
		return Object{"items": items, "nextAfter": next, "windowLimited": limited}, nil
	})
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	return s.QueryCandidates(ctx, a, raw, nil)
}

// QueryWire is the v1 original public-candidate consumer, distinct from V2.
func (s *Service) QueryWire(ctx context.Context, a *deviceauth.Actor, raw []byte, candidateIDs []string) (json.RawMessage, error) {
	o, e := s.QueryCandidates(ctx, a, raw, candidateIDs)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range list(o["items"]) {
		items = append(items, orderedFields(obj(v), "capsuleId", "versionId", "version", "title", "capabilityId", "deprecated", "securityIssue", "sourceNeedsReview"))
	}
	o["items"] = items
	b, e := protocol.EncodeJS(orderedFields(o, "items", "nextAfter", "windowLimited"))
	return json.RawMessage(b), e
}

const legacyUseCandidates = `SELECT u.* FROM capsule_uses u
 JOIN consents c ON c.id=u.consent_id JOIN bindings b ON b.id=c.binding_id
 JOIN capsule_events v ON v.id=u.version_id JOIN consents vc ON vc.id=v.consent_id JOIN bindings vb ON vb.id=vc.binding_id
 JOIN cases source ON source.id=u.case_id AND source.subject_id=u.subject_id
 WHERE($1::uuid IS NULL OR u.capsule_id=$1)AND($2::uuid IS NULL OR u.version_id=$2)
 AND($3::uuid IS NULL OR u.case_id=$3)AND($4::uuid IS NULL OR u.id>$4)AND source.state<>'withdrawn'
 AND c.subject_id=u.subject_id AND b.subject_id=u.subject_id AND c.revoked_at IS NULL AND b.revoked_at IS NULL
 AND c.expires_at>$6 AND b.expires_at>$6 AND c.intent->>'recipient'=$7 AND c.intent->>'action'='capsule.use'
 AND c.intent->>'objectId'=u.id::text AND c.intent->>'payloadHash'=u.payload_hash
 AND(u.subject_id=$5 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
 OR c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($5,''))
 AND vc.subject_id=v.subject_id AND vb.subject_id=v.subject_id AND vc.revoked_at IS NULL AND vb.revoked_at IS NULL
 AND vc.expires_at>$6 AND vb.expires_at>$6 AND vc.intent->>'recipient'=$7 AND vc.intent->>'action'='capsule.publish'
 AND vc.intent->>'objectId'=v.id::text AND vc.intent->>'payloadHash'=v.payload_hash
 AND(v.subject_id=$5 OR vc.intent->>'visibility'='Public' AND vc.intent->>'purpose'='public-profile'
 OR vc.intent->>'visibility'='Private' AND vc.intent->'viewers' ? COALESCE($5,''))
 AND NOT EXISTS(SELECT 1 FROM case_events e LEFT JOIN consents g ON g.id=e.consent_id LEFT JOIN bindings gb ON gb.id=g.binding_id
 WHERE e.case_id=source.id AND(g.id IS NULL OR gb.id IS NULL OR g.revoked_at IS NOT NULL OR gb.revoked_at IS NOT NULL
 OR g.expires_at<=$6 OR gb.expires_at<=$6 OR g.subject_id<>source.subject_id OR gb.subject_id<>source.subject_id
 OR g.intent->>'recipient'<>$7 OR g.intent->>'action'<>'case.teaser.publish'
 OR g.intent->>'objectId'<>e.id::text OR g.intent->>'payloadHash'<>e.payload_hash)) ORDER BY u.id LIMIT 201`

func (s *Service) UsesWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, p Object) (Object, error) {
	rows, e := query(ctx, tx, legacyUseCandidates, p["capsuleId"], p["versionId"], p["caseId"], p["after"], viewer(a), time.Unix(s.now(), 0), s.Endpoint)
	if e != nil {
		return nil, e
	}
	items := []any{}
	var last any
	end := len(rows)
	if end > 200 {
		end = 200
	}
	limit := int(number(p, "limit"))
	for _, row := range rows[:end] {
		item, e := func() (Object, error) {
			g, e := s.grant(ctx, tx, row, "capsule.use")
			if e != nil {
				return nil, e
			}
			if !s.visible(g, a) {
				return nil, nil
			}
			source, e := s.caseSource(ctx, tx, text(row, "case_id"), text(row, "subject_id"))
			if e != nil {
				return nil, e
			}
			wire, e := parseStored(row)
			if e != nil {
				return nil, e
			}
			payload := wire.Values()
			current, e := s.legacyVersion(ctx, tx, a, text(row, "capsule_id"), text(row, "version_id"))
			if e != nil {
				return nil, e
			}
			if payload["kind"] == "reverify" {
				prior, e := one(ctx, tx, `SELECT * FROM capsule_uses WHERE id=$1`, payload["priorUseId"])
				if e != nil {
					return nil, e
				}
				if prior == nil {
					return nil, nil
				}
				if _, e = s.grant(ctx, tx, prior, "capsule.use"); e != nil {
					return nil, e
				}
			}
			proofs, e := s.proofReferences(ctx, tx, a, list(payload["proofIds"]), text(row, "case_id"), text(row, "result_id"), false)
			if e != nil {
				return nil, e
			}
			verification := "participant-reported"
			allCurrent := len(proofs) > 0
			for _, v := range proofs {
				allCurrent = allCurrent && obj(v)["state"] == "current"
			}
			if payload["kind"] == "reverify" && allCurrent && source["needsReview"] != true {
				verification = "current-ci-facts"
			}
			var reuse any
			if payload["kind"] != "reference" {
				reuse = Object{"type": "capsule-reuse", "id": row["id"], "subjectId": row["subject_id"], "attribution": payload["attribution"], "capsuleId": row["capsule_id"], "versionId": row["version_id"], "caseId": row["case_id"], "attemptId": payload["attemptId"], "resultId": payload["resultId"], "outcome": payload["outcome"], "sourceHash": row["payload_hash"], "sourceCaseVersion": obj(source["parent"])["version"], "sourceNeedsReview": source["needsReview"], "provenance": "case-owner-reported-application", "verification": verification, "proofs": proofs, "capabilityVerified": false, "limitations": []any{"CI verifies its referenced run, not Capsule causality or individual capability."}, "checkedAt": s.now()}
			}
			out := Object{"subjectId": row["subject_id"]}
			for k, v := range payload {
				out[k] = v
			}
			out["sourceNeedsReview"] = source["needsReview"]
			out["capsuleDeprecated"] = current.deprecated
			out["capsuleSecurityIssue"] = current.security
			out["proofs"] = proofs
			out["verification"] = verification
			out["reuseEvidence"] = reuse
			out["capabilityVerified"] = false
			return out, nil
		}()
		if e != nil {
			if serviceError(e) {
				continue
			}
			return nil, e
		}
		if item == nil {
			continue
		}
		items = append(items, item)
		last = row["id"]
		if len(items) > limit {
			break
		}
	}
	limited := len(items) <= limit && len(rows) > 200
	var next any
	if len(items) > limit {
		items = items[:limit]
		next = obj(items[len(items)-1])["id"]
	} else if limited {
		next = last
	}
	counts := Object{"references": 0, "applications": 0, "reverifications": 0, "failed": 0}
	for _, v := range items {
		o := obj(v)
		k := ""
		switch o["kind"] {
		case "reference":
			k = "references"
		case "apply":
			k = "applications"
		case "reverify":
			k = "reverifications"
		}
		if k != "" {
			counts[k] = number(counts, k) + 1
		}
		if o["outcome"] == "failed" {
			counts["failed"] = number(counts, "failed") + 1
		}
	}
	return Object{"items": items, "nextAfter": next, "windowLimited": limited, "countsScope": "visible-page-only", "counts": counts, "readingIsReuse": false}, nil
}
func (s *Service) Uses(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "uses")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) { return s.UsesWithin(ctx, tx, a, p) })
}
