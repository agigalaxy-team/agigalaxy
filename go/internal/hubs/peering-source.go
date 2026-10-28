package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (p *Peering) source(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, source Object, author string) (*protocol.OrderedObject, error) {
	raw, _ := protocol.Encode(source)
	wire, e := parsedWire("peeringSourceSchema", raw)
	if e != nil {
		return nil, e
	}
	source = wire.Values()
	if source["kind"] == "ci-proof-v2" {
		row, e := one(ctx, tx, "SELECT * FROM ci_proofs_v2 WHERE id=$1", source["id"])
		if e != nil {
			return nil, e
		}
		if row == nil || row["subject_id"] != author || row["payload_hash"] != source["payloadHash"] || txt(row, "payload_text") == "" {
			return nil, fault.New("peering_source_unavailable", 404)
		}
		if p.CI == nil {
			return nil, fault.New("peering_ci_source_unavailable", 503)
		}
		view, e := p.CI.ProofWithin(ctx, tx, a, txt(source, "id"))
		if e != nil {
			return nil, e
		}
		data := obj(view["data"])
		if data["issuer"] != p.Hubs.Endpoint {
			return nil, fault.New("peering_foreign_issuer_not_delegated", 403)
		}
		provenance := obj(view["provenance"])
		return ordered("sourceKey", provenance["sourceKey"], "sourceObject", ordered("kind", source["kind"], "id", source["id"], "payloadHash", source["payloadHash"]), "issuer", data["issuer"], "subjectId", data["subject"], "authority", provenance["authority"], "signed", view["signed"], "observedAt", data["observedAt"], "expiresAt", data["expiresAt"], "synthetic", data["synthetic"], "capabilityVerified", false), nil
	}
	if p.Sharing == nil {
		return nil, fault.New("peering_contribution_source_unavailable", 503)
	}
	ref := obj(source["source"])
	row, e := p.Sharing.SourceWithin(ctx, tx, ref)
	if e != nil {
		return nil, e
	}
	if row["subject_id"] != author {
		return nil, fault.New("peering_source_author_required", 403)
	}
	if _, e = p.Sharing.SourceGrantWithin(ctx, tx, txt(ref, "kind"), row); e != nil {
		return nil, e
	}
	fields := []string{}
	for _, v := range arr(source["fields"]) {
		fields = append(fields, v.(string))
	}
	projected, e := p.Sharing.Project(row, fields)
	if e != nil {
		return nil, e
	}
	projection := protocol.NewOrderedObject()
	for _, field := range fields {
		projection.Set(field, projected[field])
	}
	payload := event(row)
	fact := obj(payload["event"])
	if fact == nil {
		fact = payload
	}
	var parent, root Object
	if ref["kind"] == "case-event" {
		parent, e = one(ctx, tx, "SELECT payload_text FROM case_events WHERE case_id=$1 AND kind='case-created' ORDER BY created_at,id LIMIT 1", row["case_id"])
		if e != nil {
			return nil, e
		}
		root = event(parent)
	} else {
		parent, e = one(ctx, tx, "SELECT snapshot FROM task_requests WHERE id=$1", row["task_id"])
		if e != nil {
			return nil, e
		}
		root = obj(parent["snapshot"])
	}
	var synthetic any
	if fact["synthetic"] == true {
		synthetic = true
	} else if root != nil {
		synthetic = root["synthetic"] == true || obj(root["request"])["synthetic"] == true
	}
	keyJSON, _ := protocol.EncodeJS([]any{p.Hubs.Endpoint, ref["kind"], ref["id"], ref["payloadHash"]})
	observed := row["received_at"]
	if observed == nil {
		observed = p.Hubs.now()
	}
	return ordered("sourceKey", identity.Digest(keyJSON), "sourceObject", source["source"], "issuer", p.Hubs.Endpoint, "subjectId", row["subject_id"], "authority", "author-selected-contribution-summary", "projection", projection, "observedAt", observed, "capabilityVerified", false, "independentExecutionVerified", false, "synthetic", synthetic, "originalTextAccessGranted", false), nil
}
func (p *Peering) grantProjection(ctx context.Context, tx pgx.Tx, row Object, requester string, ag peerAgreement) (*protocol.OrderedObject, error) {
	ev, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1", row["id"])
	if e != nil {
		return nil, e
	}
	run := func() (*protocol.OrderedObject, error) {
		if row["revoked_at"] != nil || num(row, "expires_at") <= p.Hubs.now() || num(row, "agreement_version") != num(ag.row, "version") || !has(arr(row["requester_ids"]), requester) {
			return nil, peerMissing()
		}
		if _, e = p.Hubs.grant(ctx, tx, ev); e != nil {
			return nil, e
		}
		if e = p.publicationMembership(ctx, tx, txt(row, "subject_id"), ag); e != nil {
			return nil, e
		}
		parsed, e := parsedWire("peeringEventSchema", []byte(txt(ev, "payload_text")))
		if e != nil {
			return nil, e
		}
		source := obj(parsed.Values()["source"])
		if !has(arr(ag.agreement.Values()["sourceKinds"]), source["kind"]) {
			return nil, peerMissing()
		}
		// The only foreign authority here is the verified explicit peer query scope.
		// This actor is never submitted to Authenticate/CurrentControl or writes.
		viewer := &deviceauth.Actor{SubjectID: requester}
		view, e := p.source(ctx, tx, viewer, source, txt(row, "subject_id"))
		if e != nil {
			return nil, e
		}
		if e = p.change(ctx, tx, row, "permitted"); e != nil {
			return nil, e
		}
		view.Set("grantId", row["id"])
		view.Set("state", "current")
		expiry := num(row, "expires_at")
		if view.Values()["expiresAt"] != nil {
			expiry = min(expiry, num(view.Values(), "expiresAt"))
		}
		view.Set("expiresAt", expiry)
		return view, nil
	}
	out, e := run()
	if e == nil {
		return out, nil
	}
	if !peerUnavailable(e) {
		return nil, e
	}
	if e = p.change(ctx, tx, row, "unavailable"); e != nil {
		return nil, e
	}
	return ordered("grantId", row["id"], "state", "unavailable"), nil
}
