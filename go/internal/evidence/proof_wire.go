package evidence

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func fields(o Object, keys ...string) *protocol.OrderedObject {
	v := protocol.NewOrderedObject()
	for _, k := range keys {
		if x, ok := o[k]; ok {
			v.Set(k, x)
		}
	}
	return v
}
func caseContextWire(o Object) *protocol.OrderedObject {
	v := fields(o, "caseId", "sourceVersion", "checkedAt", "status", "scope", "authority", "independentDecision", "affectsSignedCiFact")
	reviews := []any{}
	for _, x := range arr(o["reviews"]) {
		r := obj(x)
		thread := fields(r, "threadId", "type", "targetEventId", "authority", "independentDecision")
		changes := []any{}
		for _, x := range arr(r["changes"]) {
			changes = append(changes, fields(obj(x), "eventId", "state", "reason", "summary"))
		}
		thread.Set("changes", changes)
		thread.Set("state", r["state"])
		reviews = append(reviews, thread)
	}
	v.Set("reviews", reviews)
	corrections := []any{}
	for _, x := range arr(o["corrections"]) {
		corrections = append(corrections, fields(obj(x), "eventId", "targetEventId", "reason", "summary"))
	}
	v.Set("corrections", corrections)
	return v
}

// ReadWireWithin is the owning source port for legacy History's original
// JSON.stringify projectionHash. It keeps the defined wire member order;
// exact signed strings are carried verbatim, never rebuilt from metadata.
func (s *ProofService) ReadWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, statusOnly bool) (json.RawMessage, error) {
	o, e := s.ReadWithin(ctx, tx, a, id, statusOnly)
	if e != nil {
		return nil, e
	}
	var v *protocol.OrderedObject
	if statusOnly {
		v = fields(o, "status", "expiresAt", "capabilityVerified")
	} else {
		v = fields(o, "proofId", "signed", "status")
	}
	if c := obj(o["caseContext"]); c != nil {
		v.Set("caseContext", caseContextWire(c))
	}
	p := obj(o["provenance"])
	v.Set("provenance", fields(p, "version", "profile", "sourceKey", "issuer", "proofId", "source", "conclusion", "sourceControl", "authority", "submitterControlVerified", "independentExecutionVerified"))
	if context, present := o["moderationContext"]; present {
		if _, ok := context.(*protocol.OrderedObject); !ok {
			return nil, fmt.Errorf("ordered moderation source reader unavailable")
		}
		v.Set("moderationContext", context)
	}
	raw, e := protocol.EncodeJS(v)
	return json.RawMessage(raw), e
}
