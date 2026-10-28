package accountlinks

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// OpsPartyConflictWithin compares a verified operations principal with the
// owning report's parties. It grants no identity/content access and intentionally
// retains all current same-controller mappings, without a provider allowlist.
func (s *Service) OpsPartyConflictWithin(ctx context.Context, tx pgx.Tx, issuer, externalSubject string, partySubjects, partyAccounts []string) (bool, error) {
	if s == nil || s.Endpoint == "" || issuer == "" || externalSubject == "" {
		return false, fault.New("account_authority_unavailable", 503)
	}
	if e := LockMappingsWithin(ctx, tx, s.Endpoint, partySubjects, false); e != nil {
		return false, e
	}
	accounts := []string{}
	for _, id := range partyAccounts {
		if id != "" {
			accounts = append(accounts, id)
		}
	}
	var conflict bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts a WHERE a.endpoint=$1 AND a.issuer=$2 AND a.external_subject=$3 AND (a.id=ANY($4::uuid[]) OR EXISTS(SELECT 1 FROM community_account_links g JOIN external_identity_links e ON e.id=g.identity_link_id WHERE g.account_id=a.id AND e.endpoint=$1 AND e.revoked_at IS NULL AND g.subject_id=ANY($5::text[]))))`, s.Endpoint, issuer, externalSubject, accounts, partySubjects).Scan(&conflict)
	return conflict, e
}
