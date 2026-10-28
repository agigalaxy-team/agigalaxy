package notifications

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func claimInput(input Object) (string, string, string, error) {
	if !shape(input, []string{"id", "deliveryClientId", "claimId"}, nil) || !validID(str(input, "deliveryClientId")) || !validID(str(input, "claimId")) {
		return "", "", "", fail("invalid_inbox_request", 400)
	}
	kind, eventID, e := locator(str(input, "id"), false)
	return kind, eventID, str(input, "id"), e
}
func (s *Service) Claim(ctx context.Context, a Actor, input Object) (any, error) {
	kind, eventID, id, e := claimInput(input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		item, e := s.OneWithin(ctx, tx, a.Actor, id)
		if e != nil {
			return nil, e
		}
		if !boolean(item["interruptiveEligible"]) {
			return Object{"id": id, "claimed": false, "presented": item["presented"], "quiet": item["quiet"]}, nil
		}
		expires := milliseconds(item["at"]) + 90*86400*1000
		if item["sourceExpiresAt"] != nil {
			expires = min(expires, milliseconds(item["sourceExpiresAt"]))
		}
		row, e := one(ctx, tx, `WITH claimed AS(INSERT INTO notification_presentations(subject_id,kind,event_id,client_id,claim_id,lease_until,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(subject_id,kind,event_id)DO UPDATE SET client_id=EXCLUDED.client_id,claim_id=EXCLUDED.claim_id,lease_until=EXCLUDED.lease_until WHERE notification_presentations.presented_at IS NULL AND (notification_presentations.lease_until<=$8 OR notification_presentations.client_id=$4 AND notification_presentations.claim_id=$5) RETURNING claim_id,lease_until)SELECT to_jsonb(claimed)FROM claimed`, a.SubjectID, kind, eventID, input["deliveryClientId"], input["claimId"], stamp(s.now()+30), milliStamp(expires), stamp(s.now()))
		if e != nil {
			return nil, e
		}
		var claimID, lease any
		if row != nil {
			claimID = row["claim_id"]
			lease = iso(row["lease_until"])
		}
		return Object{"id": id, "claimed": row != nil, "claimId": claimID, "leaseUntil": lease, "deliveryConfirmed": false}, nil
	})
}
func (s *Service) Presented(ctx context.Context, a Actor, input Object) (any, error) {
	kind, eventID, id, e := claimInput(input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		tag, e := tx.Exec(ctx, `UPDATE notification_presentations SET presented_at=COALESCE(presented_at,$6)WHERE subject_id=$1 AND kind=$2 AND event_id=$3 AND client_id=$4 AND claim_id=$5 AND (presented_at IS NOT NULL OR lease_until>$6)`, a.SubjectID, kind, eventID, input["deliveryClientId"], input["claimId"], stamp(s.now()))
		if e != nil {
			return nil, e
		}
		var read bool
		if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM notification_reads WHERE subject_id=$1 AND kind=$2 AND event_id=$3)", a.SubjectID, kind, eventID).Scan(&read); e != nil {
			return nil, e
		}
		return Object{"id": id, "presented": tag.RowsAffected() > 0, "acknowledgement": "client-reported-display", "read": read, "humanReadChanged": false}, nil
	})
}
func (s *Service) MarkRead(ctx context.Context, a Actor, input Object) (any, error) {
	if !shape(input, []string{"id", "reader"}, nil) || input["reader"] != "human" {
		return nil, fail("invalid_inbox_request", 400)
	}
	id := str(input, "id")
	kind, eventID, e := locator(id, false)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if _, e := s.OneWithin(ctx, tx, a.Actor, id); e != nil {
			return nil, e
		}
		preferences, e := s.PreferencesWithin(ctx, tx, a.SubjectID)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO notification_preferences(subject_id,settings)VALUES($1,$2::jsonb)ON CONFLICT DO NOTHING", a.SubjectID, encode(preferences["settings"])); e != nil {
			return nil, e
		}
		var locked string
		if e = tx.QueryRow(ctx, "SELECT subject_id FROM notification_preferences WHERE subject_id=$1 FOR UPDATE", a.SubjectID).Scan(&locked); e != nil {
			return nil, e
		}
		if _, e = s.OneWithin(ctx, tx, a.Actor, id); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, "INSERT INTO notification_reads(subject_id,kind,event_id,read_at)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING", a.SubjectID, kind, eventID, stamp(s.now()))
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
