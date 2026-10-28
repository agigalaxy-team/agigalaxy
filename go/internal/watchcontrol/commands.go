package watchcontrol

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) Register(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "register")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		if _, e := s.scope(ctx, tx, a, Object{"room_id": p["roomId"], "task_id": p["taskId"]}, true); e != nil {
			return nil, e
		}
		replay, e := s.operation(ctx, tx, a, x, "register")
		if e != nil || replay != nil {
			return replay, e
		}
		if s.Agent == nil {
			return nil, fault.New("watch_agent_source_unavailable", 503)
		}
		grant, e := s.Agent(ctx, tx, &a, text(p, "roomId"), text(p, "agentGrantId"))
		if e != nil {
			return nil, e
		}
		if number(p, "expiresAt") <= s.now() || number(p, "expiresAt") > seconds(grant["expires_at"]) {
			return nil, fault.New("watch_exceeds_current_grant", 409)
		}
		saved, e := one(ctx, tx, `INSERT INTO watch_controls_v2(watch_id,subject_id,room_id,task_id,purpose,current_grant_id,current_binding_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING RETURNING *`, p["watchId"], a.SubjectID, p["roomId"], p["taskId"], p["purpose"], p["agentGrantId"], a.BindingID, time.Unix(number(p, "expiresAt"), 0), time.Unix(s.now(), 0))
		if e != nil {
			return nil, e
		}
		if saved == nil {
			return nil, fault.New("watch_control_already_registered", 409)
		}
		if _, e = tx.Exec(ctx, `UPDATE chat_agent_grants SET expires_at=LEAST(expires_at,$2) WHERE grant_id=$1`, p["agentGrantId"], time.Unix(number(p, "expiresAt"), 0)); e != nil {
			return nil, e
		}
		return s.record(ctx, tx, a, x, "register", Object{"revision": int64(1), "agentGrantId": p["agentGrantId"], "bindingId": a.BindingID, "metadataSyncOptedIn": true})
	})
}
func (s *Service) Takeover(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "takeover")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		initial, e := s.own(ctx, tx, a, text(p, "watchId"))
		if e != nil {
			return nil, e
		}
		if _, e = s.scope(ctx, tx, a, initial, true); e != nil {
			return nil, e
		}
		replay, e := s.operation(ctx, tx, a, x, "takeover")
		if e != nil || replay != nil {
			return replay, e
		}
		w, e := one(ctx, tx, `SELECT * FROM watch_controls_v2 WHERE watch_id=$1 FOR UPDATE`, p["watchId"])
		if e != nil {
			return nil, e
		}
		if number(w, "revision") != number(p, "expectedRevision") || w["current_grant_id"] != p["expectedGrantId"] {
			return nil, fault.New("watch_control_revision_conflict", 409)
		}
		if w["state"] != "active" || seconds(w["expires_at"]) <= s.now() {
			return nil, fault.New("watch_control_inactive", 409)
		}
		if p["targetBindingId"] != a.BindingID || p["targetBindingId"] == w["current_binding_id"] || p["newGrantId"] == w["current_grant_id"] {
			return nil, fault.New("watch_target_device_required", 409)
		}
		target, e := s.Devices.BindingControlWithin(ctx, tx, text(p, "targetBindingId"), a.SubjectID, "binding")
		if e != nil {
			return nil, e
		}
		if target == nil || target["revoked_at"] != nil || !contains(scopes(target["scopes"]), "binding") || seconds(target["expires_at"]) <= s.now() {
			return nil, fault.New("watch_target_device_unavailable", 403)
		}
		grant, e := one(ctx, tx, `SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND room_id=$2 AND subject_id=$3 FOR UPDATE`, w["current_grant_id"], w["room_id"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if grant == nil || grant["revoked_at"] != nil || seconds(grant["expires_at"]) <= s.now() {
			return nil, fault.New("watch_source_grant_revoked", 403)
		}
		cursor, e := one(ctx, tx, `SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='agent' AND agent_ref=$3`, w["room_id"], a.SubjectID, w["current_grant_id"])
		if e != nil {
			return nil, e
		}
		last := "0"
		if cursor != nil {
			last = text(cursor, "sequence")
		}
		expires := at(w["expires_at"])
		if deadline := at(target["expires_at"]); deadline.Before(expires) {
			expires = deadline
		}
		created, e := one(ctx, tx, `INSERT INTO chat_agent_grants(grant_id,room_id,subject_id,binding_id,mode,primary_responder,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING grant_id`, p["newGrantId"], w["room_id"], a.SubjectID, p["targetBindingId"], grant["mode"], grant["primary_responder"], expires, time.Unix(s.now(), 0))
		if e != nil {
			return nil, e
		}
		if created == nil {
			return nil, fault.New("watch_target_grant_exists", 409)
		}
		if _, e = tx.Exec(ctx, `UPDATE chat_agent_grants SET revoked_at=$2 WHERE grant_id=$1`, w["current_grant_id"], time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO chat_cursors(room_id,subject_id,cursor_kind,agent_ref,sequence,updated_at) VALUES($1,$2,'agent',$3,$4,$5)`, w["room_id"], a.SubjectID, p["newGrantId"], last, time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE watch_controls_v2 SET current_grant_id=$2,current_binding_id=$3,revision=revision+1,expires_at=$4,updated_at=$5 WHERE watch_id=$1`, p["watchId"], p["newGrantId"], p["targetBindingId"], expires, time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		return s.record(ctx, tx, a, x, "takeover", Object{"revision": number(w, "revision") + 1, "agentGrantId": p["newGrantId"], "bindingId": p["targetBindingId"], "previousGrantId": w["current_grant_id"], "previousInstallationState": "revoked-for-this-watch", "lastCursor": last, "externalProcessStopped": "unconfirmed"})
	})
}
func (s *Service) Stop(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "stop")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		initial, e := s.own(ctx, tx, a, text(p, "watchId"))
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR UPDATE`, initial["room_id"]); e != nil {
			return nil, e
		}
		replay, e := s.operation(ctx, tx, a, x, "stop")
		if e != nil || replay != nil {
			return replay, e
		}
		w, e := one(ctx, tx, `SELECT * FROM watch_controls_v2 WHERE watch_id=$1 FOR UPDATE`, p["watchId"])
		if e != nil {
			return nil, e
		}
		if number(w, "revision") != number(p, "expectedRevision") || w["current_grant_id"] != p["expectedGrantId"] {
			return nil, fault.New("watch_control_revision_conflict", 409)
		}
		if _, e = tx.Exec(ctx, `UPDATE chat_agent_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE grant_id=$1 AND subject_id=$3`, w["current_grant_id"], time.Unix(s.now(), 0), a.SubjectID); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE watch_controls_v2 SET state='stopped',revision=revision+1,stopped_at=COALESCE(stopped_at,$2),updated_at=$2 WHERE watch_id=$1`, p["watchId"], time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		return s.record(ctx, tx, a, x, "stop", Object{"revision": number(w, "revision") + 1, "agentGrantId": w["current_grant_id"], "state": "stopped", "externalProcessStopped": "unconfirmed"})
	})
}
