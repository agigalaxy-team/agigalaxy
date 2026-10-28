package hubs

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

type PeerEnvelope struct {
	Data                json.RawMessage
	ID                  string
	IssuedAt, ExpiresAt int64
}
type Peering struct {
	Hubs     *Service
	CI       *civ2.Service
	Sharing  *contributions.Service
	Sign     func(context.Context, string, any, string, int64) (string, error)
	Verify   func(context.Context, string, string, string, map[string]deviceauth.Pin, int64, int64) (PeerEnvelope, error)
	Pins     func() map[string]deviceauth.Pin
	PinOrder []string
	Send     func(context.Context, string, []byte, time.Duration, int) ([]byte, error)
}
type peerAgreement struct {
	row, event          Object
	grant               deviceauth.ConsentIntent
	agreement           *protocol.OrderedObject
	local, remote, head Object
}

func init() {
	for action, method := range map[string]string{"events": "submit", "read": "read", "query": "query", "list": "list", "preview": "preview", "receipt": "receipt", "sources": "sources", "connections": "connections", "party": "party", "exchange": "exchange"} {
		routes["/v2/hubs/peering/"+action] = "peer-" + method
	}
}

func peerFlag(v Object) Object {
	v["route"] = "direct"
	v["intermediaries"] = []any{}
	v["officialProtocolFee"] = 0
	v["rawContextIncluded"] = false
	v["capabilityVerified"] = false
	v["independentSourcesAdded"] = 0
	v["autonomousDomainVerified"] = false
	v["responseBodyPersisted"] = false
	return v
}
func peerFlags(v *protocol.OrderedObject) *protocol.OrderedObject {
	for _, pair := range []struct {
		k string
		v any
	}{{"route", "direct"}, {"intermediaries", []any{}}, {"officialProtocolFee", 0}, {"rawContextIncluded", false}, {"capabilityVerified", false}, {"independentSourcesAdded", 0}, {"autonomousDomainVerified", false}, {"responseBodyPersisted", false}} {
		v.Set(pair.k, pair.v)
	}
	return v
}
func peerUnavailable(e error) bool {
	return domain(e) && has([]any{403, 404, 409, 410, 422}, fault.Status(e))
}
func peerMissing() error { return fault.New("peering_unavailable", 404) }
func (p *Peering) ready() error {
	if p == nil || p.Hubs == nil || p.Hubs.Pool == nil {
		return fault.New("peering_unavailable", 503)
	}
	return nil
}
func (p *Peering) agreement(ctx context.Context, tx pgx.Tx, id, hubID string) (peerAgreement, error) {
	empty := peerAgreement{}
	row, e := one(ctx, tx, "SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2 FOR SHARE", id, hubID)
	if e != nil {
		return empty, e
	}
	s := p.Hubs
	if row == nil || row["state"] != "local-approved" || num(row, "expires_at") <= s.now() {
		return empty, peerMissing()
	}
	ev, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1", row["event_id"])
	if e != nil {
		return empty, e
	}
	grant, e := s.grant(ctx, tx, ev)
	if e != nil {
		return empty, e
	}
	decoded, e := wireDecode([]byte(txt(ev, "payload_text")))
	if e != nil {
		return empty, e
	}
	ag, _ := obj(decoded)["agreement"].(*protocol.OrderedObject)
	raw, e := wireEncode(ag)
	if e != nil {
		return empty, e
	}
	if identity.Digest(raw) != row["agreement_hash"] {
		return empty, fault.New("peering_integrity_mismatch", 500)
	}
	var local, remote Object
	for _, party := range arr(ag.Values()["parties"]) {
		v := obj(party)
		if v["endpoint"] == s.Endpoint {
			local = v
		} else {
			remote = v
		}
	}
	if local["hubId"] != hubID || local["operatorId"] != row["subject_id"] || remote == nil {
		return empty, fault.New("peering_party_mismatch", 409)
	}
	head, e := s.head(ctx, tx, hubID, false)
	if e != nil {
		return empty, e
	}
	if head["owner_id"] != row["subject_id"] || head["state"] != "active" {
		return empty, peerMissing()
	}
	c, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE hub_id=$1 AND kind='charter' AND charter_version=$2", hubID, head["version"])
	if e != nil {
		return empty, e
	}
	if _, e = s.grant(ctx, tx, c); e != nil {
		return empty, e
	}
	if s.Builders == nil {
		return empty, fault.New("hub_builder_unavailable", 503)
	}
	b, e := s.Builders.RegistryAttestationWithin(ctx, tx, hubID)
	if e != nil {
		return empty, e
	}
	if b.DeclarationEvent["id"] != event(c)["declarationId"] || b.DeclarationEvent["payload_hash"] != event(c)["declarationHash"] {
		return empty, fault.New("peering_charter_changed", 409)
	}
	if b.Maintenance["delisted"] == true || b.Maintenance["securityIssue"] == true {
		return empty, peerMissing()
	}
	return peerAgreement{row, ev, grant, ag, local, remote, head}, nil
}
func peerReceipt(row Object) Object {
	return peerFlag(Object{"operationId": row["id"], "hubId": row["hub_id"], "objectId": row["object_id"], "kind": row["kind"], "payloadHash": row["payload_hash"], "state": "recorded"})
}
func (p *Peering) append(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ev Object, input Object, auth deviceauth.ControlAuthorization, requestID string) (Object, error) {
	objectID := ev["agreementId"]
	if agreement := obj(ev["agreement"]); agreement != nil {
		objectID = agreement["id"]
	}
	if objectID == nil {
		objectID = ev["grantId"]
	}
	row := Object{"id": ev["id"], "hub_id": ev["hubId"], "subject_id": a.SubjectID, "kind": ev["kind"], "object_id": objectID, "consent_id": input["consentId"], "payload_text": input["payloadJson"], "payload_hash": identity.Digest([]byte(txt(input, "payloadJson"))), "received_at": p.Hubs.now()}
	_, e := tx.Exec(ctx, "INSERT INTO hub_peering_events_v2(id,hub_id,subject_id,kind,object_id,consent_id,payload_text,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", row["id"], row["hub_id"], a.SubjectID, row["kind"], objectID, row["consent_id"], row["payload_text"], row["payload_hash"], row["received_at"])
	if e != nil {
		return nil, e
	}
	if e = p.Hubs.audit(ctx, tx, a, auth, row, requestID); e != nil {
		return nil, e
	}
	return row, nil
}
func (p *Peering) change(ctx context.Context, tx pgx.Tx, row Object, state string) error {
	if row["last_state"] == state {
		return nil
	}
	if _, e := tx.Exec(ctx, "UPDATE hub_peering_grants_v2 SET last_state=$2 WHERE id=$1", row["id"], state); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "INSERT INTO hub_peering_changes_v2(grant_id,agreement_id,subject_id,state,observed_at) VALUES($1,$2,$3,$4,$5)", row["id"], row["agreement_id"], row["subject_id"], state, p.Hubs.now())
	return e
}
func (p *Peering) publicationMembership(ctx context.Context, tx pgx.Tx, subject string, ag peerAgreement) error {
	if ag.head["owner_id"] == subject {
		return nil
	}
	m, e := one(ctx, tx, "SELECT * FROM hub_memberships_v2 WHERE hub_id=$1 AND subject_id=$2 AND state='active' FOR SHARE", ag.head["id"], subject)
	if e != nil {
		return e
	}
	if m == nil || num(m, "charter_version") != num(ag.head, "version") || num(m, "expires_at") <= p.Hubs.now() || !has(arr(m["scopes"]), "approved-proof-query") {
		return fault.New("peering_source_membership_inactive", 403)
	}
	for _, id := range []any{m["invite_id"], m["decision_id"]} {
		row, e := one(ctx, tx, "SELECT * FROM hub_events_v2 WHERE id=$1", id)
		if e != nil {
			return e
		}
		if _, e = p.Hubs.grant(ctx, tx, row); e != nil {
			return e
		}
	}
	return nil
}
func (p *Peering) Party(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	if e := p.ready(); e != nil {
		return nil, e
	}
	in, e := parse("peeringConnectionsSchema", raw)
	if e != nil {
		return nil, e
	}
	return p.Hubs.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		h, _, e := p.Hubs.current(ctx, tx, &a, txt(in, "hubId"))
		if e != nil {
			return nil, e
		}
		if h["owner_id"] != a.SubjectID {
			return nil, fault.New("hub_operator_required", 403)
		}
		pins := map[string]deviceauth.Pin{}
		if p.Pins != nil {
			pins = p.Pins()
		}
		order := append([]string{}, p.PinOrder...)
		present := map[string]bool{}
		for _, id := range order {
			present[id] = true
		}
		extra := []string{}
		for id := range pins {
			if !present[id] {
				extra = append(extra, id)
			}
		}
		sort.Strings(extra)
		order = append(order, extra...)
		selected := []string{}
		for _, id := range order {
			pin, ok := pins[id]
			if ok && !pin.Revoked && pin.NotBefore <= p.Hubs.now() && pin.NotAfter > p.Hubs.now() {
				selected = append(selected, id)
			}
		}
		sort.SliceStable(selected, func(i, j int) bool { return pins[selected[i]].NotBefore > pins[selected[j]].NotBefore })
		keys := []any{}
		for i, id := range selected {
			if i >= 3 {
				break
			}
			pin := pins[id]
			keys = append(keys, Object{"kid": id, "publicKeyPem": pin.PublicKeyPEM, "notBefore": pin.NotBefore, "notAfter": pin.NotAfter})
		}
		return peerFlag(Object{"party": Object{"endpoint": p.Hubs.Endpoint, "hubId": in["hubId"], "operatorId": a.SubjectID, "keys": keys}, "authority": "currently-configured-service-pins; remote operator must explicitly choose them"}), nil
	})
}
func remotePins(party Object) map[string]deviceauth.Pin {
	pins := map[string]deviceauth.Pin{}
	for _, raw := range arr(party["keys"]) {
		pin := obj(raw)
		pins[txt(pin, "kid")] = deviceauth.Pin{PublicKeyPEM: txt(pin, "publicKeyPem"), NotBefore: num(pin, "notBefore"), NotAfter: num(pin, "notAfter")}
	}
	return pins
}
func publicParty(v Object) bool {
	endpoint := txt(v, "endpoint")
	return publicfetch.ValidURL(endpoint)
}
