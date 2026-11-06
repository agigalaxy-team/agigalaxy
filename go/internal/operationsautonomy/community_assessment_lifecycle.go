package operationsautonomy

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MinimizeCommunityAssessmentTasksWithin is called only from an approved
// source lifecycle transaction with task IDs frozen from that source's exact
// assessment manifests. It retains original operations, states, failures,
// identities and audit coordinates. It never touches another duty or session.
func (s *Service) MinimizeCommunityAssessmentTasksWithin(ctx context.Context, tx pgx.Tx, taskIDs []string) (Object, error) {
	if s.Endpoint == "" {
		return nil, invalid()
	}
	for _, id := range taskIDs {
		if _, e := uuid.Parse(id); e != nil {
			return nil, invalid()
		}
	}
	if len(taskIDs) == 0 {
		return Object{"assessmentTaskCopiesMinimized": 0, "assessmentToolCopiesMinimized": 0, "assessmentCommandCopiesMinimized": 0}, nil
	}
	// Acquire original task locks before source invalidation takes scope locks,
	// matching the real result writer's task -> scope lock order.
	rows, e := tx.Query(ctx, `SELECT t.id::text FROM operations_autonomy_tasks_v1 t
		JOIN community_assessment_tasks_v1 a ON a.endpoint=t.endpoint AND a.id=t.id AND a.native_task_id=t.id
		WHERE t.endpoint=$1 AND t.id=ANY($2::uuid[]) AND t.domain='discovery' AND t.source='event'
		AND t.configuration#>>'{communityAssessment,taskId}'=t.id::text ORDER BY t.id FOR UPDATE OF t`, s.Endpoint, taskIDs)
	if e != nil {
		return nil, e
	}
	selected := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, e
		}
		selected = append(selected, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	tasks, e := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET
		configuration=jsonb_set(configuration,'{communityAssessment,materialsState}','"minimized"'::jsonb,true),summary=NULL,
		result=public.galaxy_community_assessment_analysis_minimized_v1(result,native_run_id,native_attempt_id),
		revision=revision+1,updated_at=$3 WHERE endpoint=$1 AND id=ANY($2::uuid[])
		AND (configuration#>>'{communityAssessment,materialsState}' IS DISTINCT FROM 'minimized' OR summary IS NOT NULL
		OR result#>>'{analysis,basis}' IS DISTINCT FROM 'community-source-minimized')`, s.Endpoint, selected, s.now())
	if e != nil {
		return nil, e
	}
	tools, e := tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET
		arguments=public.galaxy_community_assessment_arguments_minimized_v1(endpoint,task_id,tool,arguments),
		read_outcome=COALESCE(read_outcome,'{}'::jsonb)||jsonb_build_object('derivedContentState','minimized','derivedContentBasis','community-source-lifecycle')
		WHERE endpoint=$1 AND task_id=ANY($2::uuid[]) AND tool IN ('read-community-assessment-material','save-community-assessment-result','assess-task')
		AND (arguments IS DISTINCT FROM public.galaxy_community_assessment_arguments_minimized_v1(endpoint,task_id,tool,arguments)
		OR read_outcome->>'derivedContentState' IS DISTINCT FROM 'minimized')`, s.Endpoint, selected)
	if e != nil {
		return nil, e
	}
	commands, e := tx.Exec(ctx, `UPDATE operations_autonomy_commands_v1 SET
		result=jsonb_set(result,'{task}',public.galaxy_community_assessment_view_minimized_v1(result->'task'),false)
		WHERE endpoint=$1 AND result#>>'{task,id}'=ANY($2::text[])
		AND result->'task' IS DISTINCT FROM public.galaxy_community_assessment_view_minimized_v1(result->'task')`, s.Endpoint, selected)
	if e != nil {
		return nil, e
	}
	return Object{"assessmentTaskCopiesMinimized": tasks.RowsAffected(), "assessmentToolCopiesMinimized": tools.RowsAffected(), "assessmentCommandCopiesMinimized": commands.RowsAffected()}, nil
}
