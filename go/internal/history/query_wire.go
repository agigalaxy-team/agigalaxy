package history

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// QueryWire retains each original ordered item built by projectCase and the
// current field-policy/rebuild pipeline. Legacy Search fingerprints those
// complete items; no metadata row can replace their owning authorization.
// nil candidates means unrestricted source candidates, while empty means none.
func (s *Service) QueryWire(ctx context.Context, a *deviceauth.Actor, raw []byte, candidates []string) (json.RawMessage, error) {
	if s.Pool == nil {
		return nil, fault.New("history_unavailable", 503)
	}
	v, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.QueryCandidatesWithin(ctx, tx, a, raw, candidates) })
	if e != nil {
		return nil, e
	}
	for _, item := range array(v["items"]) {
		historyItemWire(item.(*ordered))
	}
	wire, e := protocol.EncodeJS(v)
	return json.RawMessage(wire), e
}

func wireFields(v any, keys ...string) *ordered {
	out := newObject()
	o := obj(v)
	for _, key := range keys {
		if value, present := o[key]; present {
			out.Set(key, value)
		}
	}
	return out
}
func wireArray(v any, keys ...string) []any {
	out := []any{}
	for _, value := range array(v) {
		out = append(out, wireFields(value, keys...))
	}
	return out
}

// These finite DTO constructors retain the original source insertion order.
// They neither reselect fields for permission nor change the stored hashes.
func historyItemWire(item *ordered) {
	o := item.Values()
	if v := o["collaborationContext"]; v != nil {
		if _, ordered := v.(*ordered); !ordered {
			item.Set("collaborationContext", wireFields(v, "version", "coverage", "capabilityIds", "items", "capabilityVerified"))
		}
	}
	if v := o["moderationContext"]; v != nil {
		if _, ordered := v.(*ordered); !ordered {
			item.Set("moderationContext", wireFields(v, "version", "authority", "automaticallyVerified", "items", "coverage"))
		}
	}
	if v := o["reportedProgress"]; v != nil {
		p := wireFields(v, "version", "authority", "latestResultId", "timeline", "subsequentReports", "capabilityVerified", "attemptCountIsCapability")
		p.Set("timeline", wireArray(obj(v)["timeline"], "resultId", "attemptId", "outcome", "sourceEventVersion", "corrected"))
		p.Set("subsequentReports", wireArray(obj(v)["subsequentReports"], "previousSuccessId", "resultId", "attemptRelation", "regressionVerified"))
		item.Set("reportedProgress", p)
	}
	if v := o["fieldPolicy"]; v != nil {
		item.Set("fieldPolicy", wireFields(v, "id", "version", "view"))
	}
	if v := o["rebuild"]; v != nil {
		r := wireFields(v, "rule", "endpoint", "caseId", "sourceVersion", "view", "contentHash", "sources")
		r.Set("rule", wireFields(obj(v)["rule"], "id", "version"))
		src := obj(v)["sources"]
		source := wireFields(src, "events", "proofIds", "capsuleUseIds", "assistanceIds")
		source.Set("events", wireArray(obj(src)["events"], "id", "kind", "version"))
		r.Set("sources", source)
		item.Set("rebuild", r)
	}
	if v := o["searchExplanation"]; v != nil {
		e := wireFields(v, "rule", "sourceType", "caseId", "order", "scope", "checkedAt", "registeredAt", "textMatches", "capabilityMatches", "verification", "sources", "limitations")
		e.Set("rule", wireFields(obj(v)["rule"], "id", "version"))
		e.Set("textMatches", wireArray(obj(v)["textMatches"], "term", "fields"))
		e.Set("capabilityMatches", wireArray(obj(v)["capabilityMatches"], "capabilityId", "assistanceId", "authority"))
		e.Set("verification", wireFields(obj(v)["verification"], "strength", "proofIds", "capabilityVerified", "meaning"))
		e.Set("sources", wireArray(obj(v)["sources"], "kind", "id"))
		item.Set("searchExplanation", e)
	}
}
