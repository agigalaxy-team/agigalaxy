package community

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

// ActivityAllowedWithin is the original metadata-only current-public activity
// predicate for the caller's repeatable-read snapshot and fixed clock. It does
// not parse or return prose and does not establish actor authority.
func (s *Service) ActivityAllowedWithin(ctx context.Context, tx pgx.Tx, kind, postID, sourceID, permissionID, payloadHash string, at int64) (bool, error) {
	if !hasString([]string{"post", "reply"}, kind) {
		return false, fail("invalid_operations_request", 400)
	}
	// The publication's permission reference can be cleared by source
	// deletion. Such content cannot qualify as current public activity.
	if permissionID == "" {
		return false, nil
	}
	current := *s
	current.actor = nil
	current.Authority = nil
	current.workerPublicRead = true
	current.Now = func() time.Time { return time.Unix(at, 0) }
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM forum_permissions_v1 p WHERE id=$1", permissionID)
	if e != nil || p == nil {
		return false, e
	}
	action := "forum.post.publish"
	if kind == "reply" {
		action = "forum.reply.publish"
	}
	state, e := current.permissionDetailWithin(ctx, tx, p, "", true, false, &permissionSelector{Visibility: "Public", PayloadHash: payloadHash, Action: action, ObjectID: sourceID})
	if e != nil {
		return false, e
	}
	if len(state.Detail["stoppedReasons"].([]string)) > 0 {
		return false, nil
	}
	// An official-account permission's verified event already proved the
	// same account belongs to this endpoint in the current transaction.
	if p["account_id"] != nil && !state.accountEndpointVerified {
		var belongs bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2)", p["account_id"], s.Endpoint).Scan(&belongs)
		if e != nil || !belongs {
			return false, e
		}
	}
	target := Object{"kind": "post-version", "postId": postID, "versionId": sourceID}
	if kind == "reply" {
		target = Object{"kind": "reply", "postId": postID, "replyId": sourceID, "contentRevision": 1}
	}
	hidden, e := current.hidden(ctx, tx, target)
	return !hidden, e
}
