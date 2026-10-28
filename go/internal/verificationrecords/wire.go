package verificationrecords

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func orderedFields(o Object, keys ...string) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out.Set(k, v)
		}
	}
	return out
}
func publicWire(v any) any {
	if o, ok := v.(*protocol.OrderedObject); ok {
		out := protocol.NewOrderedObject()
		for _, k := range o.Keys() {
			if k != "recordEventIds" {
				out.Set(k, publicWire(o.Values()[k]))
			}
		}
		return out
	}
	if a, ok := v.([]any); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, publicWire(v))
		}
		return out
	}
	return v
}

// ReadWireWithin supplies History's original JSON.stringify fingerprint with
// current-authorized view members and the original JSONB member order. The
// owning ReadWithin runs first; raw retained fields never substitute for ACLs.
func (s *Service) ReadWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object) (json.RawMessage, error) {
	view, e := s.ReadWithin(ctx, tx, a, ref)
	if e != nil {
		return nil, e
	}
	var out *protocol.OrderedObject
	if view["record"] == nil {
		if view["referenceStatus"] == "revoked" {
			out = orderedFields(view, "id", "type", "version", "currentVersion", "referenceStatus", "record", "capabilityVerified", "taskOutcomeVerified")
		} else {
			out = orderedFields(view, "id", "type", "version", "currentVersion", "referenceStatus", "reason", "observedAt", "capabilityVerified", "taskOutcomeVerified", "record")
		}
	} else {
		var payload, contextRaw []byte
		if e = tx.QueryRow(ctx, `SELECT payload,context FROM verification_events WHERE object_id=$1 AND version=$2`, view["id"], view["version"]).Scan(&payload, &contextRaw); e != nil {
			return nil, e
		}
		rawPayload, e := protocol.DecodeOrdered(payload)
		if e != nil {
			return nil, e
		}
		rawContext, e := protocol.DecodeOrdered(contextRaw)
		if e != nil {
			return nil, e
		}
		contextView := rawContext.(*protocol.OrderedObject)
		contextView.Set("synthetic", view["synthetic"])
		out = orderedFields(view, "id", "type", "version", "operationId", "state", "currentVersion", "currentState", "sourceStrength", "independentExecutionVerified", "capabilityVerified", "taskOutcomeVerified", "synthetic")
		out.Set("record", publicWire(rawPayload))
		out.Set("provenance", contextView)
		for _, k := range []string{"integrity", "authorization", "externalOwnershipVerified"} {
			out.Set(k, view[k])
		}
		out.Set("availability", orderedFields(obj(view["availability"]), "record", "upstream", "upstreamRevocation"))
		out.Set("revocation", view["revocation"])
		for _, k := range []string{"current", "referenceStatus", "targetCurrentVersion"} {
			if v, ok := view[k]; ok {
				out.Set(k, v)
			}
		}
	}
	raw, e := protocol.EncodeJS(out)
	return json.RawMessage(raw), e
}
