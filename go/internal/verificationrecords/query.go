package verificationrecords

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func queryRef(v any) bool {
	o := obj(v)
	if !exact(o, []string{"type", "id"}, []string{"version"}) || !one(o["type"], "evidence", "verification", "proof", "ci-proof-v2") || !uuidPattern.MatchString(str(o, "id")) {
		return false
	}
	if _, ok := o["version"]; ok && !safe(o, "version", 1, 9007199254740991) {
		return false
	}
	return true
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var ref Object
	if protocol.Decode(raw, &ref) != nil || !queryRef(ref) {
		return nil, fault.New("invalid_record_reference", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadWithin(ctx, tx, &a, ref)
	})
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || !exact(q, []string{"type", "id", "operationId", "payloadHash"}, nil) || !one(q["type"], "evidence", "verification") || !uuidPattern.MatchString(str(q, "id")) || !uuidPattern.MatchString(str(q, "operationId")) || !hashPattern.MatchString(str(q, "payloadHash")) {
		return nil, fault.New("invalid_verification_receipt_query", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var operation, id, hash, kind string
		var version int64
		var accepted time.Time
		e := tx.QueryRow(ctx, `SELECT e.operation_id::text,e.object_id::text,e.version,e.payload_hash,e.created_at,o.object_type FROM verification_events e JOIN verification_objects o ON o.id=e.object_id WHERE e.operation_id=$1 AND o.subject_id=$2`, q["operationId"], a.SubjectID).Scan(&operation, &id, &version, &hash, &accepted, &kind)
		state := "acknowledged"
		if errors.Is(e, pgx.ErrNoRows) {
			state = "absent"
		} else if e != nil {
			return nil, e
		} else if id != str(q, "id") || kind != str(q, "type") || hash != str(q, "payloadHash") {
			state = "conflict"
		}
		out := copyObject(q)
		out["state"] = state
		out["authority"] = "accepted-operation-only"
		out["audience"] = "owner-only"
		out["currentAccessGranted"] = false
		out["contentReturned"] = false
		out["sourceAccessChecked"] = false
		switch state {
		case "acknowledged":
			receipt := copyObject(q)
			receipt["version"] = version
			receipt["acceptedAt"] = accepted.UTC().Format("2006-01-02T15:04:05.000Z")
			out["receipt"] = receipt
		case "absent":
			out["absenceMeaning"] = "no-retained-owner-operation"
		case "conflict":
			out["reason"] = "original-operation-mismatch"
		}
		return out, nil
	})
}
func includes(a []string, key string) bool {
	for _, v := range a {
		if v == key {
			return true
		}
	}
	return false
}
func (s *Service) Status(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	var query Object
	if protocol.Decode(raw, &query) != nil || !exact(query, []string{"refs"}, nil) {
		return nil, fault.New("invalid_evidence_status_query", 400)
	}
	refs, ok := query["refs"].([]any)
	if !ok || len(refs) > 100 {
		return nil, fault.New("invalid_evidence_status_query", 400)
	}
	for _, ref := range refs {
		if !queryRef(ref) {
			return nil, fault.New("invalid_evidence_status_query", 400)
		}
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		items := []any{}
		for _, v := range refs {
			ref := obj(v)
			var item Object
			var e error
			switch ref["type"] {
			case "proof", "ci-proof-v2":
				if !includes(auth.CredentialScopes, "proof") {
					e = fault.New("proof_scope_required", 403)
				} else if ref["type"] == "ci-proof-v2" {
					if s.CIProofWithin == nil {
						e = fault.New("proof_service_unavailable", 503)
					} else {
						item, e = s.CIProofWithin(ctx, tx, &a, str(ref, "id"))
					}
				} else if s.Proofs == nil {
					e = fault.New("proof_service_unavailable", 503)
				} else {
					item, e = s.Proofs.ReadWithin(ctx, tx, &a, str(ref, "id"), true)
				}
				if e == nil {
					result := copyObject(ref)
					profile := "ci-execution-observation"
					if ref["type"] == "ci-proof-v2" {
						profile = "ci-execution-observation/facts-v2"
					}
					result["profile"] = profile
					for k, v := range item {
						result[k] = v
					}
					result["taskOutcomeVerified"] = false
					item = result
				}
			default:
				item, e = s.ReadWithin(ctx, tx, &a, ref)
			}
			if e != nil {
				if !isService(e) {
					return nil, e
				}
				item = copyObject(ref)
				item["referenceStatus"] = "unavailable"
				item["reason"] = fault.Code(e)
				item["currentRevocation"] = "unknown"
				item["capabilityVerified"] = false
				item["taskOutcomeVerified"] = false
			}
			items = append(items, item)
		}
		groups := map[string][]any{}
		order := []string{}
		records := 0
		for _, v := range items {
			item := obj(v)
			key := str(obj(item["provenance"]), "sourceKey")
			if item["type"] == "evidence" && key != "" {
				records++
				if _, ok := groups[key]; !ok {
					groups[key] = []any{}
					order = append(order, key)
				}
				groups[key] = append(groups[key], Object{"id": item["id"], "version": item["version"], "synthetic": item["synthetic"]})
			}
		}
		outGroups := []any{}
		for _, key := range order {
			outGroups = append(outGroups, Object{"sourceKey": key, "refs": groups[key]})
		}
		return Object{"items": items, "checkedAt": time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z"), "coverage": "requested-visible-references", "sourceSummary": Object{"evidenceRecordCount": records, "declaredSourceGroupCount": len(groups), "duplicateRecordCount": records - len(groups), "independentlyVerifiedSourceCount": 0, "globalCountProvided": false, "groups": outGroups}}, nil
	})
}
