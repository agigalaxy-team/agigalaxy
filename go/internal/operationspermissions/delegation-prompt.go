package operationspermissions

import (
	"context"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func parsePrompt(input Object, write bool) (Object, error) {
	x := obj(clone(input))
	required := []string{"aiAccountId"}
	if write {
		required = append(required, "operationId", "expectedRevision", "expectedPromptVersion", "prompt")
	}
	if !exact(x, required, nil) || !validUUID(x["aiAccountId"]) {
		return nil, invalid()
	}
	if write {
		if !validUUID(x["operationId"]) || !intOK(x["expectedRevision"], 1) || !intOK(x["expectedPromptVersion"], 1) {
			return nil, invalid()
		}
		p, ok := x["prompt"].(string)
		if !ok || utf8.RuneCountInString(p) > 16000 {
			return nil, invalid()
		}
	}
	return x, nil
}
func promptMetadata(account, row Object) Object {
	return Object{"aiAccountId": account["id"], "domain": account["domain"], "name": account["name"], "configId": row["id"], "revision": row["revision"], "promptVersion": row["prompt_version"], "updatedAt": stamp(row["updated_at"])}
}
func (s *Service) promptTarget(ctx context.Context, tx pgx.Tx, current delegatedCurrent, id string, lock bool) (Object, Object, error) {
	if id == current.Source || !contains(stringsOf(current.Row["target_ai_account_ids"]), id) {
		return nil, nil, fail("operations_ai_delegation_target_denied", 403)
	}
	account, e := s.aiAccount(ctx, tx, id)
	if e != nil {
		return nil, nil, e
	}
	query := "SELECT to_jsonb(c) FROM operations_autonomy_configs_v1 c WHERE endpoint=$1 AND domain=$2"
	if lock {
		query += " FOR UPDATE"
	}
	row, e := one(ctx, tx, query, s.Endpoint, account["domain"])
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil, fail("operations_autonomy_config_not_found", 404)
	}
	return account, row, e
}
func (s *Service) DelegatedPrompt(ctx context.Context, actor Actor, input Object) (Object, error) {
	x, e := parsePrompt(input, false)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, "prompt-read", nil)
		if e != nil {
			return nil, e
		}
		account, row, e := s.promptTarget(ctx, tx, current, str(x["aiAccountId"]), false)
		if e != nil {
			return nil, e
		}
		version := num(current.Row["version"])
		if _, e = s.delegatedCurrentWithin(ctx, tx, actor, "prompt-read", &version); e != nil {
			return nil, e
		}
		at := time.Unix(s.now(), 0)
		role, audit, e := s.delegatedAudit(current.Actor)
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,selection,result,created_at,actor_kind,actor_context) VALUES($1,$2,$3,$4,'ai-prompt-read',$5,$6,$7,$8,$9)`, uuid.NewString(), s.Endpoint, current.Actor.ID, role, jsonText(Object{"delegationId": current.Row["id"], "delegationVersion": current.Row["version"], "sourceAiAccountId": current.Source, "aiAccountId": account["id"]}), jsonText(Object{"revision": row["revision"], "promptVersion": row["prompt_version"]}), at, s.delegatedActorKind(current.Actor), audit)
		if e != nil {
			return nil, e
		}
		prompt := promptMetadata(account, row)
		text := obj(row["configuration"])["prompt"]
		if text == nil {
			text = ""
		}
		prompt["text"] = text
		return Object{"prompt": prompt, "delegationVersion": current.Row["version"], "scope": "role-work-requirements", "instructionAuthority": "role-work-requirements-with-fixed-code-boundaries", "checkedAt": s.now(), "readExpiresAt": s.now() + 30}, nil
	})
}
func (s *Service) DelegatedPromptSave(ctx context.Context, actor Actor, input Object, options DelegatedOptions) (Object, error) {
	x, e := parsePrompt(input, true)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912410))", s.Endpoint); e != nil {
			return nil, e
		}
		current, e := s.delegatedCurrentWithin(ctx, tx, actor, "prompt-update", options.ExpectedDelegationVersion)
		if e != nil {
			return nil, e
		}
		if replay, e := s.delegatedReplay(ctx, tx, current.Actor, str(x["operationId"]), "prompt-save", x); e != nil || replay != nil {
			return replay, e
		}
		account, old, e := s.promptTarget(ctx, tx, current, str(x["aiAccountId"]), true)
		if e != nil {
			return nil, e
		}
		if num(old["revision"]) != num(x["expectedRevision"]) || num(old["prompt_version"]) != num(x["expectedPromptVersion"]) {
			return nil, fail("operations_ai_prompt_version_changed", 409)
		}
		configuration := obj(clone(old["configuration"]))
		previous := configuration["prompt"]
		if previous == nil {
			previous = ""
		}
		if previous == x["prompt"] {
			return nil, fail("operations_ai_prompt_no_change", 409)
		}
		configuration["prompt"] = x["prompt"]
		at := time.Unix(s.now(), 0)
		humanWriter, aiWriter := s.delegatedWriters(current)
		row, e := one(ctx, tx, `UPDATE operations_autonomy_configs_v1 SET configuration=$3,revision=revision+1,prompt_version=prompt_version+1,updated_by=$4,updated_by_ai_account_id=$5,updated_at=$6 WHERE endpoint=$1 AND id=$2 AND revision=$7 AND prompt_version=$8 RETURNING to_jsonb(operations_autonomy_configs_v1)`, s.Endpoint, old["id"], jsonText(configuration), humanWriter, aiWriter, at, x["expectedRevision"], x["expectedPromptVersion"])
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, fail("operations_ai_prompt_version_changed", 409)
		}
		if e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_autonomy_versions_v1(config_id,revision,configuration,prompt_version,plan_version,delegation_version,operator_id,created_at,managed_by_ai_account_id,management_operation_id,management_delegation_id,management_delegation_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, row["id"], row["revision"], jsonText(row["configuration"]), row["prompt_version"], row["plan_version"], row["delegation_version"], humanWriter, at, aiWriter, x["operationId"], current.Row["id"], current.Row["version"])
		if e != nil {
			return nil, e
		}
		version := num(current.Row["version"])
		if _, e = s.delegatedCurrentWithin(ctx, tx, current.Actor, "prompt-update", &version); e != nil {
			return nil, e
		}
		return s.delegatedRecord(ctx, tx, current, str(x["operationId"]), "prompt-save", x, Object{"prompt": promptMetadata(account, row)})
	})
}
