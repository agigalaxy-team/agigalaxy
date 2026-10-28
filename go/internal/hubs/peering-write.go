package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (p *Peering) Submit(ctx context.Context, a deviceauth.Actor, input Object, requestID string) (Object, error) {
	if e := p.ready(); e != nil {
		return nil, e
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, fault.New("invalid_hub_write", 400)
	}
	if _, e = parse("peeringWriteSchema", raw); e != nil {
		return nil, fault.New("invalid_hub_write", 400)
	}
	payload := txt(input, "payloadJson")
	if len(payload) > 48000 {
		return nil, fault.New("invalid_peering_event", 400)
	}
	wire, e := parsedWire("peeringEventSchema", []byte(payload))
	if e != nil {
		return nil, fault.New("invalid_peering_event", 400)
	}
	ev := wire.Values()
	kind := txt(ev, "kind")
	s := p.Hubs
	return s.run(ctx, &a, true, kind == "peer-exit" || kind == "source-revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		grant, e := s.grant(ctx, tx, Object{"id": ev["id"], "subject_id": a.SubjectID, "consent_id": input["consentId"], "payload_text": payload})
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" || len(grant.Viewers) > 0 {
			return nil, fault.New("peering_control_intent_private", 403)
		}
		prior, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1", ev["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["consent_id"] != input["consentId"] || prior["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fault.New("peering_event_conflict", 409)
			}
			return peerReceipt(prior), nil
		}
		head, e := s.head(ctx, tx, txt(ev, "hubId"), true)
		if e != nil {
			return nil, e
		}
		switch kind {
		case "peer-approve":
			if head["owner_id"] != a.SubjectID {
				return nil, fault.New("hub_operator_required", 403)
			}
			if _, _, e = s.current(ctx, tx, &a, txt(ev, "hubId")); e != nil {
				return nil, e
			}
			decl, e := s.registry(ctx, tx, &a, txt(ev, "hubId"))
			if e != nil {
				return nil, e
			}
			if decl.Declaration["endpoint"] != s.Endpoint {
				return nil, fault.New("peering_local_endpoint_mismatch", 409)
			}
			ag := obj(ev["agreement"])
			var local, remote Object
			for _, raw := range arr(ag["parties"]) {
				party := obj(raw)
				if party["endpoint"] == s.Endpoint {
					local = party
				} else {
					remote = party
				}
			}
			if local["hubId"] != ev["hubId"] || local["operatorId"] != a.SubjectID || remote == nil {
				return nil, fault.New("peering_party_mismatch", 409)
			}
			for _, raw := range arr(ag["parties"]) {
				party := obj(raw)
				if !publicParty(party) {
					return nil, fault.New("invalid_public_url", 400)
				}
				seen := map[string]bool{}
				for _, raw := range arr(party["keys"]) {
					pin := obj(raw)
					kid := txt(pin, "kid")
					if seen[kid] {
						return nil, fault.New("peering_duplicate_key", 400)
					}
					seen[kid] = true
					if num(pin, "notBefore") > s.now() || num(pin, "notAfter") < num(ag, "expiresAt") {
						return nil, fault.New("peering_pin_time_mismatch", 400)
					}
				}
			}
			pins := map[string]deviceauth.Pin{}
			if p.Pins != nil {
				pins = p.Pins()
			}
			for _, raw := range arr(local["keys"]) {
				pin := obj(raw)
				current, ok := pins[txt(pin, "kid")]
				if !ok || current.Revoked || current.PublicKeyPEM != pin["publicKeyPem"] || current.NotBefore > num(pin, "notBefore") || current.NotAfter < num(pin, "notAfter") {
					return nil, fault.New("peering_local_key_mismatch", 409)
				}
			}
			if num(ag, "expiresAt") <= s.now() || num(ag, "expiresAt") > grant.ExpiresAt || num(ag, "version") != num(ev, "expectedVersion")+1 {
				return nil, fault.New("peering_expiry_or_version", 400)
			}
			previous, e := one(ctx, tx, "SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 FOR UPDATE", ag["id"])
			if e != nil {
				return nil, e
			}
			if previous == nil && num(ev, "expectedVersion") != 0 || previous != nil && (previous["hub_id"] != ev["hubId"] || previous["subject_id"] != a.SubjectID || num(previous, "version") != num(ev, "expectedVersion")) {
				return nil, fault.New("peering_version_conflict", 409)
			}
			row, e := p.append(ctx, tx, a, ev, input, auth, requestID)
			if e != nil {
				return nil, e
			}
			raw, e := wireEncode(ev["agreement"])
			if e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, `INSERT INTO hub_peering_agreements_v2(id,hub_id,subject_id,version,agreement_hash,state,event_id,expires_at) VALUES($1,$2,$3,$4,$5,'local-approved',$6,$7) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,agreement_hash=EXCLUDED.agreement_hash,state='local-approved',event_id=EXCLUDED.event_id,expires_at=EXCLUDED.expires_at`, ag["id"], ev["hubId"], a.SubjectID, ag["version"], identity.Digest(raw), ev["id"], ag["expiresAt"])
			if e != nil {
				return nil, e
			}
			return peerReceipt(row), nil
		case "peer-exit":
			previous, e := one(ctx, tx, "SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2 FOR UPDATE", ev["agreementId"], ev["hubId"])
			if e != nil {
				return nil, e
			}
			if previous == nil || previous["subject_id"] != a.SubjectID || num(previous, "version") != num(ev, "expectedVersion") {
				return nil, fault.New("peering_operator_or_version", 409)
			}
			row, e := p.append(ctx, tx, a, ev, input, auth, requestID)
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE hub_peering_agreements_v2 SET state='exited' WHERE id=$1", ev["agreementId"]); e != nil {
				return nil, e
			}
			return peerReceipt(row), nil
		case "source-revoke":
			source, e := one(ctx, tx, "SELECT * FROM hub_peering_grants_v2 WHERE id=$1 AND hub_id=$2 AND subject_id=$3 FOR UPDATE", ev["grantId"], ev["hubId"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if source == nil {
				return nil, peerMissing()
			}
			row, e := p.append(ctx, tx, a, ev, input, auth, requestID)
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE hub_peering_grants_v2 SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1", source["id"], s.now()); e != nil {
				return nil, e
			}
			if e = p.change(ctx, tx, source, "unavailable"); e != nil {
				return nil, e
			}
			return peerReceipt(row), nil
		}
		if _, e = s.RequireMemberWithin(ctx, tx, a, txt(ev, "hubId"), "approved-proof-query"); e != nil {
			return nil, e
		}
		ag, e := p.agreement(ctx, tx, txt(ev, "agreementId"), txt(ev, "hubId"))
		if e != nil {
			return nil, e
		}
		source := obj(ev["source"])
		if num(ev, "agreementVersion") != num(ag.row, "version") || !has(arr(ag.agreement.Values()["sourceKinds"]), source["kind"]) || num(ev, "expiresAt") <= s.now() || num(ev, "expiresAt") > min(grant.ExpiresAt, num(ag.row, "expires_at")) {
			return nil, fault.New("peering_grant_scope_mismatch", 409)
		}
		if _, e = p.source(ctx, tx, &a, source, a.SubjectID); e != nil {
			return nil, e
		}
		row, e := p.append(ctx, tx, a, ev, input, auth, requestID)
		if e != nil {
			return nil, e
		}
		requesters, _ := protocol.EncodeJS(ev["requesterIds"])
		if _, e = tx.Exec(ctx, "INSERT INTO hub_peering_grants_v2(id,hub_id,subject_id,agreement_id,agreement_version,requester_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", ev["id"], ev["hubId"], a.SubjectID, ev["agreementId"], ev["agreementVersion"], string(requesters), ev["expiresAt"]); e != nil {
			return nil, e
		}
		if e = p.change(ctx, tx, Object{"id": ev["id"], "agreement_id": ev["agreementId"], "subject_id": a.SubjectID, "last_state": "uninspected"}, "permitted"); e != nil {
			return nil, e
		}
		return peerReceipt(row), nil
	})
}
