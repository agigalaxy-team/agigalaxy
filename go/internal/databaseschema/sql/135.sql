CREATE FUNCTION public.galaxy_autonomy_workbench_card_states_v1(wanted_endpoint text,wanted_task uuid)
 RETURNS TABLE(prepared boolean,processing boolean,unknown boolean,unavailable boolean,cancelled boolean,completed boolean,binding_invalid boolean)
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $states$
 WITH bound AS (
  SELECT c.state,c.result, COALESCE(c.operator_id<>'' AND c.operator_id=v.operator_id AND c.domain=t.domain AND v.domain=t.domain AND v.ai_account_id=t.ai_account_id
   AND c.operator_id=NULLIF(t.configuration#>>'{externalWorkbench,operatorId}',''),false) AS valid
  FROM operations_agentos_conversation_cards_v1 c JOIN operations_autonomy_tasks_v1 t ON t.endpoint=c.endpoint
   AND (t.id=c.turn_id OR EXISTS(SELECT 1 FROM operations_autonomy_workbench_runs_v1 r WHERE r.endpoint=t.endpoint AND r.task_id=t.id AND r.turn_operation_id=c.turn_id))
  LEFT JOIN operations_agentos_conversations_v1 v ON v.endpoint=c.endpoint AND v.id=c.conversation_id
  WHERE t.endpoint=wanted_endpoint AND t.id=wanted_task
   AND c.turn_id::text=COALESCE(NULLIF(t.configuration#>>'{externalWorkbench,turnOperationId}',''),t.id::text)
 )
 SELECT COALESCE(bool_or(valid AND state='prepared'),false),COALESCE(bool_or(valid AND state='processing'),false),
 COALESCE(bool_or(valid AND state='unknown'),false),
 COALESCE(bool_or(valid AND state='not-available' AND COALESCE(result->>'state','')<>'cancelled'),false),
 COALESCE(bool_or(valid AND state='not-available' AND result->>'state'='cancelled'),false),
 COALESCE(bool_or(valid AND state='completed'),false),COALESCE(bool_or(NOT valid),false) FROM bound
 $states$;
REVOKE ALL ON FUNCTION public.galaxy_autonomy_workbench_card_states_v1(text,uuid) FROM PUBLIC;
