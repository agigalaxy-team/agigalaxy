// Package watchcontrol owns explicit host watch-control metadata and original
// operation receipts. It starts no Agent, model, or external host process.
package watchcontrol

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)
type RoomReader func(context.Context, pgx.Tx, *deviceauth.Actor, string, bool) (Object, error)
type AgentReader func(context.Context, pgx.Tx, *deviceauth.Actor, string, string) (Object, error)
type TaskReader func(context.Context, pgx.Tx, *deviceauth.Actor, string) (Object, error)
type Service struct {
	Pool          *pgxpool.Pool
	Devices       *deviceauth.Service
	Room          RoomReader
	Agent         AgentReader
	Task          TaskReader
	ResourceWrite ResourceWrite
	Now           func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func seconds(v any) int64 {
	if at, ok := v.(time.Time); ok {
		return at.Unix()
	}
	if raw, ok := v.(string); ok {
		at, _ := time.Parse(time.RFC3339Nano, raw)
		return at.Unix()
	}
	return 0
}
func scopes(v any) []string {
	if s, ok := v.([]string); ok {
		return s
	}
	out := []string{}
	if a, ok := v.([]any); ok {
		for _, v := range a {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func contains(a []string, w string) bool {
	for _, v := range a {
		if v == w {
			return true
		}
	}
	return false
}
func query(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		v, e := r.Values()
		if e != nil {
			return nil, e
		}
		o := Object{}
		for i, f := range r.FieldDescriptions() {
			value := v[i]
			if id, ok := value.([16]byte); ok {
				value = uuid.UUID(id).String()
			}
			o[f.Name] = value
		}
		out = append(out, o)
	}
	return out, r.Err()
}
func one(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	r, e := query(ctx, tx, sql, args...)
	if e != nil || len(r) == 0 {
		return nil, e
	}
	return r[0], nil
}
func unavailable(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 401 || f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("watch_control_unavailable", 503)
	}
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a, "binding"); e != nil {
			return nil, e
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func() error { return s.Devices.AuthorizeWithin(ctx, tx, a, "binding") }
		op := func() (Object, error) { return fn(tx) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, false, authorize, op)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return op()
	})
}
func (s *Service) own(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	o, e := one(ctx, tx, `SELECT * FROM watch_controls_v2 WHERE watch_id=$1 AND subject_id=$2`, id, a.SubjectID)
	if e != nil {
		return nil, e
	}
	if o == nil {
		return nil, fault.New("watch_control_not_found", 404)
	}
	return o, nil
}
func (s *Service) scope(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, row Object, write bool) (Object, error) {
	if text(row, "task_id") != "" {
		if s.Task == nil {
			return nil, fault.New("watch_task_source_unavailable", 503)
		}
		task, e := s.Task(ctx, tx, &a, text(row, "task_id"))
		if e != nil {
			return nil, e
		}
		if task["state"] == "closed" || task["state"] == "canceled" {
			return nil, fault.New("watch_task_ended", 409)
		}
	}
	if s.Room == nil {
		return nil, fault.New("watch_room_source_unavailable", 503)
	}
	room, e := s.Room(ctx, tx, &a, text(row, "room_id"), write)
	if e != nil {
		return nil, e
	}
	if room["state"] == "archived" || room["state"] == "owner-succession" {
		return nil, fault.New("watch_room_inactive", 409)
	}
	return room, nil
}
func (s *Service) view(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, row Object) (Object, error) {
	available := true
	if row["state"] == "stopped" {
		if _, e := tx.Exec(ctx, `SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE`, row["room_id"]); e != nil {
			return nil, e
		}
	} else if _, e := s.scope(ctx, tx, a, row, false); e != nil {
		if !unavailable(e) {
			return nil, e
		}
		available = false
		if _, e := tx.Exec(ctx, `SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE`, row["room_id"]); e != nil {
			return nil, e
		}
	}
	row, e := s.own(ctx, tx, a, text(row, "watch_id"))
	if e != nil {
		return nil, e
	}
	grant, e := one(ctx, tx, `SELECT * FROM chat_agent_grants WHERE grant_id=$1 AND subject_id=$2`, row["current_grant_id"], a.SubjectID)
	if e != nil {
		return nil, e
	}
	binding, e := s.Devices.BindingControlWithin(ctx, tx, text(row, "current_binding_id"), a.SubjectID, "binding")
	if e != nil {
		return nil, e
	}
	state := "active"
	switch {
	case row["state"] == "stopped":
		state = "stopped"
	case seconds(row["expires_at"]) <= s.now():
		state = "expired"
	case grant == nil || grant["revoked_at"] != nil:
		state = "permission-revoked"
	case binding == nil || binding["revoked_at"] != nil || !contains(scopes(binding["scopes"]), "binding") || seconds(binding["expires_at"]) <= s.now():
		state = "device-unavailable"
	}
	if state == "active" && !available {
		state = "scope-unavailable"
	}
	cursor, e := one(ctx, tx, `SELECT sequence::text FROM chat_cursors WHERE room_id=$1 AND subject_id=$2 AND cursor_kind='agent' AND agent_ref=$3`, row["room_id"], a.SubjectID, row["current_grant_id"])
	if e != nil {
		return nil, e
	}
	last := "0"
	if cursor != nil {
		last = text(cursor, "sequence")
	}
	out := Object{"watchId": row["watch_id"], "subjectId": row["subject_id"], "roomId": row["room_id"], "purpose": row["purpose"], "revision": row["revision"], "state": state, "agentGrantId": row["current_grant_id"], "bindingId": row["current_binding_id"], "installationId": binding["installation_id"], "mode": grant["mode"], "primaryResponder": grant["primary_responder"] == true, "expiresAt": seconds(row["expires_at"]), "lastCursor": last, "cursorMeaning": "server-acknowledged-agent-position; not-human-read", "stored": "explicitly-selected-private-watch-control", "runtimeLocation": "user-host", "hostRuntimeState": "unverified", "externalProcessStopped": "unconfirmed", "cloudModel": false}
	if row["task_id"] != nil {
		out["taskId"] = row["task_id"]
	}
	return out, nil
}
func (s *Service) response(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, op Object) (Object, error) {
	row, e := s.own(ctx, tx, a, text(op, "watch_id"))
	if e != nil {
		return nil, e
	}
	view, e := s.view(ctx, tx, a, row)
	if e != nil {
		return nil, e
	}
	return Object{"operationId": op["operation_id"], "requestHash": op["request_hash"], "state": "recorded", "receipt": op["result"], "watch": view}, nil
}
func (s *Service) operation(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, x *protocol.OrderedObject, kind string) (Object, error) {
	p := x.Values()
	op, e := one(ctx, tx, `SELECT * FROM watch_control_operations_v2 WHERE operation_id=$1`, p["operationId"])
	if e != nil || op == nil {
		return nil, e
	}
	if op["subject_id"] != a.SubjectID || op["watch_id"] != p["watchId"] || op["kind"] != kind || op["request_hash"] != identity.Digest(encode(x)) {
		return nil, fault.New("watch_operation_conflict", 409)
	}
	return s.response(ctx, tx, a, op)
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, x *protocol.OrderedObject, kind string, result Object) (Object, error) {
	p := x.Values()
	op, e := one(ctx, tx, `INSERT INTO watch_control_operations_v2(operation_id,watch_id,subject_id,binding_id,kind,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`, p["operationId"], p["watchId"], a.SubjectID, a.BindingID, kind, identity.Digest(encode(x)), string(encode(result)), time.Unix(s.now(), 0))
	if e != nil {
		return nil, e
	}
	return s.response(ctx, tx, a, op)
}
