package accountlinks

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// HasLinkedPartyWithin retains the original governance independence comparison.
// The caller already resolved the moderator's current account and source parties;
// this returns only the existence of a mapping, never another party's identity.
func (s *Service) HasLinkedPartyWithin(ctx context.Context, tx pgx.Tx, accountID string, partyIDs []string) (bool, error) {
	var exists bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=ANY($2::text[]))", accountID, partyIDs).Scan(&exists)
	return exists, e
}
