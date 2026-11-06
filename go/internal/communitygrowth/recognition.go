package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
	"unicode/utf8"
)

func (s *Service) saveDefinition(ctx context.Context, tx pgx.Tx, x Object) (Object, error) {
	id := str(x, "id")
	if id == "" {
		id = uuid.NewString()
	}
	if _, e := uuid.Parse(id); e != nil {
		return nil, invalid()
	}
	name, description := str(x, "name"), str(x, "description")
	enabled, ok := x["enabled"].(bool)
	version, v := integer(x["expectedVersion"])
	if name == "" || utf8.RuneCountInString(name) > 200 || utf8.RuneCountInString(description) > 4000 || !ok || !v || version < 0 {
		return nil, invalid()
	}
	var next int64
	var e error
	if version == 0 {
		e = tx.QueryRow(ctx, `INSERT INTO community_growth_definitions_v1(endpoint,id,name,description,enabled,version,updated_at) VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT DO NOTHING RETURNING version`, s.Endpoint, id, name, description, enabled, s.now()).Scan(&next)
	} else {
		e = tx.QueryRow(ctx, `UPDATE community_growth_definitions_v1 SET name=$3,description=$4,enabled=$5,version=version+1,updated_at=$6 WHERE endpoint=$1 AND id=$2 AND version=$7 RETURNING version`, s.Endpoint, id, name, description, enabled, s.now(), version).Scan(&next)
	}
	if noRows(e) {
		return nil, fault.New("community_growth_version_conflict", 409)
	}
	if e != nil {
		return nil, e
	}
	return Object{"id": id, "version": next}, nil
}
func (s *Service) saveRecognition(ctx context.Context, tx pgx.Tx, a Actor, x Object) (Object, error) {
	id := str(x, "id")
	if id == "" {
		id = uuid.NewString()
	}
	account, kind, objectKind, objectID, domain, reason := str(x, "accountId"), str(x, "recognitionKind"), str(x, "objectKind"), str(x, "objectId"), str(x, "domain"), str(x, "reason")
	definition := str(x, "definitionId")
	active, ok := x["active"].(bool)
	version, v := integer(x["expectedVersion"])
	if _, e := uuid.Parse(id); e != nil {
		return nil, invalid()
	}
	if _, e := uuid.Parse(account); e != nil {
		return nil, invalid()
	}
	if _, e := uuid.Parse(objectID); e != nil {
		return nil, invalid()
	}
	if (kind != "content" && kind != "honor" && kind != "activity") || (objectKind != "post" && objectKind != "reply") || utf8.RuneCountInString(domain) > 200 || reason == "" || utf8.RuneCountInString(reason) > 4000 || !ok || !v || version < 0 {
		return nil, invalid()
	}
	if kind == "honor" {
		if _, e := uuid.Parse(definition); e != nil {
			return nil, invalid()
		}
	} else if definition != "" {
		return nil, invalid()
	}
	var exists bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)`, s.Endpoint, account).Scan(&exists); e != nil {
		return nil, e
	}
	if !exists {
		return nil, fault.New("community_growth_account_not_found", 404)
	}
	var q string
	if objectKind == "post" {
		q = `SELECT EXISTS(SELECT 1 FROM forum_posts_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE p.id=$1 AND a.endpoint=$2)`
	} else {
		q = `SELECT EXISTS(SELECT 1 FROM forum_replies_v1 p JOIN community_accounts a ON a.id=p.account_id WHERE p.id=$1 AND a.endpoint=$2)`
	}
	if e := tx.QueryRow(ctx, q, objectID, s.Endpoint).Scan(&exists); e != nil {
		return nil, e
	}
	if !exists {
		return nil, fault.New("community_growth_object_not_found", 404)
	}
	if kind == "honor" {
		needsEnabled := version == 0
		if version > 0 {
			var priorDefinition *string
			var priorActive bool
			e := tx.QueryRow(ctx, `SELECT definition_id::text,active FROM community_growth_recognitions_v1 WHERE endpoint=$1 AND id=$2 AND kind=$3 AND account_id=$4 AND object_kind=$5 AND object_id=$6 AND revision=$7 FOR UPDATE`, s.Endpoint, id, kind, account, objectKind, objectID, version).Scan(&priorDefinition, &priorActive)
			if noRows(e) {
				return nil, fault.New("community_growth_version_conflict", 409)
			}
			if e != nil {
				return nil, e
			}
			needsEnabled = priorDefinition == nil || *priorDefinition != definition || (!priorActive && active)
		}
		if needsEnabled {
			var enabled bool
			e := tx.QueryRow(ctx, `SELECT enabled FROM community_growth_definitions_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE`, s.Endpoint, definition).Scan(&enabled)
			if noRows(e) || (e == nil && !enabled) {
				return nil, fault.New("community_growth_definition_not_found", 404)
			}
			if e != nil {
				return nil, e
			}
		}
	}
	var next int64
	var e error
	var def any
	if definition != "" {
		def = definition
	}
	if version == 0 {
		e = tx.QueryRow(ctx, `INSERT INTO community_growth_recognitions_v1(endpoint,id,kind,account_id,definition_id,object_kind,object_id,domain,reason,active,revision,issued_by,updated_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11,$12,$12) ON CONFLICT DO NOTHING RETURNING revision`, s.Endpoint, id, kind, account, def, objectKind, objectID, domain, reason, active, a.ID, s.now()).Scan(&next)
	} else {
		e = tx.QueryRow(ctx, `UPDATE community_growth_recognitions_v1 SET reason=$8,domain=$7,active=$9,revision=revision+1,updated_by=$10,updated_at=$11,definition_id=$12::uuid WHERE endpoint=$1 AND id=$2 AND kind=$3 AND account_id=$4 AND object_kind=$5 AND object_id=$6 AND revision=$13 RETURNING revision`, s.Endpoint, id, kind, account, objectKind, objectID, domain, reason, active, a.ID, s.now(), def, version).Scan(&next)
	}
	if noRows(e) {
		return nil, fault.New("community_growth_version_conflict", 409)
	}
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_growth_recognition_history_v1(endpoint,recognition_id,revision,snapshot,operator_id,created_at) SELECT endpoint,id,revision,to_jsonb(r),$3,$4 FROM community_growth_recognitions_v1 r WHERE endpoint=$1 AND id=$2`, s.Endpoint, id, a.ID, s.now())
	if e != nil {
		return nil, e
	}
	{
		var createdAt time.Time
		if e = tx.QueryRow(ctx, `SELECT created_at FROM community_growth_recognitions_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, id).Scan(&createdAt); e != nil {
			return nil, e
		}
		rule := "recognition"
		sourceKind := "recognition"
		if kind == "honor" {
			rule = "honor"
			sourceKind = "honor"
		} else if kind == "activity" {
			rule = "activity"
			sourceKind = "activity"
		}
		domains := []string{}
		if domain != "" {
			domains = append(domains, domain)
		}
		e = s.RecordSourceWithin(ctx, tx, Source{Kind: sourceKind, ID: id, RuleKey: rule, AccountID: account, Domains: domains, Title: reason, ObjectKind: objectKind, ObjectID: objectID, Active: active, Revision: next, OccurredAt: createdAt})
		if e != nil {
			return nil, e
		}
	}
	return Object{"id": id, "revision": next}, nil
}
