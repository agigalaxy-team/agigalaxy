-- Expose only an already-bound workbench run's metadata to the worker. The
-- conversation command and session bodies remain private to the API role.
CREATE FUNCTION public.galaxy_autonomy_workbench_observations_v1(wanted_endpoint text, wanted_task uuid DEFAULT NULL)
RETURNS TABLE(task_id uuid, domain text, native_run_id text, turn_operation_id uuid,
              conversation_id uuid, session_id uuid, operator_id text, ai_account_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $observe$
 SELECT t.id,t.domain,r.native_run_id,r.turn_operation_id,v.id,v.session_id,v.operator_id,t.ai_account_id
 FROM public.operations_autonomy_workbench_runs_v1 r
 JOIN public.operations_autonomy_tasks_v1 t ON t.endpoint=r.endpoint AND t.id=r.task_id
 JOIN public.operations_agentos_conversation_commands_v1 c ON c.endpoint=r.endpoint AND c.id=r.turn_operation_id
 JOIN public.operations_agentos_conversations_v1 v ON v.endpoint=c.endpoint AND v.id=c.conversation_id
 WHERE r.endpoint=wanted_endpoint AND (wanted_task IS NULL OR t.id=wanted_task)
   AND r.native_run_id IS NOT NULL AND r.native_run_id<>''
   AND r.state IN ('running','unknown','waiting-human') AND t.state NOT IN ('stopped','blocked')
   AND (t.source='workbench' OR t.human_decision->>'kind'='takeover')
   AND (t.id=c.id OR c.result->>'taskId'=t.id::text)
   AND c.operator_id=v.operator_id AND t.domain=v.domain AND t.ai_account_id=v.ai_account_id
   AND COALESCE(NULLIF(c.native_run_id,''), NULLIF(c.result->>'runId',''))=r.native_run_id
   AND (NULLIF(c.native_run_id,'') IS NULL OR c.native_run_id=r.native_run_id)
   AND (NULLIF(c.result->>'runId','') IS NULL OR c.result->>'runId'=r.native_run_id)
   AND (NULLIF(t.configuration#>>'{externalWorkbench,operatorId}','') IS NULL OR t.configuration#>>'{externalWorkbench,operatorId}'=v.operator_id)
   AND (NULLIF(t.configuration#>>'{externalWorkbench,conversationId}','') IS NULL OR t.configuration#>>'{externalWorkbench,conversationId}'=v.id::text)
   AND (NULLIF(t.configuration#>>'{externalWorkbench,sessionId}','') IS NULL OR t.configuration#>>'{externalWorkbench,sessionId}'=v.session_id::text)
   AND COALESCE(NULLIF(t.configuration#>>'{externalWorkbench,turnOperationId}',''), t.id::text)=r.turn_operation_id::text
 ORDER BY r.updated_at,r.task_id LIMIT 10
 FOR SHARE OF r
$observe$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_workbench_observations_v1(text,uuid) FROM PUBLIC;
