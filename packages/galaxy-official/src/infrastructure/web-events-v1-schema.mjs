import {webEventSources,webEventSourceAliases} from '../web-events/topics.mjs';

export const webEventsV1MigrationSql = `
CREATE TABLE web_event_outbox_v1 (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 module text NOT NULL, source_table text NOT NULL, source_ref jsonb NOT NULL,
 endpoint text, operation_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE web_event_sequence_v1 (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), cursor bigint NOT NULL DEFAULT 0);
INSERT INTO web_event_sequence_v1(singleton,cursor) VALUES(true,0);
CREATE TABLE web_event_log_v1 (
 cursor bigint PRIMARY KEY, module text NOT NULL, source_table text NOT NULL,
 source_ref jsonb NOT NULL, endpoint text, operation_id text, committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION galaxy_web_events_promote_v1(batch integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record; next_cursor bigint; promoted integer:=0;
BEGIN
 IF batch<1 OR batch>256 THEN RAISE EXCEPTION 'invalid web event batch'; END IF;
 SELECT cursor INTO next_cursor FROM public.web_event_sequence_v1 WHERE singleton FOR UPDATE;
 FOR r IN SELECT * FROM public.web_event_outbox_v1 ORDER BY id LIMIT batch FOR UPDATE LOOP
  next_cursor:=next_cursor+1;
  INSERT INTO public.web_event_log_v1(cursor,module,source_table,source_ref,endpoint,operation_id)
   VALUES(next_cursor,r.module,r.source_table,r.source_ref,r.endpoint,r.operation_id);
  DELETE FROM public.web_event_outbox_v1 WHERE id=r.id;
  promoted:=promoted+1;
 END LOOP;
 UPDATE public.web_event_sequence_v1 SET cursor=next_cursor WHERE singleton;
 DELETE FROM public.web_event_log_v1 WHERE cursor<next_cursor-4095 OR committed_at<clock_timestamp()-interval '7 days';
 IF promoted>0 THEN PERFORM pg_notify('galaxy_web_event_ready_v1',''); END IF;
 RETURN promoted;
END; $$;
REVOKE ALL ON FUNCTION galaxy_web_events_promote_v1(integer) FROM PUBLIC;
CREATE FUNCTION galaxy_web_event_capture_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; refs jsonb; current_module text; source_endpoint text;
BEGIN
 IF TG_OP='DELETE' THEN r=to_jsonb(OLD); ELSE r=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=r THEN RETURN NEW; END IF;
 -- Refresh progress does not change the browser's account authority. Retain
 -- every other field in this comparison: revocation, principal, CSRF, account,
 -- original/max expiry and logout fences must still invalidate its projections.
 IF TG_TABLE_NAME='official_account_sessions_v1' AND TG_OP='UPDATE'
  AND to_jsonb(OLD)->>'refresh_state' IS DISTINCT FROM 'revoked'
  AND r->>'refresh_state' IS DISTINCT FROM 'revoked'
  AND (to_jsonb(OLD)-ARRAY['refresh_cipher','upstream_expires_at','idle_expires_at','refresh_version','refresh_state'])
    =(r-ARRAY['refresh_cipher','upstream_expires_at','idle_expires_at','refresh_version','refresh_state'])
 THEN RETURN NULL; END IF;
 source_endpoint:=r->>'endpoint';
 IF source_endpoint IS NULL AND r->>'account_id' IS NOT NULL THEN
  SELECT endpoint INTO source_endpoint FROM public.community_accounts WHERE id::text=r->>'account_id';
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO refs FROM jsonb_each(r)
 WHERE key IN ('id','account_id','subject_id','room_id','message_id','task_id','project_id','work_id','scope_id','post_id','reply_id','source_id','operator_id','endpoint','initiator_id','recipient_id','participant_id','decision_id','capsule_id','assistance_id','grant_id','builder_id','owner_id','request_id','watch_id','snapshot_id','notice_id');
 refs:=refs||jsonb_build_object('_operation',TG_OP,'_version',coalesce(r->>'revision',r->>'version',r->>'head_version'));
 FOREACH current_module IN ARRAY string_to_array(TG_ARGV[0],',') LOOP
  IF current_module='site-content' AND (r->>'state' IS DISTINCT FROM 'published' OR r->>'published_at' IS NULL OR TG_OP='DELETE') THEN CONTINUE; END IF;
  INSERT INTO public.web_event_outbox_v1(module,source_table,source_ref,endpoint,operation_id)
  VALUES(current_module,TG_TABLE_NAME,refs,source_endpoint,coalesce(r->>'last_operation_id',r->>'operation_id'));
 END LOOP;
 PERFORM pg_notify('galaxy_web_event_pending_v1','');
 RETURN NULL;
END; $$;
${Object.entries(webEventSources).map(([table,module])=>`CREATE TRIGGER web_event_capture_v1 AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION galaxy_web_event_capture_v1('${[module,...webEventSourceAliases[table]??[]].join(',')}');`).join('\n')}
`;
