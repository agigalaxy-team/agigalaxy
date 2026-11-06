package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// EraseSubjectSourcesWithin removes derived copies of this GUID's forum
// content only. It does not infer ownership of an associated account.
// The approved lifecycle transaction must call this before subject locators
// on the forum rows are minimized.
func (s *Service) EraseSubjectSourcesWithin(ctx context.Context, tx pgx.Tx, subject string) (Object, error) {
	return s.EraseSubjectSourcesWithTasksWithin(ctx, tx, subject, nil)
}

// EraseSubjectSourcesWithTasksWithin keeps source and task-copy minimization
// in the approved lifecycle transaction. The callback is supplied by the
// original autonomy owner, avoiding a second task ledger or reverse import.
func (s *Service) EraseSubjectSourcesWithTasksWithin(ctx context.Context, tx pgx.Tx, subject string, minimizeTasks func(context.Context, pgx.Tx, []string) (Object, error)) (Object, error) {
	if subject == "" || s.Endpoint == "" {
		return nil, invalid()
	}
	taskRows, e := tx.Query(ctx, `SELECT DISTINCT m.task_id::text FROM community_assessment_materials_v1 m
	 JOIN community_assessment_tasks_v1 a ON a.endpoint=m.endpoint AND a.id=m.task_id
	 WHERE m.endpoint=$1 AND ((m.snapshot->>'objectKind'='post' AND EXISTS(SELECT 1 FROM forum_posts_v1 p WHERE p.id::text=m.snapshot->>'objectId' AND (p.subject_id=$2 OR EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.post_id=p.id AND v.subject_id=$2)))) OR (m.snapshot->>'objectKind'='reply' AND EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.id::text=m.snapshot->>'objectId' AND r.subject_id=$2))) ORDER BY m.task_id::text`, s.Endpoint, subject)
	if e != nil {
		return nil, e
	}
	taskIDs := []string{}
	for taskRows.Next() {
		var id string
		if e = taskRows.Scan(&id); e != nil {
			taskRows.Close()
			return nil, e
		}
		taskIDs = append(taskIDs, id)
	}
	e = taskRows.Err()
	taskRows.Close()
	if e != nil {
		return nil, e
	}
	taskCopies := Object{}
	if len(taskIDs) > 0 {
		if minimizeTasks == nil {
			return nil, fault.New("community_assessment_lifecycle_not_connected", 503)
		}
		// Task locks precede scope/source invalidation, matching the result
		// writer's authorization order and fencing already-admitted writers.
		taskCopies, e = minimizeTasks(ctx, tx, taskIDs)
		if e != nil {
			return nil, e
		}
	}
	rows, e := tx.Query(ctx, `SELECT x.source_kind,x.source_id,x.rule_key,x.account_id::text,x.domains,x.title,x.object_kind,x.object_id,x.active,x.revision,x.occurred_at
 FROM community_growth_sources_v1 x WHERE x.endpoint=$1 AND ((x.object_kind='post' AND EXISTS(SELECT 1 FROM forum_posts_v1 p LEFT JOIN forum_versions_v1 v ON v.id=p.current_version_id WHERE p.id::text=x.object_id AND (p.subject_id=$2 OR v.subject_id=$2))) OR (x.object_kind='reply' AND EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.id::text=x.object_id AND r.subject_id=$2))) FOR UPDATE`, s.Endpoint, subject)
	if e != nil {
		return nil, e
	}
	sources := []Source{}
	for rows.Next() {
		var x Source
		if e = rows.Scan(&x.Kind, &x.ID, &x.RuleKey, &x.AccountID, &x.Domains, &x.Title, &x.ObjectKind, &x.ObjectID, &x.Active, &x.Revision, &x.OccurredAt); e != nil {
			rows.Close()
			return nil, e
		}
		sources = append(sources, x)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	changed := 0
	for _, x := range sources {
		copyTitle := x.Kind == "post" || x.Kind == "reply" || x.Kind == "like"
		if !x.Active && (!copyTitle || x.Title == "") {
			continue
		}
		if s.OnSourceWithin == nil {
			return nil, fault.New("community_assessment_not_connected", 503)
		}
		x.Active = false
		if copyTitle {
			x.Title = ""
		}
		x.Revision++
		if e = s.RecordSourceWithin(ctx, tx, x); e != nil {
			return nil, e
		}
		changed++
	}
	// A historical version may have supplied a title before the current version
	// changed owner. Clear the material copy for those posts without altering the
	// current owner's independent source or management recognition.
	// Results may contain generated prose based on any material in a task, even
	// where the model omitted it from its evidence list. Keep record metadata but
	// remove its prose and prevent adoption until a new input revision is made.
	_, e = tx.Exec(ctx, `UPDATE community_assessment_scopes_v1 s SET input_revision=input_revision+1,state='pending',task_id=NULL,current_result_id=NULL,last_error=NULL,next_attempt_at=$3,updated_at=$3 WHERE s.endpoint=$1 AND (s.task_id=ANY($2::uuid[]) OR s.current_result_id IN (SELECT id FROM community_assessment_results_v1 WHERE endpoint=$1 AND task_id=ANY($2::uuid[])))`, s.Endpoint, taskIDs, s.now())
	if e != nil {
		return nil, e
	}
	results, e := tx.Exec(ctx, `UPDATE community_assessment_results_v1 SET adopted=false,reason='',evidence='[]'::jsonb,missing='[]'::jsonb WHERE endpoint=$1 AND task_id=ANY($2::uuid[])`, s.Endpoint, taskIDs)
	if e != nil {
		return nil, e
	}
	materials, e := tx.Exec(ctx, `UPDATE community_assessment_materials_v1 m SET snapshot=m.snapshot-'title',read_version=NULL,read_at=NULL WHERE m.endpoint=$1 AND ((m.snapshot->>'objectKind'='post' AND EXISTS(SELECT 1 FROM forum_posts_v1 p WHERE p.id::text=m.snapshot->>'objectId' AND (p.subject_id=$2 OR EXISTS(SELECT 1 FROM forum_versions_v1 v WHERE v.post_id=p.id AND v.subject_id=$2)))) OR (m.snapshot->>'objectKind'='reply' AND EXISTS(SELECT 1 FROM forum_replies_v1 r WHERE r.id::text=m.snapshot->>'objectId' AND r.subject_id=$2)))`, s.Endpoint, subject)
	if e != nil {
		return nil, e
	}
	out := Object{"growthSourcesCorrected": changed, "assessmentMaterialsMinimized": materials.RowsAffected(), "assessmentResultsMinimized": results.RowsAffected()}
	for key, value := range taskCopies {
		out[key] = value
	}
	return out, nil
}
