package accounts

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Profile struct {
	AccountID, UID                         string
	SubjectType, DisplayName, AvatarKey    *string
	Bio                                    string
	Revision                               int64
	QueryEnabled                           bool
	QueryScope                             string
	ShowLinkedIDs, ShowExternalCredentials bool
	ArchiveRetentionDays                   *int
	UpdatedAt                              time.Time
}

var subjectTypes = map[string]bool{"person": true, "organization": true, "agent": true}

const profileColumns = `p.account_id::text,a.uid,p.subject_type,p.display_name,p.avatar_key,p.bio,p.revision,p.query_enabled,p.query_scope,p.query_linked_ids,p.query_external_credentials,p.archive_retention_days,p.updated_at`

func scanProfile(row pgx.Row) (r Profile, e error) {
	e = row.Scan(&r.AccountID, &r.UID, &r.SubjectType, &r.DisplayName, &r.AvatarKey, &r.Bio, &r.Revision, &r.QueryEnabled, &r.QueryScope, &r.ShowLinkedIDs, &r.ShowExternalCredentials, &r.ArchiveRetentionDays, &r.UpdatedAt)
	return
}
func (s *Service) readProfile(ctx context.Context, tx pgx.Tx, id string) (Profile, error) {
	return scanProfile(tx.QueryRow(ctx, "SELECT "+profileColumns+" FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND a.endpoint=$2", id, s.Endpoint))
}

// EnsureProfileWithin consumes only an existing, unconsumed registration
// presentation on a genuinely inserted first profile. Existing user values are
// never overwritten, and deleting a profile cannot restore a consumed preset.
// There is deliberately no preset-writing API in this package.
func (s *Service) EnsureProfileWithin(ctx context.Context, tx pgx.Tx, accountID string, subjectType *string) (Profile, error) {
	var empty Profile
	if !uuidPattern.MatchString(accountID) || subjectType != nil && !subjectTypes[*subjectType] {
		return empty, unavailable()
	}
	var endpoint, issuer, subject string
	e := tx.QueryRow(ctx, "SELECT endpoint,issuer,external_subject FROM community_accounts WHERE id=$1", accountID).Scan(&endpoint, &issuer, &subject)
	if errors.Is(e, pgx.ErrNoRows) || e == nil && endpoint != s.Endpoint {
		return empty, unavailable()
	}
	if e != nil {
		return empty, e
	}
	if _, e = s.reserveAtWithin(ctx, tx, Identity{issuer, subject}, s.now()); e != nil {
		return empty, e
	}
	var name, avatar *string
	var bio string
	var revision int
	var adopted *time.Time
	e = tx.QueryRow(ctx, "SELECT display_name,avatar_key,bio,preset_revision,adopted_at FROM official_account_registrations_v1 WHERE account_id=$1 FOR UPDATE", accountID).Scan(&name, &avatar, &bio, &revision, &adopted)
	if e != nil {
		return empty, e
	}
	adopt := revision > 0 && adopted == nil
	if !adopt {
		name = nil
		avatar = nil
		bio = ""
	}
	var inserted string
	e = tx.QueryRow(ctx, `INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,avatar_key,bio,updated_at) SELECT id,$2::text,COALESCE($4::text,uid),$5::text,$6::text,$3::timestamptz FROM community_accounts WHERE id=$1 ON CONFLICT(account_id) DO NOTHING RETURNING account_id::text`, accountID, subjectType, s.now(), name, avatar, bio).Scan(&inserted)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return empty, e
	}
	if e == nil && adopt {
		if _, e = tx.Exec(ctx, "UPDATE official_account_registrations_v1 SET adopted_at=$2,display_name=NULL,avatar_key=NULL,bio='' WHERE account_id=$1", accountID, s.now()); e != nil {
			return empty, e
		}
	}
	r, e := s.readProfile(ctx, tx, accountID)
	if errors.Is(e, pgx.ErrNoRows) {
		return empty, unavailable()
	}
	return r, e
}
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
