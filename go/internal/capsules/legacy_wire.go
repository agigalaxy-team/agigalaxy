package capsules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func proofReferenceWire(values []any) []any {
	out := []any{}
	for _, v := range values {
		out = append(out, orderedFields(obj(v), "proofId", "state", "strength", "capabilityVerified"))
	}
	return out
}
func (s *Service) legacyUsesWire(ctx context.Context, tx pgx.Tx, view Object) (json.RawMessage, error) {
	items := []any{}
	for _, value := range list(view["items"]) {
		item := obj(value)
		row, e := one(ctx, tx, `SELECT payload_text FROM capsule_uses WHERE id=$1`, item["id"])
		if e != nil {
			return nil, e
		}
		payload, e := parseStored(row)
		if e != nil {
			return nil, e
		}
		wire := protocol.NewOrderedObject()
		wire.Set("subjectId", item["subjectId"])
		for _, key := range payload.Keys() {
			wire.Set(key, payload.Values()[key])
		}
		for _, key := range []string{"sourceNeedsReview", "capsuleDeprecated", "capsuleSecurityIssue", "proofs", "verification", "reuseEvidence", "capabilityVerified"} {
			wire.Set(key, item[key])
		}
		wire.Set("proofs", proofReferenceWire(list(item["proofs"])))
		if reuse := obj(item["reuseEvidence"]); reuse != nil {
			reuseWire := orderedFields(reuse, "type", "id", "subjectId", "attribution", "capsuleId", "versionId", "caseId", "attemptId", "resultId", "outcome", "sourceHash", "sourceCaseVersion", "sourceNeedsReview", "provenance", "verification", "proofs", "capabilityVerified", "limitations", "checkedAt")
			reuseWire.Set("proofs", proofReferenceWire(list(reuse["proofs"])))
			wire.Set("reuseEvidence", reuseWire)
		}
		items = append(items, wire)
	}
	wire := orderedFields(view, "items", "nextAfter", "windowLimited", "countsScope", "counts", "readingIsReuse")
	wire.Set("items", items)
	wire.Set("counts", orderedFields(obj(view["counts"]), "references", "applications", "reverifications", "failed"))
	raw, e := protocol.EncodeJS(wire)
	return json.RawMessage(raw), e
}

// LegacyHistoryWireWithin is the exact current-authorized v1 reuse companion;
// v2 use records remain separate and are never merged into its page counts.
func (s *Service) LegacyHistoryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, caseID string) (json.RawMessage, error) {
	view, e := s.UsesWithin(ctx, tx, a, Object{"caseId": caseID, "limit": int64(20)})
	if e != nil {
		return nil, e
	}
	return s.legacyUsesWire(ctx, tx, view)
}
