package information

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Watches) Events(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parseWatch(raw, "events")
	if e != nil {
		return nil, e
	}
	if text(x, "watchId") == "" {
		return nil, watchInvalid()
	}
	capture, e := s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := s.rowWithin(ctx, tx, a, text(x, "watchId"), false)
		if e != nil {
			return nil, e
		}
		rows, e := query(ctx, tx, `SELECT id::text,changes,created_at,available_at FROM information_watch_changes_v2 WHERE watch_id=$1 AND subject_id=$2 AND expires_at>$3 AND available_at<=$3 ORDER BY created_at DESC LIMIT 20`, x["watchId"], a.SubjectID, s.at(s.now()))
		if e != nil {
			return nil, e
		}
		return Object{"watch": r, "rows": rows}, nil
	})
	if e != nil {
		return nil, e
	}
	if s.Information == nil {
		return nil, fault.New("information_source_unavailable", 503)
	}
	watch := obj(capture["watch"])
	plan := obj(watch["plan"])
	current, e := s.Information.Query(ctx, &a, encode(Object{"purpose": plan["purpose"], "sources": plan["sources"]}))
	if e != nil {
		return nil, e
	}
	visible := map[string]map[string]bool{}
	for _, value := range list(current["items"]) {
		source := obj(value)
		ids := map[string]bool{}
		for _, item := range list(source["items"]) {
			ids[text(obj(item), "id")] = true
		}
		visible[text(source, "key")] = ids
	}
	events := []any{}
	for _, value := range list(capture["rows"]) {
		r := obj(value)
		changes := []any{}
		for _, change := range list(r["changes"]) {
			c := obj(change)
			key := text(c, "key")
			if text(c, "id") != "" && visible[key][text(c, "id")] {
				changes = append(changes, change)
			} else {
				changes = append(changes, Object{"key": c["key"], "kind": "current-source-recheck-required"})
			}
		}
		events = append(events, Object{"id": r["id"], "at": seconds(r["created_at"]), "changes": changes})
	}
	return merge(Object{"watch": s.view(watch), "current": current, "events": events}, s.runtime(watch)), nil
}
func (s *Watches) NotificationWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, eventID string) (Object, error) {
	rows, e := query(ctx, tx, `SELECT e.id::text,e.watch_id::text,e.expires_at FROM information_watch_changes_v2 e JOIN information_watches_v2 w ON w.id=e.watch_id WHERE e.id=$1 AND e.subject_id=$2 AND e.available_at<=$3 AND e.expires_at>$3 AND w.state='active' AND w.expires_at>$3 AND w.revision=e.watch_revision`, eventID, a.SubjectID, s.at(s.now()))
	if e != nil || len(rows) == 0 {
		return nil, e
	}
	r := rows[0]
	return Object{"title": "关注的资料有变化，请按当前权限查看", "eventKind": "information-change", "actorId": a.SubjectID, "object": Object{"type": "information-watch", "id": r["watch_id"], "eventId": r["id"]}, "sourceExpiresAt": s.at(seconds(r["expires_at"])).Format("2006-01-02T15:04:05.000Z"), "receiptOnly": true, "sourceState": "recheck-required"}, nil
}
func (s *Watches) EraseSubjectWithin(ctx context.Context, tx pgx.Tx, subject string) error {
	for _, table := range []string{"information_watch_changes_v2", "information_watch_operations_v2", "information_watches_v2"} {
		if _, e := tx.Exec(ctx, `DELETE FROM `+table+` WHERE subject_id=$1`, subject); e != nil {
			return e
		}
	}
	return nil
}
func (s *Watches) PurgeExpiredWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	tag, e := tx.Exec(ctx, `DELETE FROM information_watch_changes_v2 WHERE id IN(SELECT id FROM information_watch_changes_v2 WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`, s.at(s.now()))
	if e != nil {
		return nil, e
	}
	rows, e := query(ctx, tx, `SELECT id::text FROM information_watches_v2 WHERE COALESCE(ended_at,expires_at)<=$1 ORDER BY id LIMIT 100`, s.at(s.now()-90*86400))
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, text(r, "id"))
	}
	if len(ids) > 0 {
		for _, table := range []string{"information_watch_changes_v2", "information_watch_operations_v2", "information_watches_v2"} {
			column := "watch_id"
			if table == "information_watches_v2" {
				column = "id"
			}
			if _, e = tx.Exec(ctx, `DELETE FROM `+table+` WHERE `+column+`=ANY($1::uuid[])`, ids); e != nil {
				return nil, e
			}
		}
	}
	return Object{"informationChangeReceipts": tag.RowsAffected(), "informationWatchReceipts": len(ids)}, nil
}
