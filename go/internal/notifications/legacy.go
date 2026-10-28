package notifications

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func milliStamp(n int64) string { return time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z") }
func (s *Service) LegacyQuery(ctx context.Context, a Actor, input Object) (any, error) {
	q, e := parseQuery(input, true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		preferences, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		settings := object(preferences["settings"])
		if !boolean(settings["enabled"]) {
			return Object{"items": []any{}, "nextAfter": nil, "enabled": false}, nil
		}
		candidates, e := s.legacyCandidates(ctx, tx, a.SubjectID, q, settings, nil, preferences["archivedBefore"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, candidate := range candidates {
			view, e := s.visible(ctx, tx, a, candidate)
			if e != nil {
				if fault.Status(e) == 403 || fault.Status(e) == 404 {
					continue
				}
				return nil, e
			}
			if view == nil {
				continue
			}
			item := Object{"id": key(candidate), "assistanceId": candidate["assistance_id"], "category": candidate["category"], "at": iso(candidate["created_at"]), "read": candidate["read_at"] != nil}
			for key, value := range view {
				item[key] = value
			}
			items = append(items, item)
			if int64(len(items)) > q.Limit {
				break
			}
		}
		var next any
		if int64(len(items)) > q.Limit {
			next = items[q.Limit-1].(map[string]any)["id"]
		} else if len(candidates) == 200 {
			next = key(candidates[len(candidates)-1])
		}
		return Object{"items": items[:min(len(items), int(q.Limit))], "nextAfter": next, "enabled": true}, nil
	})
}
func (s *Service) LegacyMarkRead(ctx context.Context, a Actor, id string) (any, error) {
	kind, eventID, e := locator(id, true)
	if e != nil {
		return nil, fail("invalid_notification_id", 400)
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		preferences, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		candidates, e := s.legacyCandidates(ctx, tx, a.SubjectID, queryInput{}, object(preferences["settings"]), &exactLocator{kind, eventID}, preferences["archivedBefore"])
		if e != nil {
			return nil, e
		}
		if !boolean(object(preferences["settings"])["enabled"]) || len(candidates) == 0 {
			return nil, fail("not_found", 404)
		}
		view, e := s.visible(ctx, tx, a, candidates[0])
		if e != nil {
			return nil, e
		}
		if view == nil {
			return nil, fail("not_found", 404)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO notification_preferences(subject_id,settings)VALUES($1,$2::jsonb)ON CONFLICT(subject_id)DO NOTHING", a.SubjectID, encode(DefaultSettings())); e != nil {
			return nil, e
		}
		var locked string
		if e = tx.QueryRow(ctx, "SELECT subject_id FROM notification_preferences WHERE subject_id=$1 FOR UPDATE", a.SubjectID).Scan(&locked); e != nil {
			return nil, e
		}
		current, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		candidates, e = s.legacyCandidates(ctx, tx, a.SubjectID, queryInput{}, object(current["settings"]), &exactLocator{kind, eventID}, current["archivedBefore"])
		if e != nil {
			return nil, e
		}
		if !boolean(object(current["settings"])["enabled"]) || len(candidates) == 0 {
			return nil, fail("not_found", 404)
		}
		tag, e := tx.Exec(ctx, "INSERT INTO notification_reads(subject_id,kind,event_id)VALUES($1,$2,$3)ON CONFLICT DO NOTHING", a.SubjectID, kind, eventID)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() > 0 {
			if e = s.audit(ctx, tx, a, auth, "notification.read", eventID, id); e != nil {
				return nil, e
			}
		}
		return Object{"id": id, "read": true}, nil
	})
}

// EraseSubjectWithin and PurgeExpired are original worker-only maintenance;
// API roles retain their existing lack of DELETE for these tables.
func (s *Service) EraseSubjectWithin(ctx context.Context, tx pgx.Tx, subject string) (Object, error) {
	tag, e := tx.Exec(ctx, "DELETE FROM notification_presentations WHERE subject_id=$1", subject)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM notification_options_v2 WHERE subject_id=$1", subject); e != nil {
		return nil, e
	}
	return Object{"removedPresentations": tag.RowsAffected(), "sourceEventsDeleted": false}, nil
}
func (s *Service) PurgeExpired(ctx context.Context) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		tag, e := tx.Exec(ctx, "DELETE FROM notification_presentations WHERE expires_at<=$1", stamp(s.now()))
		if e != nil {
			return nil, e
		}
		return Object{"removedPresentations": tag.RowsAffected(), "sourceEventsDeleted": false}, nil
	})
}
