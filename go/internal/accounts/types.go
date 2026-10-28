package accounts

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type TypeSource struct{ Kind, AccountID, OperatorID, Endpoint string }
type OperatorAuthorizer func(context.Context, pgx.Tx, string, string) error

func (s *Service) ChangeTypeWithin(ctx context.Context, tx pgx.Tx, accountID string, raw []byte, source TypeSource, authorize OperatorAuthorizer) (Object, error) {
	var fields map[string]json.RawMessage
	var x struct {
		Expected json.RawMessage `json:"expectedRevision"`
		Type     string          `json:"subjectType"`
		Reason   string          `json:"reason"`
		Basis    string          `json:"basis"`
		Preserve *bool           `json:"preserveHistory"`
	}
	if protocol.Decode(raw, &fields) != nil || protocol.Decode(raw, &x) != nil || !nonnull(fields, "expectedRevision", "subjectType", "reason", "basis", "preserveHistory") || x.Preserve == nil || !*x.Preserve || !subjectTypes[x.Type] {
		return nil, invalid()
	}
	revision, e := integer(x.Expected, 0, 9007199254740991)
	if e != nil {
		return nil, e
	}
	x.Reason = trim(x.Reason)
	x.Basis = trim(x.Basis)
	if protocol.TextLength(x.Reason) < 8 || protocol.TextLength(x.Reason) > 2000 || protocol.TextLength(x.Basis) < 8 || protocol.TextLength(x.Basis) > 4000 {
		return nil, invalid()
	}
	owner := source.Kind == "account-owner" && source.AccountID == accountID
	operator := source.Kind == "business-operator" && source.Endpoint == s.Endpoint && source.OperatorID != ""
	if !owner && !operator {
		return nil, fault.New("business_admin_denied", 403)
	}
	if operator {
		if authorize == nil {
			return nil, fault.New("operations_authorization_unavailable", 503)
		}
		if e = authorize(ctx, tx, source.OperatorID, "accounts.type.change"); e != nil {
			return nil, e
		}
	}
	var id string
	e = tx.QueryRow(ctx, "SELECT id::text FROM community_accounts WHERE id=$1 AND endpoint=$2 FOR UPDATE", accountID, s.Endpoint).Scan(&id)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, fault.New("not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	if _, e = s.EnsureProfileWithin(ctx, tx, accountID, nil); e != nil {
		return nil, e
	}
	var previous *string
	var current int64
	e = tx.QueryRow(ctx, "SELECT subject_type,revision FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE", accountID).Scan(&previous, &current)
	if e != nil {
		return nil, e
	}
	if current != revision {
		return nil, fault.New("account_settings_changed", 409)
	}
	if previous != nil && *previous == x.Type {
		return nil, fault.New("account_type_unchanged", 409)
	}
	var operatorID any
	if operator {
		operatorID = source.OperatorID
	}
	actor := "account-owner"
	basisKind := "account-owner-statement"
	if operator {
		actor = "business-operator"
		basisKind = "operator-recorded-statement"
	}
	at := s.now()
	_, e = tx.Exec(ctx, `INSERT INTO official_account_type_history_v1(id,account_id,revision,previous_type,next_type,reason,basis,created_at,actor_kind,operator_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, uuid.NewString(), accountID, current+1, previous, x.Type, x.Reason, x.Basis, at, actor, operatorID)
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, "UPDATE official_account_profiles_v1 SET subject_type=$2,revision=$3,updated_at=$4 WHERE account_id=$1", accountID, x.Type, current+1, at)
	if e != nil {
		return nil, e
	}
	return Object{"accountId": accountID, "previousType": previous, "subjectType": x.Type, "revision": current + 1, "basisKind": basisKind, "permissionsChanged": false}, nil
}
