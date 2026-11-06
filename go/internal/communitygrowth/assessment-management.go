package communitygrowth

import (
	"context"
	"encoding/base64"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *AssessmentService) assessmentManager(ctx context.Context, tx pgx.Tx, actor Actor, permission string) (Actor, error) {
	fresh, e := s.require(ctx, tx, actor, permission)
	if e != nil {
		return fresh, e
	}
	if fresh.AIProof != nil || s.Authority.Duty != nil && s.Authority.Duty.AcceptsDuty(fresh) || s.Authority.Execution != nil && s.Authority.Execution.AcceptsExecution(fresh) {
		return fresh, fault.New("business_admin_denied", 403)
	}
	return fresh, nil
}

func (s *AssessmentService) configurationWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	var out Object
	e := tx.QueryRow(ctx, `SELECT jsonb_build_object('version',version,'enabled',enabled,'instructions',instructions,'purposeInstructions',instructions_by_purpose,'purposes',purposes,'executorConfigId',executor_config_id)
		FROM community_assessment_config_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&out)
	return out, e
}

func (s *AssessmentService) Configuration(ctx context.Context, actor Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.assessmentManager(ctx, tx, actor, "autonomy.read"); e != nil {
			return nil, e
		}
		if e := s.ensureAssessment(ctx, tx); e != nil {
			return nil, e
		}
		return s.configurationWithin(ctx, tx)
	})
}

var assessmentPurposePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,79}$`)

func (s *AssessmentService) SaveConfiguration(ctx context.Context, actor Actor, input Object) (Object, error) {
	allowed := map[string]bool{"kind": true, "operationId": true, "expectedVersion": true, "enabled": true, "instructions": true, "purposes": true, "executorConfigId": true, "purposeInstructions": true}
	for key := range allowed {
		if _, present := input[key]; !present && key != "purposeInstructions" {
			return nil, invalid()
		}
	}
	for key := range input {
		if !allowed[key] {
			return nil, invalid()
		}
	}
	op := str(input, "operationId")
	if _, e := uuid.Parse(op); e != nil || str(input, "kind") != "assessment-config-save" {
		return nil, invalid()
	}
	version, ok := integer(input["expectedVersion"])
	enabled, b := input["enabled"].(bool)
	instructions, text := input["instructions"].(string)
	var purposeInstructions Object
	_, updatePurposeInstructions := input["purposeInstructions"]
	if updatePurposeInstructions {
		if e := assessmentDecode(input["purposeInstructions"], &purposeInstructions); e != nil || purposeInstructions == nil {
			return nil, invalid()
		}
		for purpose, value := range purposeInstructions {
			instruction, ok := value.(string)
			if purpose != "contribution-impact" && purpose != "evaluation-reference" || !ok || utf8.RuneCountInString(instruction) > 16000 {
				return nil, invalid()
			}
		}
	}
	var purposes []string
	if e := assessmentDecode(input["purposes"], &purposes); e != nil {
		return nil, e
	}
	if !ok || version < 1 || !b || !text || utf8.RuneCountInString(instructions) > 16000 || enabled && strings.TrimSpace(instructions) == "" || len(purposes) < 1 {
		return nil, invalid()
	}
	seen := map[string]bool{}
	var executor *string
	if id := str(input, "executorConfigId"); id != "" {
		if _, e := uuid.Parse(id); e != nil {
			return nil, invalid()
		}
		executor = &id
	} else if input["executorConfigId"] != nil || enabled {
		return nil, invalid()
	}
	for _, purpose := range purposes {
		if !assessmentPurposePattern.MatchString(purpose) || seen[purpose] {
			return nil, invalid()
		}
		seen[purpose] = true
	}
	canonical, e := identity.Canonical(input)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(canonical)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		fresh, e := s.assessmentManager(ctx, tx, actor, "autonomy.configure")
		if e != nil {
			return nil, e
		}
		if e = s.lockConfigurationWithin(ctx, tx); e != nil {
			return nil, e
		}
		if e = s.ensureAssessment(ctx, tx); e != nil {
			return nil, e
		}
		if executor != nil {
			var exists bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_autonomy_configs_v1 WHERE endpoint=$1 AND id=$2 AND domain='discovery')`, s.Endpoint, *executor).Scan(&exists); e != nil {
				return nil, e
			}
			if !exists {
				return nil, fault.New("community_assessment_executor_unavailable", 409)
			}
		}
		// Use the shared original operation ledger, with its normal lock key.
		if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912765))`, s.Endpoint+":"+op); e != nil {
			return nil, e
		}
		var priorHash, owner, kind string
		var prior Object
		e = tx.QueryRow(ctx, `SELECT request_hash,actor_id,kind,result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op).Scan(&priorHash, &owner, &kind, &prior)
		if e == nil {
			if priorHash != hash || owner != fresh.ID || kind != "assessment-config-save" {
				return nil, fault.New("community_growth_operation_conflict", 409)
			}
			prior["replayed"] = true
			return prior, nil
		}
		if !noRows(e) {
			return nil, e
		}
		var current int64
		if e = tx.QueryRow(ctx, `SELECT version FROM community_assessment_config_v1 WHERE endpoint=$1 FOR UPDATE`, s.Endpoint).Scan(&current); e != nil {
			return nil, e
		}
		if current != version {
			return nil, fault.New("community_growth_version_conflict", 409)
		}
		// Preserve the old human configuration before writing its successor.
		before, e := s.configurationWithin(ctx, tx)
		if e != nil {
			return nil, e
		}
		// An older client omitting this field must not erase human-authored
		// purpose instructions. An explicitly empty object clears the map.
		if !updatePurposeInstructions {
			if e = assessmentDecode(before["purposeInstructions"], &purposeInstructions); e != nil {
				return nil, e
			}
			if purposeInstructions == nil {
				purposeInstructions = Object{}
			}
		}
		if _, e = tx.Exec(ctx, `INSERT INTO community_assessment_config_history_v1(endpoint,version,snapshot,updated_by,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, s.Endpoint, current, jsonText(before), fresh.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE community_assessment_config_v1 SET version=version+1,enabled=$2,instructions=$3,purposes=$4,updated_by=$5,updated_at=$6,executor_config_id=$7,instructions_by_purpose=$8 WHERE endpoint=$1`, s.Endpoint, enabled, instructions, purposes, fresh.ID, s.now(), executor, jsonText(purposeInstructions)); e != nil {
			return nil, e
		}
		configuration, e := s.configurationWithin(ctx, tx)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO community_assessment_config_history_v1(endpoint,version,snapshot,updated_by,created_at) VALUES($1,$2,$3,$4,$5)`, s.Endpoint, version+1, jsonText(configuration), fresh.ID, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET input_revision=input_revision+1,task_id=NULL,state='pending',next_attempt_at=$2,last_error=NULL,updated_at=$2 WHERE endpoint=$1`, s.Endpoint, s.now()); e != nil {
			return nil, e
		}
		// New purposes apply to existing attributable community sources too.
		_, e = tx.Exec(ctx, `INSERT INTO community_assessment_scopes_v1(endpoint,account_id,domain,purpose,next_attempt_at,updated_at)
			SELECT DISTINCT $1,x.account_id,d.domain,p.purpose,$3::timestamptz,$3::timestamptz FROM community_growth_sources_v1 x
			CROSS JOIN LATERAL unnest(CASE WHEN cardinality(x.domains)=0 THEN ARRAY['unclassified']::text[] ELSE x.domains END) d(domain)
			CROSS JOIN LATERAL unnest($2::text[]) p(purpose) WHERE x.endpoint=$1 AND x.active ON CONFLICT DO NOTHING`, s.Endpoint, purposes, s.now())
		if e != nil {
			return nil, e
		}
		result := Object{"operationId": op, "replayed": false, "configuration": configuration}
		_, e = tx.Exec(ctx, `INSERT INTO community_growth_operations_v1(endpoint,operation_id,actor_id,kind,request_hash,result,created_at) VALUES($1,$2,$3,'assessment-config-save',$4,$5,$6)`, s.Endpoint, op, fresh.ID, hash, jsonText(result), s.now())
		return result, e
	})
}

func (s *AssessmentService) ConfigurationReceipt(ctx context.Context, actor Actor, operationID string) (Object, error) {
	if _, e := uuid.Parse(operationID); e != nil {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.assessmentManager(ctx, tx, actor, "autonomy.read"); e != nil {
			return nil, e
		}
		var result Object
		e := tx.QueryRow(ctx, `SELECT result FROM community_growth_operations_v1 WHERE endpoint=$1 AND operation_id=$2 AND kind='assessment-config-save'`, s.Endpoint, operationID).Scan(&result)
		if noRows(e) {
			return Object{"state": "not-recorded", "operationId": operationID}, nil
		}
		return Object{"state": "recorded", "operationId": operationID, "result": result}, e
	})
}

func (s *AssessmentService) QueryWeights(ctx context.Context, actor Actor, input Object) (Object, error) {
	account, domain, purpose := str(input, "accountId"), str(input, "domain"), str(input, "purpose")
	if _, e := uuid.Parse(account); e != nil {
		return nil, invalid()
	}
	limit := int64(30)
	if value, ok := input["limit"]; ok {
		var valid bool
		limit, valid = integer(value)
		if !valid || limit < 1 || limit > 100 {
			return nil, invalid()
		}
	}
	var after string
	if encoded := str(input, "after"); encoded != "" {
		raw, e := base64.RawURLEncoding.DecodeString(encoded)
		if e != nil || len(raw) > 2000 {
			return nil, invalid()
		}
		after = string(raw)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.assessmentManager(ctx, tx, actor, "autonomy.read"); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `SELECT jsonb_build_object('accountId',x.account_id,'domain',x.domain,'purpose',x.purpose,'inputRevision',x.input_revision,'appliedRevision',x.applied_revision,
			'state',x.state,'taskId',x.task_id,'lastError',x.last_error,'updatedAt',x.updated_at,'result',CASE WHEN c.enabled AND c.version=r.config_version THEN
			jsonb_build_object('id',r.id,'taskId',r.task_id,'inputRevision',r.input_revision,'configVersion',r.config_version,'status',r.status,'value',r.value,'coverage',r.coverage,
			'reason',r.reason,'evidence',r.evidence,'missing',r.missing,'modelVersion',r.model_version,'promptVersion',r.prompt_version,'createdAt',r.created_at) ELSE NULL END),jsonb_build_array(x.domain,x.purpose)::text
			FROM community_assessment_scopes_v1 x LEFT JOIN community_assessment_results_v1 r ON r.endpoint=x.endpoint AND r.id=x.current_result_id
			JOIN community_assessment_config_v1 c ON c.endpoint=x.endpoint
			WHERE x.endpoint=$1 AND x.account_id=$2 AND ($3='' OR x.domain=$3) AND ($4='' OR x.purpose=$4) AND jsonb_build_array(x.domain,x.purpose)::text>$5
			ORDER BY jsonb_build_array(x.domain,x.purpose)::text LIMIT $6`, s.Endpoint, account, domain, purpose, after, limit+1)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		items := []Object{}
		keys := []string{}
		for rows.Next() {
			var item Object
			var key string
			if e = rows.Scan(&item, &key); e != nil {
				return nil, e
			}
			items, keys = append(items, item), append(keys, key)
		}
		if e = rows.Err(); e != nil {
			return nil, e
		}
		rows.Close()
		var next any
		if len(items) > int(limit) {
			items = items[:limit]
			next = base64.RawURLEncoding.EncodeToString([]byte(keys[limit-1]))
		}
		for _, item := range items {
			result := assessmentObject(item["result"])
			if result == nil || str(result, "status") != "assessed" {
				continue
			}
			var refs []AssessmentEvidence
			if e = assessmentDecode(result["evidence"], &refs); e != nil {
				return nil, e
			}
			valid, e := s.assessmentEvidenceCurrentWithin(ctx, tx, str(result, "taskId"), refs)
			if e != nil {
				return nil, e
			}
			if !valid {
				item["result"] = nil
				item["state"] = "source-unavailable"
			}
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
