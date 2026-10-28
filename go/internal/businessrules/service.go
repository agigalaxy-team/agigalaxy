// Package businessrules applies the existing published P14 write gate. It
// evaluates facts inside the caller's authorized transaction, never grants
// object access and never fetches links, executes code, or invokes a model.
package businessrules

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
)

type Object = map[string]any
type Input struct {
	AccountID, Target, OperationRef, Stage string
	Text                                   *string
	Links                                  []any
	AttachmentCount, FileBytes             *int64
}
type Service struct {
	Endpoint      string
	PromotionDays int
	Now           func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}
func fail(code string, status int) error { return fault.New(code, status) }
func str(o Object, k string) string      { v, _ := o[k].(string); return v }
func obj(o Object, k string) Object      { v, _ := o[k].(map[string]any); return v }
func truth(o Object, k string) bool      { v, _ := o[k].(bool); return v }
func asString(v any) string              { s, _ := v.(string); return s }
func num(o Object, k string) int64 {
	switch n := o[k].(type) {
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	case json.Number:
		v, _ := n.Int64()
		return v
	}
	return 0
}
func int64Number(v any) int64 { return num(Object{"v": v}, "v") }
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var o Object
	e = json.Unmarshal(raw, &o)
	return o, e
}
func (s *Service) EnforceWithin(ctx context.Context, tx pgx.Tx, input Input) (Object, error) {
	if input.Stage == "" {
		input.Stage = "write"
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", s.Endpoint+":operations-rule:business-controls"); e != nil {
		return nil, e
	}
	current, e := row(ctx, tx, "SELECT to_jsonb(r) FROM operations_product_rules_v1 r WHERE endpoint=$1 AND policy_key='business-controls' ORDER BY version DESC LIMIT 1", s.Endpoint)
	if e != nil {
		return nil, e
	}
	if current == nil {
		return nil, fail("operations_rules_unavailable", 503)
	}
	owner, e := row(ctx, tx, "SELECT to_jsonb(a)||jsonb_build_object('subject_type',p.subject_type) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2", input.AccountID, s.Endpoint)
	if e != nil {
		return nil, e
	}
	if owner == nil {
		return nil, fail("account_target_unavailable", 403)
	}
	tier := str(owner, "tier_override")
	if tier == "" {
		tier = "new"
		days := s.PromotionDays
		if days == 0 {
			days = 7
		}
		created, _ := time.Parse(time.RFC3339Nano, str(owner, "created_at"))
		if created.Unix()+int64(days)*86400 <= s.now().Unix() {
			var interaction bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_interactions WHERE account_id=$1 AND invalidated_at IS NULL)", input.AccountID).Scan(&interaction); e != nil {
				return nil, e
			}
			if interaction {
				tier = "normal"
			}
		}
	}
	facts := Object{"accountTier": tier, "subjectType": owner["subject_type"]}
	if input.AttachmentCount != nil {
		facts["attachmentCount"] = *input.AttachmentCount
	}
	if input.FileBytes != nil {
		facts["fileBytes"] = *input.FileBytes
	}
	evaluation, e := Evaluate(obj(current, "policy"), input.Target, input.AccountID, facts, input.Text, input.Links)
	if e != nil {
		return nil, e
	}
	if evaluation.Outcome != "allow" {
		if !evaluation.Enabled {
			return nil, fail("operations_feature_disabled", 409)
		}
		if evaluation.Outcome == "unknown" {
			return nil, fail("operations_rule_facts_unavailable", 503)
		}
		return nil, fail("operations_rule_rejected", 409)
	}
	if input.OperationRef != "" && (input.Stage == "write" || input.Stage == "upload-bytes") {
		_, e = tx.Exec(ctx, `INSERT INTO operations_p14_rule_decisions_v1(id,endpoint,target,operation_ref,stage,policy_version,matched_rule_ids,exception_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(endpoint,target,operation_ref,stage) DO NOTHING`, uuid.NewString(), s.Endpoint, input.Target, input.OperationRef, input.Stage, current["version"], evaluation.Matched, evaluation.Exceptions, s.now())
		if e != nil {
			return nil, e
		}
	}
	return Object{"version": current["version"], "outcome": evaluation.Outcome, "exceptionIds": evaluation.Exceptions}, nil
}
