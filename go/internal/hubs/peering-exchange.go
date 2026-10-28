package hubs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

func (p *Peering) verify(ctx context.Context, token, kind, endpoint string, pins map[string]deviceauth.Pin, at, age int64) (PeerEnvelope, error) {
	if p.Verify != nil {
		return p.Verify(ctx, token, kind, endpoint, pins, at, age)
	}
	v, e := deviceauth.VerifyPeerEnvelope(ctx, token, kind, endpoint, pins, at, age)
	return PeerEnvelope{v.Data, v.ID, v.IssuedAt, v.ExpiresAt}, e
}
func (p *Peering) sign(ctx context.Context, data any, id string, ttl int64) (string, error) {
	if p.Sign == nil {
		return "", fault.New("peering_signer_unavailable", 503)
	}
	raw, e := wireEncode(data)
	if e != nil {
		return "", e
	}
	return p.Sign(ctx, "hub-peering", json.RawMessage(raw), id, ttl)
}
func (p *Peering) saveReceipt(ctx context.Context, tx pgx.Tx, q Object, side, hash string) error {
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", "galaxy-peering-query/"+side, q["queryId"]); e != nil {
		return e
	}
	prior, e := one(ctx, tx, "SELECT * FROM hub_peering_receipts_v2 WHERE query_id=$1 AND side=$2 FOR UPDATE", q["queryId"], side)
	if e != nil {
		return e
	}
	if prior != nil {
		if prior["request_hash"] != hash || prior["subject_id"] != q["requesterId"] || prior["agreement_id"] != q["agreementId"] {
			return fault.New("peering_query_conflict", 409)
		}
		return nil
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", "galaxy-peering-quota/"+side, q["agreementId"]); e != nil {
		return e
	}
	count, e := one(ctx, tx, "SELECT count(*)::int AS n FROM hub_peering_receipts_v2 WHERE agreement_id=$1 AND side=$2 AND created_at>$3", q["agreementId"], side, p.Hubs.now()-60)
	if e != nil {
		return e
	}
	ag, e := one(ctx, tx, "SELECT event_id FROM hub_peering_agreements_v2 WHERE id=$1", q["agreementId"])
	if e != nil {
		return e
	}
	ev, e := one(ctx, tx, "SELECT payload_text FROM hub_peering_events_v2 WHERE id=$1", ag["event_id"])
	if e != nil {
		return e
	}
	if num(count, "n") >= num(obj(event(ev)["agreement"]), "ratePerMinute") {
		return fault.New("peering_rate_limited", 429)
	}
	_, e = tx.Exec(ctx, "INSERT INTO hub_peering_receipts_v2(query_id,side,agreement_id,subject_id,request_hash,state,created_at,checked_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$6)", q["queryId"], side, q["agreementId"], q["requesterId"], hash, p.Hubs.now())
	return e
}
func (p *Peering) Exchange(ctx context.Context, input Object) (Object, error) {
	if e := p.ready(); e != nil {
		return nil, e
	}
	token, ok := input["signed"].(string)
	if !ok || len(input) != 1 || len(token) > 65536 {
		return nil, fault.New("invalid_peering_envelope", 400)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, peerMissing()
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return nil, peerMissing()
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(raw, &claims) != nil {
		return nil, peerMissing()
	}
	parsed, e := parsedWire("peerExchangeRequestSchema", claims["data"])
	if e != nil {
		return nil, peerMissing()
	}
	q := parsed.Values()
	qJSON, e := wireEncode(parsed)
	if e != nil {
		return nil, e
	}
	s := p.Hubs
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		ag, e := p.agreement(ctx, tx, txt(q, "agreementId"), txt(q, "toHubId"))
		if e != nil {
			return nil, e
		}
		checked, e := p.verify(ctx, token, "hub-peering", txt(ag.remote, "endpoint"), remotePins(ag.remote), s.now(), num(ag.agreement.Values(), "responseMaxAgeSeconds"))
		if e != nil {
			return nil, peerMissing()
		}
		if checked.ID != q["queryId"] || q["origin"] != ag.remote["endpoint"] || q["destination"] != s.Endpoint || q["fromHubId"] != ag.remote["hubId"] || q["agreementHash"] != ag.row["agreement_hash"] {
			return nil, fault.New("peering_scope_changed", 409)
		}
		hash := identity.Digest(qJSON)
		if e = p.saveReceipt(ctx, tx, q, "incoming", hash); e != nil {
			return nil, e
		}
		requesterJSON, _ := protocol.Encode([]any{q["requesterId"]})
		agValues := ag.agreement.Values()
		changes, e := query(ctx, tx, `SELECT max(c.sequence)::bigint AS sequence,g.* FROM hub_peering_changes_v2 c JOIN hub_peering_grants_v2 g ON g.id=c.grant_id WHERE c.agreement_id=$1 AND g.requester_ids @> $2::jsonb GROUP BY g.id HAVING max(c.sequence)>$3 ORDER BY max(c.sequence) LIMIT $4`, q["agreementId"], string(requesterJSON), q["after"], num(agValues, "pageSize")+1)
		if e != nil {
			return nil, e
		}
		selected := []Object{}
		items := []any{}
		deferred := []any{}
		size := 0
		appendItem := func(v *protocol.OrderedObject) (bool, error) {
			raw, e := wireEncode(v)
			if e != nil {
				return false, e
			}
			if size+len(raw) > 38000 {
				return false, nil
			}
			items = append(items, v)
			size += len(raw)
			return true, nil
		}
		for i, row := range changes {
			if int64(i) >= num(agValues, "pageSize") {
				break
			}
			v, e := p.grantProjection(ctx, tx, row, txt(q, "requesterId"), ag)
			if e != nil {
				return nil, e
			}
			ok, e := appendItem(v)
			if e != nil {
				return nil, e
			}
			if !ok {
				break
			}
			selected = append(selected, row)
		}
		for _, id := range arr(q["recheck"]) {
			already := false
			for _, row := range selected {
				already = already || row["id"] == id
			}
			if already {
				continue
			}
			row, e := one(ctx, tx, "SELECT * FROM hub_peering_grants_v2 WHERE id=$1 AND agreement_id=$2 AND requester_ids @> $3::jsonb", id, q["agreementId"], string(requesterJSON))
			if e != nil {
				return nil, e
			}
			item := ordered("grantId", id, "state", "unavailable")
			if row != nil {
				item, e = p.grantProjection(ctx, tx, row, txt(q, "requesterId"), ag)
				if e != nil {
					return nil, e
				}
			}
			ok, e := appendItem(item)
			if e != nil {
				return nil, e
			}
			if !ok {
				deferred = append(deferred, id)
			}
		}
		checkedAt := s.now()
		expiry := min(checkedAt+num(agValues, "responseMaxAgeSeconds"), num(ag.row, "expires_at"))
		for _, item := range items {
			if obj(item)["state"] == "current" {
				expiry = min(expiry, num(obj(item), "expiresAt"))
			}
		}
		if expiry <= checkedAt {
			return nil, fault.New("peering_response_expired", 409)
		}
		next := q["after"]
		if len(selected) > 0 {
			next = selected[len(selected)-1]["sequence"]
		}
		data := peerFlags(ordered("profile", "galaxy-direct-proof/1", "kind", "response", "queryId", q["queryId"], "requestHash", hash, "agreementId", q["agreementId"], "agreementHash", q["agreementHash"], "origin", s.Endpoint, "destination", q["origin"], "fromHubId", q["toHubId"], "toHubId", q["fromHubId"], "requesterId", q["requesterId"], "purpose", q["purpose"], "items", items, "nextCursor", next, "hasMore", len(changes) > len(selected), "deferredRecheck", deferred, "checkedAt", checkedAt, "expiresAt", expiry, "coverage", "explicit-source-grants-for-exact-peer-and-reader"))
		signed, e := p.sign(ctx, data, txt(q, "queryId"), expiry-s.now())
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE hub_peering_receipts_v2 SET state='delivered',response_hash=$3,checked_at=$4 WHERE query_id=$1 AND side=$2", q["queryId"], "incoming", identity.Digest([]byte(signed)), s.now()); e != nil {
			return nil, e
		}
		return Object{"signed": signed}, nil
	})
}

func wirePlain(v any) any {
	if o, ok := v.(*protocol.OrderedObject); ok {
		out := Object{}
		for k, x := range o.Values() {
			out[k] = wirePlain(x)
		}
		return out
	}
	if o := obj(v); o != nil {
		out := Object{}
		for k, x := range o {
			out[k] = wirePlain(x)
		}
		return out
	}
	if list, ok := v.([]any); ok {
		out := []any{}
		for _, x := range list {
			out = append(out, wirePlain(x))
		}
		return out
	}
	return v
}

func (p *Peering) Query(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	if e := p.ready(); e != nil {
		return nil, e
	}
	in, e := parse("peeringQuerySchema", raw)
	if e != nil {
		return nil, fault.New("invalid_peering_request", 400)
	}
	s := p.Hubs
	var ag peerAgreement
	var q *protocol.OrderedObject
	_, e = s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if _, e := s.RequireMemberWithin(ctx, tx, a, txt(in, "hubId"), "approved-proof-query"); e != nil {
			return nil, e
		}
		var e error
		ag, e = p.agreement(ctx, tx, txt(in, "agreementId"), txt(in, "hubId"))
		if e != nil {
			return nil, e
		}
		q = ordered("profile", "galaxy-direct-proof/1", "kind", "query", "queryId", in["queryId"], "agreementId", in["agreementId"], "agreementHash", ag.row["agreement_hash"], "fromHubId", in["hubId"], "toHubId", ag.remote["hubId"], "requesterId", a.SubjectID, "origin", s.Endpoint, "destination", ag.remote["endpoint"], "purpose", "help-discovery", "after", in["after"], "recheck", in["recheck"])
		wire, e := wireEncode(q)
		if e != nil {
			return nil, e
		}
		return nil, p.saveReceipt(ctx, tx, q.Values(), "outgoing", identity.Digest(wire))
	})
	if e != nil {
		return nil, e
	}
	if p.Sign == nil {
		return nil, fault.New("peering_transport_unavailable", 503)
	}
	run := func() (Object, error) {
		signed, e := p.sign(ctx, q, txt(in, "queryId"), min(num(ag.agreement.Values(), "responseMaxAgeSeconds"), num(ag.row, "expires_at")-s.now()))
		if e != nil {
			return nil, e
		}
		body, e := wireEncode(ordered("signed", signed))
		if e != nil {
			return nil, e
		}
		var reply []byte
		if p.Send != nil {
			reply, e = p.Send(ctx, txt(ag.remote, "endpoint")+"/v2/hubs/peering/exchange", body, 5*time.Second, 65536)
		} else {
			reply, e = publicfetch.PostHubPeering(ctx, txt(ag.remote, "endpoint")+"/v2/hubs/peering/exchange", body, 65536, 5*time.Second)
		}
		if e != nil {
			return nil, e
		}
		var response Object
		if protocol.Decode(reply, &response) != nil {
			return nil, errors.New("invalid peering response")
		}
		checked, e := p.verify(ctx, txt(response, "signed"), "hub-peering", txt(ag.remote, "endpoint"), remotePins(ag.remote), s.now(), num(ag.agreement.Values(), "responseMaxAgeSeconds"))
		if e != nil {
			return nil, errors.New("unverified peering response")
		}
		decoded, e := wireDecode(checked.Data)
		if e != nil {
			return nil, e
		}
		v := obj(decoded)
		qv := q.Values()
		requestJSON, _ := wireEncode(q)
		if v["profile"] != "galaxy-direct-proof/1" || v["kind"] != "response" || checked.ID != qv["queryId"] || v["queryId"] != qv["queryId"] || v["requestHash"] != identity.Digest(requestJSON) || v["agreementId"] != qv["agreementId"] || v["agreementHash"] != qv["agreementHash"] || v["origin"] != qv["destination"] || v["destination"] != qv["origin"] || v["fromHubId"] != qv["toHubId"] || v["toHubId"] != qv["fromHubId"] || v["requesterId"] != a.SubjectID || v["purpose"] != qv["purpose"] || num(v, "expiresAt") <= s.now() || v["rawContextIncluded"] != false || v["route"] != "direct" || v["intermediaries"] == nil || len(arr(v["intermediaries"])) != 0 {
			return nil, fault.New("peering_response_mismatch", 409)
		}
		clean, e := p.validateResponse(ctx, checked.Data, ag)
		if e != nil {
			return nil, e
		}
		clean.Set("expiresAt", min(num(clean.Values(), "expiresAt"), checked.ExpiresAt))
		return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
			if _, e := s.RequireMemberWithin(ctx, tx, a, txt(in, "hubId"), "approved-proof-query"); e != nil {
				return nil, e
			}
			current, e := p.agreement(ctx, tx, txt(in, "agreementId"), txt(in, "hubId"))
			if e != nil {
				return nil, e
			}
			if current.row["agreement_hash"] != qv["agreementHash"] {
				return nil, fault.New("peering_scope_changed", 409)
			}
			if num(clean.Values(), "expiresAt") <= s.now() {
				return nil, fault.New("peering_response_expired", 409)
			}
			if _, e = tx.Exec(ctx, "UPDATE hub_peering_receipts_v2 SET state='delivered',response_hash=$3,checked_at=$4 WHERE query_id=$1 AND side=$2", qv["queryId"], "outgoing", identity.Digest([]byte(txt(response, "signed"))), s.now()); e != nil {
				return nil, e
			}
			out := obj(wirePlain(clean))
			out["remoteApproval"] = "verified-for-this-current-query"
			out["peerAuthentication"] = "selected-peer-operator-attestation-within-explicit-read-scope"
			return peerFlag(out), nil
		})
	}
	out, e := run()
	if e == nil {
		return out, nil
	}
	reconcile, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, saveErr := s.Pool.Exec(reconcile, "UPDATE hub_peering_receipts_v2 SET state='unknown',response_hash=NULL,checked_at=$3 WHERE query_id=$1 AND side=$2", in["queryId"], "outgoing", s.now()); saveErr != nil {
		return nil, saveErr
	}
	if domain(e) && has([]any{401, 403, 409}, fault.Status(e)) {
		return nil, e
	}
	return peerFlag(Object{"queryId": in["queryId"], "state": "unknown", "currentSourceStatus": "unknown", "items": []any{}, "retryAfterReconciliation": true}), nil
}
