package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) liveProbe(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, request Object) error {
	return s.liveProbeMode(ctx, tx, a, b, request, false)
}
func (s *Service) liveProbeMode(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, request Object, worker bool) error {
	decl := event(b.declaration)
	payload := event(request)
	current := obj(decl["declaration"])
	var control, lastRequest Object
	for _, row := range b.rows {
		v := event(row)
		if row["kind"] == "node-control" && v["declarationId"] == b.declaration["id"] {
			control = row
		}
		if row["kind"] == "probe-request" && v["declarationId"] == b.declaration["id"] {
			lastRequest = row
		}
	}
	unavailable := fault.New("builder_probe_source_unavailable", 404)
	if current["type"] != "worker" || current["a2a"] == nil || payload["declarationId"] != b.declaration["id"] || payload["declarationHash"] != b.declaration["payload_hash"] || payload["nodeId"] != current["nodeId"] || request["subject_id"] != current["nodeId"] || control == nil || control["id"] != payload["controlId"] || lastRequest["id"] != request["id"] {
		return unavailable
	}
	if num(event(control), "expiresAt") <= s.now() {
		return unavailable
	}
	for _, row := range b.rows {
		if row["kind"] == "node-control-revoke" && event(row)["controlId"] == control["id"] {
			return unavailable
		}
	}
	state := maintenance(b.rows)
	if state["delisted"] == true || state["securityIssue"] == true {
		return unavailable
	}
	for _, row := range []Object{b.declaration, control, request} {
		var g deviceauth.ConsentIntent
		var e error
		if worker {
			if s.Devices == nil {
				return fault.New("builder_service_unavailable", 503)
			}
			g, e = s.Devices.RequireWorkerConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: txt(row, "consent_id"), SubjectID: txt(row, "subject_id"), Action: "builder.publish", ObjectID: txt(row, "id"), Recipient: s.Endpoint, PayloadJSON: txt(row, "payload_text")})
		} else {
			g, e = s.grant(ctx, tx, row, false)
		}
		if e != nil {
			return e
		}
		if !worker && !s.visible(g, a) {
			return unavailable
		}
	}
	return nil
}
func (s *Service) reachability(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, current Object, heartbeat Object) (Object, error) {
	base := clone(heartbeat)
	base["scope"] = "owner-heartbeat-only"
	if current["a2a"] != nil {
		base["scope"] = "selected-a2a-interface"
	}
	base["endpointControlVerified"] = false
	var request Object
	for _, row := range b.rows {
		if row["kind"] == "probe-request" && event(row)["declarationId"] == b.declaration["id"] {
			request = row
		}
	}
	if request == nil {
		return base, nil
	}
	if e := s.liveProbe(ctx, tx, a, b, request); e != nil {
		if !domainError(e) {
			return nil, e
		}
		base["state"] = "unavailable"
		base["endpointProbed"] = false
		base["endpointReachable"] = nil
		base["reason"] = "probe-source-unavailable"
		return base, nil
	}
	job, e := one(ctx, tx, "SELECT state,attempts,available_at FROM jobs WHERE kind='builder-probe' AND deduplication_key=$1", "builder-probe:"+txt(request, "id"))
	if e != nil {
		return nil, e
	}
	row, e := one(ctx, tx, "SELECT observation::text AS observation FROM builder_probes WHERE request_id=$1 ORDER BY attempt DESC LIMIT 1", request["id"])
	if e != nil {
		return nil, e
	}
	var observation any
	if row != nil {
		observation, e = protocol.DecodeOrdered([]byte(txt(row, "observation")))
		if e != nil {
			return nil, e
		}
	}
	state := "pending"
	if observation != nil {
		v := obj(observation)
		state = txt(v, "status")
		if num(v, "validUntil") <= s.now() {
			state = "expired"
		}
	} else if job["state"] == "failed" {
		state = "unavailable"
	}
	base["state"] = state
	base["requestId"] = request["id"]
	base["endpoint"] = obj(current["a2a"])["endpoint"]
	base["cardUrl"] = obj(current["a2a"])["cardUrl"]
	if observation != nil {
		v := obj(observation)
		base["observation"] = observation
		base["endpointProbed"] = v["stage"] == "rpc"
		base["endpointReachable"] = v["endpointReachable"]
		if state == "expired" || v["status"] == "revoked" {
			base["endpointReachable"] = nil
		}
	}
	if job != nil {
		at, _ := job["available_at"].(time.Time)
		base["job"] = ordered("state", job["state"], "attempts", job["attempts"], "nextAttemptAt", at.Unix())
	}
	return base, nil
}
