package accounts

import (
	"context"
	"errors"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// PublicProfileWithin is the existing explicitly opted-in anonymous profile
// projection, with no directory, private archives, credentials or permissions.
func (s *Service) PublicProfileWithin(ctx context.Context, tx pgx.Tx, accountID string, posts PublicPosts) (Object, error) {
	if !uuidPattern.MatchString(accountID) {
		return nil, invalid()
	}
	row, e := s.readProfile(ctx, tx, accountID)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && !row.QueryEnabled {
		return nil, fault.New("not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	var actor *string
	e = tx.QueryRow(ctx, "SELECT actor_kind FROM official_account_type_history_v1 WHERE account_id=$1 ORDER BY revision DESC LIMIT 1", accountID).Scan(&actor)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	source := "account-owner-statement"
	if actor != nil && *actor == "business-operator" {
		source = "operator-recorded-statement"
	}
	out := Object{"accountId": accountID, "uid": row.UID, "displayName": row.DisplayName, "avatarKey": row.AvatarKey, "bio": row.Bio, "subjectType": row.SubjectType, "typeSource": source, "publicQuery": Object{"scope": row.QueryScope, "showLinkedIds": row.ShowLinkedIDs, "showExternalCredentials": row.ShowExternalCredentials}}
	if row.QueryScope == "profile-and-public-posts" && posts != nil {
		projection, e := posts(ctx, tx, accountID)
		if e != nil {
			return nil, e
		}
		out["posts"] = projection
	}
	return out, nil
}
func (s *Service) PublicProfileByUIDWithin(ctx context.Context, tx pgx.Tx, uid string, posts PublicPosts) (Object, error) {
	uid = strings.ToUpper(uid)
	if !UIDPattern.MatchString(uid) {
		return nil, fault.New("not_found", 404)
	}
	var account string
	e := tx.QueryRow(ctx, "SELECT a.id::text FROM community_accounts a JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.uid=$1 AND a.endpoint=$2 AND p.query_enabled=true", uid, s.Endpoint).Scan(&account)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	return s.PublicProfileWithin(ctx, tx, account, posts)
}
