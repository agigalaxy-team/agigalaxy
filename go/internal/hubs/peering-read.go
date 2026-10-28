package hubs

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (p *Peering) run(ctx context.Context, a deviceauth.Actor, name string, raw []byte, fn func(pgx.Tx, Object) (Object, error)) (Object, error) {
	if e := p.ready(); e != nil {
		return nil, e
	}
	in, e := parse(name, raw)
	if e != nil {
		return nil, fault.New("invalid_peering_request", 400)
	}
	return p.Hubs.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) { return fn(tx, in) })
}
func (p *Peering) Read(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "peeringReadSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		h, e := p.Hubs.head(ctx, tx, txt(in, "hubId"), false)
		if e != nil {
			return nil, e
		}
		if a.SubjectID != h["owner_id"] {
			return nil, fault.New("hub_operator_required", 403)
		}
		ag, e := one(ctx, tx, "SELECT * FROM hub_peering_agreements_v2 WHERE id=$1 AND hub_id=$2", in["agreementId"], in["hubId"])
		if e != nil {
			return nil, e
		}
		if ag == nil {
			return nil, peerMissing()
		}
		ev, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1", ag["event_id"])
		if e != nil {
			return nil, e
		}
		var record any
		if _, e = p.Hubs.grant(ctx, tx, ev); e != nil {
			if !peerUnavailable(e) {
				return nil, e
			}
		} else {
			record = event(ev)["agreement"]
		}
		return peerFlag(Object{"agreementId": ag["id"], "hubId": ag["hub_id"], "version": ag["version"], "agreementHash": ag["agreement_hash"], "state": ag["state"], "agreement": record, "remoteApproval": "not-established-by-local-record"}), nil
	})
}
func (p *Peering) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "hubReceiptSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		row, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1 AND subject_id=$2", in["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return Object{"operationId": in["operationId"], "state": "absent"}, nil
		}
		if row["payload_hash"] != in["payloadHash"] {
			return nil, fault.New("peering_receipt_conflict", 409)
		}
		return peerReceipt(row), nil
	})
}
func (p *Peering) List(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "peeringListSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		table := "hub_peering_grants_v2"
		agreements := in["kind"] == "agreements"
		if agreements {
			table = "hub_peering_agreements_v2"
		}
		limit := num(in, "limit")
		rows, e := query(ctx, tx, "SELECT * FROM "+table+" WHERE hub_id=$1 AND subject_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", in["hubId"], a.SubjectID, in["after"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, row := range rows {
			if int64(i) >= limit {
				break
			}
			id := row["id"]
			if agreements {
				id = row["event_id"]
			}
			ev, e := one(ctx, tx, "SELECT * FROM hub_peering_events_v2 WHERE id=$1", id)
			if e != nil {
				return nil, e
			}
			var record any
			if _, e = p.Hubs.grant(ctx, tx, ev); e != nil {
				if !peerUnavailable(e) {
					return nil, e
				}
			} else {
				record = event(ev)
			}
			version := row["version"]
			if version == nil {
				version = row["agreement_version"]
			}
			state := row["state"]
			if state == nil {
				state = "granted"
				if num(row, "revoked_at") != 0 {
					state = "revoked"
				}
			}
			actions := []any{}
			if agreements {
				if row["state"] != "exited" {
					actions = append(actions, "peer-exit")
				}
			} else if num(row, "revoked_at") == 0 {
				actions = append(actions, "source-revoke")
			}
			items = append(items, Object{"id": row["id"], "version": version, "state": state, "expiresAt": row["expires_at"], "record": record, "recordHash": ev["payload_hash"], "currentSourceStatus": "requires-current-query", "availableActions": actions})
		}
		return peerFlag(Object{"items": items, "nextCursor": cursor(rows, limit)}), nil
	})
}
func (p *Peering) Connections(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "peeringConnectionsSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		if _, e := p.Hubs.RequireMemberWithin(ctx, tx, a, txt(in, "hubId"), "approved-proof-query"); e != nil {
			return nil, e
		}
		limit := num(in, "limit")
		rows, e := query(ctx, tx, "SELECT id FROM hub_peering_agreements_v2 WHERE hub_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3", in["hubId"], in["after"], limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for i, row := range rows {
			if int64(i) >= limit {
				break
			}
			ag, e := p.agreement(ctx, tx, txt(row, "id"), txt(in, "hubId"))
			if e != nil {
				if !peerUnavailable(e) {
					return nil, e
				}
				continue
			}
			items = append(items, Object{"agreementId": ag.row["id"], "version": ag.row["version"], "agreementHash": ag.row["agreement_hash"], "peer": ag.remote["endpoint"], "sourceKinds": ag.agreement.Values()["sourceKinds"], "expiresAt": ag.row["expires_at"], "remoteApproval": "requires-current-query"})
		}
		return peerFlag(Object{"items": items, "nextCursor": cursor(rows, limit)}), nil
	})
}
func (p *Peering) Preview(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "peeringPreviewSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		if _, e := p.Hubs.RequireMemberWithin(ctx, tx, a, txt(in, "hubId"), "approved-proof-query"); e != nil {
			return nil, e
		}
		ag, e := p.agreement(ctx, tx, txt(in, "agreementId"), txt(in, "hubId"))
		if e != nil {
			return nil, e
		}
		source := obj(in["source"])
		if !has(arr(ag.agreement.Values()["sourceKinds"]), source["kind"]) {
			return nil, fault.New("peering_kind_not_agreed", 409)
		}
		view, e := p.source(ctx, tx, &a, source, a.SubjectID)
		if e != nil {
			return nil, e
		}
		return peerFlag(Object{"source": in["source"], "projection": view, "agreementVersion": ag.row["version"], "peer": ag.remote["endpoint"], "maxExpiresAt": ag.row["expires_at"], "published": false}), nil
	})
}
func (p *Peering) Sources(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	return p.run(ctx, a, "peeringSourcesSchema", raw, func(tx pgx.Tx, in Object) (Object, error) {
		if _, e := p.Hubs.RequireMemberWithin(ctx, tx, a, txt(in, "hubId"), "approved-proof-query"); e != nil {
			return nil, e
		}
		table, filter := "ci_proofs_v2", "TRUE"
		args := []any{a.SubjectID, in["after"], num(in, "limit") + 1}
		if in["kind"] != "ci-proof-v2" {
			table = "case_events"
			filter = "case_id=$4"
			if in["kind"] == "task-event" {
				table = "task_events"
				filter = "task_id=$4"
			}
			args = append(args, in["parentId"])
		}
		rows, e := query(ctx, tx, "SELECT * FROM "+table+" WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) AND "+filter+" ORDER BY id LIMIT $3", args...)
		if e != nil {
			return nil, e
		}
		items := []any{}
		limit := num(in, "limit")
		for i, row := range rows {
			if int64(i) >= limit {
				break
			}
			source := Object{"kind": "ci-proof-v2", "id": row["id"], "payloadHash": row["payload_hash"]}
			if in["kind"] != "ci-proof-v2" {
				source = Object{"kind": "contribution-summary", "source": Object{"kind": in["kind"], "id": row["id"], "eventVersion": 1, "payloadHash": row["payload_hash"]}, "fields": []any{"eventType", "actorId"}}
			}
			view, e := p.source(ctx, tx, &a, source, a.SubjectID)
			if e != nil {
				if !peerUnavailable(e) {
					return nil, e
				}
				continue
			}
			eventType := obj(view.Values()["projection"])["eventType"]
			if eventType == nil {
				eventType = "ci-observation-proof"
			}
			items = append(items, Object{"source": source, "eventType": eventType, "synthetic": view.Values()["synthetic"]})
		}
		return peerFlag(Object{"items": items, "nextCursor": cursor(rows, limit), "sourceTextIncluded": false}), nil
	})
}
