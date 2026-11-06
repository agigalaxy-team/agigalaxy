package discovery

import (
	"context"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// FeedbackState is a single real user's current interaction, never a weighted
// number of synthetic interactions. Revision belongs to this exact relation.
type FeedbackState struct {
	ProfileID, ItemKey, Type string
	Active                   bool
	Revision                 int64
	OccurredAt               time.Time
}

var feedbackTypes = map[string]bool{
	"view": true, "click": true, "bookmark": true, "participate": true,
	"not-interested": true, "like": true,
}

func validFeedbackKey(profile, item, kind string) bool {
	parts := strings.SplitN(profile, ":", 2)
	return len(parts) == 2 && (parts[0] == "account" || parts[0] == "visitor") &&
		validID(parts[1]) && profile == strings.ToLower(profile) &&
		ItemReference(item) != nil && feedbackTypes[kind]
}

// QueueFeedbackStateWithin must be called in the transaction that saves the
// source interaction and its original operation receipt. Old source revisions
// cannot revive a cancelled relation; identical replays do not enqueue again.
// Callers derive profile and revision from trusted business state.
func (s *Store) QueueFeedbackStateWithin(ctx context.Context, tx pgx.Tx, state FeedbackState) error {
	if !validFeedbackKey(state.ProfileID, state.ItemKey, state.Type) || state.Revision < 1 || state.OccurredAt.IsZero() {
		return invalid()
	}
	tag, e := tx.Exec(ctx, `INSERT INTO discovery_feedback_state_v1(endpoint,profile_id,item_key,feedback_type,desired_active,revision,occurred_at,next_attempt_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
		ON CONFLICT(endpoint,profile_id,item_key,feedback_type) DO UPDATE SET
		desired_active=excluded.desired_active,revision=excluded.revision,occurred_at=excluded.occurred_at,
        delivery_generation=discovery_feedback_state_v1.delivery_generation+1,
		attempts=0,next_attempt_at=excluded.next_attempt_at,last_error=NULL,updated_at=excluded.updated_at
		WHERE discovery_feedback_state_v1.revision<excluded.revision`,
		s.Endpoint, state.ProfileID, state.ItemKey, state.Type, state.Active, state.Revision, state.OccurredAt.UTC(), s.now())
	if e != nil || tag.RowsAffected() != 0 {
		return e
	}
	var revision int64
	var active bool
	var at time.Time
	if e = tx.QueryRow(ctx, `SELECT revision,desired_active,occurred_at FROM discovery_feedback_state_v1
		WHERE endpoint=$1 AND profile_id=$2 AND item_key=$3 AND feedback_type=$4`,
		s.Endpoint, state.ProfileID, state.ItemKey, state.Type).Scan(&revision, &active, &at); e != nil {
		return e
	}
	if revision == state.Revision && (active != state.Active || !at.Equal(state.OccurredAt.UTC().Truncate(time.Microsecond))) {
		return fault.New("discovery_feedback_revision_conflict", 409)
	}
	return nil
}
