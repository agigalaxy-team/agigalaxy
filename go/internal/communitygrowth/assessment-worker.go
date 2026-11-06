package communitygrowth

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

func (w *AssessmentWorker) Step(ctx context.Context) (Object, error) {
	s := w.Service
	if s == nil || s.Service == nil || s.CreateTaskWithin == nil || s.ReadSourceWithin == nil {
		return Object{"state": "not-connected"}, nil
	}
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	if e = s.lockConfigurationWithin(ctx, tx); e != nil {
		return nil, e
	}
	if e = s.ensureAssessment(ctx, tx); e != nil {
		return nil, e
	}
	var enabled bool
	var configVersion int64
	var configuration Object
	var purposes []string
	e = tx.QueryRow(ctx, `SELECT enabled,version,purposes,jsonb_build_object('version',version,'instructions',instructions,'executorConfigId',executor_config_id)
		FROM community_assessment_config_v1 WHERE endpoint=$1`, s.Endpoint).Scan(&enabled, &configVersion, &purposes, &configuration)
	if e != nil {
		return nil, e
	}
	if !enabled {
		return Object{"state": "disabled"}, tx.Commit(ctx)
	}
	if s.TaskStatusWithin != nil {
		var id string
		e = tx.QueryRow(ctx, `SELECT task_id::text FROM community_assessment_scopes_v1 WHERE endpoint=$1 AND state='running' AND next_attempt_at<=$2
			ORDER BY next_attempt_at,updated_at LIMIT 1 FOR UPDATE SKIP LOCKED`, s.Endpoint, s.now()).Scan(&id)
		if e != nil && !noRows(e) {
			return nil, e
		}
		if e == nil {
			state, e := s.TaskStatusWithin(ctx, tx, id)
			if e != nil {
				return nil, e
			}
			if state == "completed" || state == "failed" || state == "cancelled" || state == "stopped" {
				// No result-save receipt was adopted: native completion alone
				// cannot establish an AI weight. Keep historical results intact.
				if _, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET state='failed',last_error='community_assessment_result_not_saved',next_attempt_at=$3,updated_at=$2
					WHERE endpoint=$1 AND task_id=$4 AND state='running'`, s.Endpoint, s.now(), s.now().Add(5*time.Minute), id); e != nil {
					return nil, e
				}
				if _, e = tx.Exec(ctx, `UPDATE community_assessment_tasks_v1 SET state='failed',updated_at=$3 WHERE endpoint=$1 AND id=$2 AND state IN ('queued','running')`, s.Endpoint, id, s.now()); e != nil {
					return nil, e
				}
			} else if _, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET next_attempt_at=$3 WHERE endpoint=$1 AND task_id=$2`, s.Endpoint, id, s.now().Add(time.Minute)); e != nil {
				return nil, e
			}
		}
	}
	var task AssessmentTask
	e = tx.QueryRow(ctx, `SELECT account_id::text,domain,purpose,input_revision FROM community_assessment_scopes_v1
		WHERE endpoint=$1 AND purpose=ANY($3::text[]) AND state IN ('pending','failed') AND next_attempt_at<=$2 ORDER BY next_attempt_at,updated_at
		LIMIT 1 FOR UPDATE SKIP LOCKED`, s.Endpoint, s.now(), purposes).Scan(&task.AccountID, &task.Domain, &task.Purpose, &task.InputRevision)
	if noRows(e) {
		return Object{"state": "idle"}, tx.Commit(ctx)
	}
	if e != nil {
		return nil, e
	}
	// Bind only this calculation's human-authored purpose text. The other
	// purposes' instructions never enter this task's snapshot or tool context.
	var purposeInstruction string
	if e = tx.QueryRow(ctx, `SELECT COALESCE(instructions_by_purpose->>$2,'') FROM community_assessment_config_v1 WHERE endpoint=$1`, s.Endpoint, task.Purpose).Scan(&purposeInstruction); e != nil {
		return nil, e
	}
	configuration["purposeInstruction"] = purposeInstruction
	task.ID, task.ConfigVersion, task.Configuration = uuid.NewString(), configVersion, configuration
	// The same source and calculation configuration reuse their original task,
	// including failures. A retry is an explicit source/config refresh rather
	// than an unbounded stream of new model runs after a failed native task.
	var original string
	e = tx.QueryRow(ctx, `SELECT id::text FROM community_assessment_tasks_v1 WHERE endpoint=$1 AND account_id=$2 AND domain=$3 AND purpose=$4 AND input_revision=$5 AND config_version=$6`, s.Endpoint, task.AccountID, task.Domain, task.Purpose, task.InputRevision, task.ConfigVersion).Scan(&original)
	if e == nil {
		if _, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET state='failed',last_error='community_assessment_original_task_failed',next_attempt_at=$6,updated_at=$5
			WHERE endpoint=$1 AND account_id=$2 AND domain=$3 AND purpose=$4`, s.Endpoint, task.AccountID, task.Domain, task.Purpose, s.now(), s.now().Add(5*time.Minute)); e != nil {
			return nil, e
		}
		return Object{"state": "failed", "taskId": original}, tx.Commit(ctx)
	}
	if !noRows(e) {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_assessment_tasks_v1(endpoint,id,account_id,domain,purpose,input_revision,config_version,configuration,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, s.Endpoint, task.ID, task.AccountID, task.Domain, task.Purpose, task.InputRevision, task.ConfigVersion, jsonText(configuration), s.now())
	if e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `INSERT INTO community_assessment_materials_v1(endpoint,task_id,source_key,source_kind,source_id,source_revision,snapshot)
		SELECT $1,$2,jsonb_build_array(source_kind,source_id)::text,source_kind,source_id,max(revision),
		jsonb_build_object('accountId',$3::uuid,'sourceKind',source_kind,'sourceId',source_id,'sourceRevision',max(revision),'title',min(title),'objectKind',min(object_kind),'objectId',min(object_id),
		'firstOccurredAt',min(occurred_at),'lastOccurredAt',max(occurred_at),'ruleKeys',jsonb_agg(DISTINCT rule_key))
		FROM community_growth_sources_v1 WHERE endpoint=$1 AND account_id=$3 AND active AND ($4=ANY(domains) OR $4='unclassified' AND cardinality(domains)=0)
		AND (source_kind<>'evaluation' OR $5='evaluation-reference')
		GROUP BY source_kind,source_id`, s.Endpoint, task.ID, task.AccountID, task.Domain, task.Purpose)
	if e != nil {
		return nil, e
	}
	nativeID, e := s.CreateTaskWithin(ctx, tx, task)
	if e != nil {
		return nil, e
	}
	if nativeID != task.ID {
		return nil, fmt.Errorf("community assessment task binding mismatch")
	}
	if _, e = tx.Exec(ctx, `UPDATE community_assessment_tasks_v1 SET native_task_id=$2,state='running',updated_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, task.ID, s.now()); e != nil {
		return nil, e
	}
	_, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 SET state='running',task_id=$5,last_error=NULL,next_attempt_at=$6,updated_at=$7 WHERE endpoint=$1 AND account_id=$2 AND domain=$3 AND purpose=$4`, s.Endpoint, task.AccountID, task.Domain, task.Purpose, task.ID, s.now().Add(time.Minute), s.now())
	if e != nil {
		return nil, e
	}
	return Object{"state": "queued", "taskId": task.ID}, tx.Commit(ctx)
}
