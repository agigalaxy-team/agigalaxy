package civ2

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func proofFields(o Object, keys ...string) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, key := range keys {
		if v, ok := o[key]; ok {
			out.Set(key, v)
		}
	}
	return out
}

// ProofsForWireWithin serializes only the original, currently authorized CI
// summary projection. It retains the source fingerprint's member order.
func (s *Service) ProofsForWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, in ProofQuery) (json.RawMessage, error) {
	items, e := s.ProofsForWithin(ctx, tx, a, in)
	if e != nil {
		return nil, e
	}
	wire := make([]any, 0, len(items))
	for _, item := range items {
		wire = append(wire, proofFields(item, "proofId", "sourceKey", "commit", "conclusion", "statusUrl", "synthetic", "independentExecutionVerified"))
	}
	raw, e := protocol.EncodeJS(wire)
	return json.RawMessage(raw), e
}

// ReadProofWireWithin retains original projection member order after the
// complete owning current-source/signature/visibility checks in ProofWithin.
func (s *Service) ReadProofWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
	view, e := s.ProofWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	wire := proofFields(view, "proofId", "status", "signed", "data")
	wire.Set("provenance", proofFields(obj(view["provenance"]), "version", "profile", "sourceKey", "issuer", "proofId", "source", "conclusion", "sourceControl", "authority", "submitterControlVerified", "independentExecutionVerified"))
	for _, key := range []string{"taskOutcomeVerified", "capabilityVerified", "independentExecutionVerified"} {
		wire.Set(key, view[key])
	}
	raw, e := protocol.EncodeJS(wire)
	return json.RawMessage(raw), e
}
