package notifications

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/jackc/pgx/v5"
)

func DefaultSettings() Object {
	return Object{"enabled": true, "invitations": true, "collaboration": true, "materials": true, "capsules": true, "incidents": true, "mutedAssistanceIds": []any{}}
}
func ParseSettings(p Object) (Object, error) {
	if p == nil {
		return nil, fail("invalid_notification_preferences", 400)
	}
	if !shape(p, []string{"enabled", "invitations", "collaboration", "materials", "mutedAssistanceIds"}, []string{"capsules", "incidents", "discovery"}) {
		return nil, fail("invalid_notification_preferences", 400)
	}
	for _, key := range []string{"capsules", "incidents"} {
		if _, ok := p[key]; !ok {
			p[key] = true
		}
	}
	for _, key := range []string{"enabled", "invitations", "collaboration", "materials", "capsules", "incidents"} {
		if _, ok := p[key].(bool); !ok {
			return nil, fail("invalid_notification_preferences", 400)
		}
	}
	values, ok := p["mutedAssistanceIds"].([]any)
	if !ok || len(values) > 64 {
		return nil, fail("invalid_notification_preferences", 400)
	}
	seen := map[string]bool{}
	for _, value := range values {
		id, ok := value.(string)
		if !ok || !validID(id) || seen[id] {
			return nil, fail("invalid_notification_preferences", 400)
		}
		seen[id] = true
	}
	if value, ok := p["discovery"]; ok {
		discovery, e := projects.ParseDiscoveryPreferences(object(value))
		if e != nil {
			return nil, fail("invalid_notification_preferences", 400)
		}
		p["discovery"] = discovery
	}
	return p, nil
}
func (s *Service) PreferencesWithin(ctx context.Context, tx pgx.Tx, subjectID string) (Object, error) {
	current, e := one(ctx, tx, "SELECT to_jsonb(p) FROM notification_preferences p WHERE subject_id=$1", subjectID)
	if e != nil {
		return nil, e
	}
	settings := DefaultSettings()
	if current != nil {
		settings = object(current["settings"])
	}
	settings, e = ParseSettings(settings)
	if e != nil {
		return nil, fail("notification_preferences_integrity_error", 500)
	}
	var archived any
	if current["archived_before"] != nil {
		archived = iso(current["archived_before"])
	}
	return Object{"settings": settings, "revision": num(current["revision"]), "archivedBefore": archived, "archiveSupported": true}, nil
}

// DiscoveryPreferencesWithin is current stored preference metadata; consumers
// authorize their real owning source before using this opt-in declaration.
func (s *Service) DiscoveryPreferencesWithin(ctx context.Context, tx pgx.Tx, subjectID string) (Object, error) {
	preferences, e := s.PreferencesWithin(ctx, tx, subjectID)
	if e != nil {
		return nil, e
	}
	return object(object(preferences["settings"])["discovery"]), nil
}
func (s *Service) Preferences(ctx context.Context, a Actor) (any, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		return s.PreferencesWithin(ctx, tx, a.SubjectID)
	})
}
func (s *Service) SavePreferences(ctx context.Context, a Actor, input Object) (any, error) {
	if !shape(input, []string{"expectedRevision", "settings"}, nil) || !integer(input["expectedRevision"], 0, 9007199254740991) {
		return nil, fail("invalid_notification_preferences", 400)
	}
	settings, e := ParseSettings(object(input["settings"]))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "INSERT INTO notification_preferences(subject_id,settings)VALUES($1,$2::jsonb)ON CONFLICT(subject_id)DO NOTHING", a.SubjectID, encode(DefaultSettings())); e != nil {
			return nil, e
		}
		current, e := one(ctx, tx, "SELECT to_jsonb(p) FROM notification_preferences p WHERE subject_id=$1 FOR UPDATE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		if num(current["revision"]) != num(input["expectedRevision"]) {
			return nil, fail("notification_preferences_conflict")
		}
		if _, ok := settings["discovery"]; !ok {
			if stored, ok := object(current["settings"])["discovery"]; ok {
				settings["discovery"] = stored
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE notification_preferences SET settings=$2::jsonb,revision=revision+1,updated_at=now()WHERE subject_id=$1", a.SubjectID, encode(settings)); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, "notification.preferences", a.SubjectID, a.SubjectID+":"+stringNumber(num(current["revision"])+1)); e != nil {
			return nil, e
		}
		return s.PreferencesWithin(ctx, tx, a.SubjectID)
	})
}
func (s *Service) Archive(ctx context.Context, a Actor, input Object) (any, error) {
	if !shape(input, []string{"expectedRevision", "before"}, nil) || !integer(input["expectedRevision"], 0, 9007199254740991) || !integer(input["before"], 1, 9007199254740991) || num(input["before"]) > s.now() {
		return nil, fail("invalid_notification_archive", 400)
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := tx.Exec(ctx, "INSERT INTO notification_preferences(subject_id,settings)VALUES($1,$2::jsonb)ON CONFLICT(subject_id)DO NOTHING", a.SubjectID, encode(DefaultSettings())); e != nil {
			return nil, e
		}
		current, e := one(ctx, tx, "SELECT to_jsonb(p) FROM notification_preferences p WHERE subject_id=$1 FOR UPDATE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		before := stamp(num(input["before"]))
		if current["archived_before"] != nil && iso(current["archived_before"]) == before {
			view, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
			if e != nil {
				return nil, e
			}
			view["removedReadMarkers"] = 0
			return view, nil
		}
		if num(current["revision"]) != num(input["expectedRevision"]) {
			return nil, fail("notification_preferences_conflict")
		}
		if current["archived_before"] != nil && milliseconds(current["archived_before"]) > num(input["before"])*1000 {
			return nil, fail("notification_archive_cannot_rewind")
		}
		if _, e = tx.Exec(ctx, "UPDATE notification_preferences SET archived_before=$2,revision=revision+1,updated_at=now()WHERE subject_id=$1", a.SubjectID, before); e != nil {
			return nil, e
		}
		removed, e := tx.Exec(ctx, "DELETE FROM notification_reads WHERE subject_id=$1 AND read_at<$2", a.SubjectID, before)
		if e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, "notification.archive", a.SubjectID, a.SubjectID+":"+stringNumber(num(current["revision"])+1)); e != nil {
			return nil, e
		}
		view, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		view["removedReadMarkers"] = removed.RowsAffected()
		return view, nil
	})
}
