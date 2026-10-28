package accounts

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type Object = map[string]any

func invalid() error { return fault.New("invalid_account_data", 400) }
func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r >= 0x2000 && r <= 0x200a || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff", r)
	})
}
func integer(raw json.RawMessage, min, max float64) (int64, error) {
	n, e := strconv.ParseFloat(string(raw), 64)
	if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < min || n > max {
		return 0, invalid()
	}
	return int64(n), nil
}
func required(fields map[string]json.RawMessage, keys ...string) bool {
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}
func nonnull(fields map[string]json.RawMessage, keys ...string) bool {
	for _, key := range keys {
		if raw, ok := fields[key]; ok && string(raw) == "null" {
			return false
		}
	}
	return true
}

var avatars = map[string]bool{"orbit": true, "camera": true, "book": true, "leaf": true, "mountain": true, "palette": true, "music": true, "sunrise": true}

type settingsUpdate struct {
	Revision            int64
	Name, Avatar        *string
	Bio                 string
	HasAvatar, HasBio   bool
	Enabled             bool
	Scope               string
	Linked, Credentials *bool
	Retention           *int
}

func parseSettings(raw []byte) (settingsUpdate, error) {
	var out settingsUpdate
	var fields map[string]json.RawMessage
	if protocol.Decode(raw, &fields) != nil || !required(fields, "expectedRevision", "displayName", "publicQuery", "archiveRetentionDays") || !nonnull(fields, "expectedRevision", "publicQuery", "bio") {
		return out, invalid()
	}
	var wire struct {
		Revision json.RawMessage `json:"expectedRevision"`
		Name     *string         `json:"displayName"`
		Avatar   *string         `json:"avatarKey"`
		Bio      string          `json:"bio"`
		Public   struct {
			Enabled     *bool  `json:"enabled"`
			Scope       string `json:"scope"`
			Linked      *bool  `json:"showLinkedIds"`
			Credentials *bool  `json:"showExternalCredentials"`
		} `json:"publicQuery"`
		Retention json.RawMessage `json:"archiveRetentionDays"`
	}
	if protocol.Decode(raw, &wire) != nil {
		return out, invalid()
	}
	var e error
	out.Revision, e = integer(wire.Revision, 0, 9007199254740991)
	if e != nil {
		return out, e
	}
	if wire.Name != nil {
		value := trim(*wire.Name)
		if protocol.TextLength(value) < 1 || protocol.TextLength(value) > 120 {
			return out, invalid()
		}
		out.Name = &value
	}
	out.Avatar = wire.Avatar
	if wire.Avatar != nil && !avatars[*wire.Avatar] {
		return out, invalid()
	}
	_, out.HasAvatar = fields["avatarKey"]
	_, out.HasBio = fields["bio"]
	out.Bio = trim(wire.Bio)
	if protocol.TextLength(out.Bio) > 500 {
		return out, invalid()
	}
	var public map[string]json.RawMessage
	if protocol.Decode(fields["publicQuery"], &public) != nil || !nonnull(public, "enabled", "scope", "showLinkedIds", "showExternalCredentials") || wire.Public.Enabled == nil || wire.Public.Scope != "profile" && wire.Public.Scope != "profile-and-public-posts" {
		return out, invalid()
	}
	out.Enabled = *wire.Public.Enabled
	out.Scope = wire.Public.Scope
	out.Linked = wire.Public.Linked
	out.Credentials = wire.Public.Credentials
	if string(wire.Retention) != "null" {
		value, e := integer(wire.Retention, 1, 36500)
		if e != nil {
			return out, e
		}
		n := int(value)
		out.Retention = &n
	}
	return out, nil
}
func (s *Service) SettingsWithin(ctx context.Context, tx pgx.Tx, accountID string) (Object, error) {
	row, e := s.EnsureProfileWithin(ctx, tx, accountID, nil)
	if e != nil {
		return nil, e
	}
	rows, e := tx.Query(ctx, "SELECT previous_type,next_type,revision,reason,basis,created_at FROM official_account_type_history_v1 WHERE account_id=$1 ORDER BY revision DESC LIMIT 100", accountID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	history := []Object{}
	for rows.Next() {
		var previous *string
		var next, reason, basis string
		var revision int64
		var at time.Time
		if e = rows.Scan(&previous, &next, &revision, &reason, &basis, &at); e != nil {
			return nil, e
		}
		history = append(history, Object{"previousType": previous, "nextType": next, "revision": revision, "reason": reason, "basis": basis, "createdAt": iso(at)})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	return Object{"accountId": accountID, "uid": row.UID, "subjectType": row.SubjectType, "displayName": row.DisplayName, "avatarKey": row.AvatarKey, "bio": row.Bio, "revision": row.Revision, "publicQuery": Object{"enabled": row.QueryEnabled, "scope": row.QueryScope, "showLinkedIds": row.ShowLinkedIDs, "showExternalCredentials": row.ShowExternalCredentials}, "archiveRetentionDays": row.ArchiveRetentionDays, "typeHistory": history}, nil
}
func (s *Service) UpdateSettingsWithin(ctx context.Context, tx pgx.Tx, accountID string, raw []byte) (Object, error) {
	data, e := parseSettings(raw)
	if e != nil {
		return nil, e
	}
	profile, e := s.EnsureProfileWithin(ctx, tx, accountID, nil)
	if e != nil {
		return nil, e
	}
	row, e := scanProfile(tx.QueryRow(ctx, "SELECT "+profileColumns+" FROM official_account_profiles_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE p.account_id=$1 AND a.endpoint=$2 FOR UPDATE OF p", accountID, s.Endpoint))
	if e != nil {
		return nil, e
	}
	if row.Revision != data.Revision {
		return nil, fault.New("account_settings_changed", 409)
	}
	name := profile.UID
	if data.Name != nil {
		name = *data.Name
	}
	linked, credentials := row.ShowLinkedIDs, row.ShowExternalCredentials
	if data.Linked != nil {
		linked = *data.Linked
	}
	if data.Credentials != nil {
		credentials = *data.Credentials
	}
	avatar, bio := row.AvatarKey, row.Bio
	if data.HasAvatar {
		avatar = data.Avatar
	}
	if data.HasBio {
		bio = data.Bio
	}
	_, e = tx.Exec(ctx, `UPDATE official_account_profiles_v1 SET display_name=$2,query_enabled=$3,query_scope=$4,archive_retention_days=$5,revision=revision+1,updated_at=$6,query_linked_ids=$7,query_external_credentials=$8,avatar_key=$9,bio=$10 WHERE account_id=$1`, accountID, name, data.Enabled, data.Scope, data.Retention, s.now(), linked, credentials, avatar, bio)
	if e != nil {
		return nil, e
	}
	// Retention preference follows original archive creation times. It does not
	// read/upload archive contents, create copies, or erase any other material.
	_, e = tx.Exec(ctx, "UPDATE private_conversation_archives_v1 SET expires_at=CASE WHEN $2::integer IS NULL THEN NULL ELSE created_at+($2::text||' days')::interval END WHERE account_id=$1", accountID, data.Retention)
	if e != nil {
		return nil, e
	}
	return Object{"accountId": accountID, "revision": row.Revision + 1}, nil
}
