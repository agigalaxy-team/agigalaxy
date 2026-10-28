
CREATE TABLE search_index_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),endpoint text NOT NULL,enabled boolean NOT NULL DEFAULT false,
  scan_type text NOT NULL DEFAULT '',scan_after uuid,scan_complete boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE search_documents (
  source_type text NOT NULL CHECK(source_type IN ('case','history','proof','capsule')),source_id uuid NOT NULL,
  subject_id text NOT NULL REFERENCES subjects(id),endpoint text NOT NULL,title text NOT NULL,summary text NOT NULL,
  search_text text NOT NULL,source_version text NOT NULL,metadata jsonb NOT NULL,dependencies jsonb NOT NULL,
  generation integer NOT NULL CHECK(generation>0),built_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,
  search_words tsvector GENERATED ALWAYS AS (to_tsvector('simple',search_text)) STORED,
  PRIMARY KEY(source_type,source_id),CHECK(jsonb_typeof(dependencies)='array'),CHECK(valid_until>built_at)
);
CREATE INDEX search_documents_owner ON search_documents(subject_id,source_type,source_id);
CREATE INDEX search_documents_dependencies ON search_documents USING gin(dependencies jsonb_path_ops);
CREATE INDEX search_documents_words ON search_documents USING gin(search_words);

CREATE FUNCTION public.galaxy_queue_search_source(kind text,source uuid,owner_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF kind NOT IN ('case','history','proof','capsule') OR source IS NULL OR owner_id IS NULL THEN RETURN; END IF;
  DELETE FROM public.search_documents WHERE source_type=kind AND source_id=source;
  IF NOT EXISTS(SELECT 1 FROM public.search_index_control WHERE enabled)
    OR current_setting('galaxy.deletion_subject',true)=owner_id
    OR NOT EXISTS(SELECT 1 FROM public.subjects WHERE id=owner_id) THEN RETURN; END IF;
  INSERT INTO public.jobs(id,kind,deduplication_key,payload)
    VALUES(gen_random_uuid(),'search-index','search-index:'||kind||':'||source,
      jsonb_build_object('sourceType',kind,'sourceId',source,'subjectId',owner_id,'generation',1))
    ON CONFLICT(deduplication_key) DO UPDATE SET
      payload=EXCLUDED.payload||jsonb_build_object('generation',COALESCE((jobs.payload->>'generation')::integer,0)+1),
      state='pending',attempts=0,lease_id=NULL,locked_until=NULL,available_at=now();
END $$;
REVOKE ALL ON FUNCTION public.galaxy_queue_search_source(text,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.galaxy_search_source_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE value jsonb; item record; ref text; target uuid; owner_id text;
BEGIN
  value=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME IN ('cases','case_events') THEN
    target=CASE WHEN TG_TABLE_NAME='cases' THEN (value->>'id')::uuid ELSE (value->>'case_id')::uuid END;
    owner_id=value->>'subject_id';
    PERFORM public.galaxy_queue_search_source('case',target,owner_id);
    PERFORM public.galaxy_queue_search_source('history',target,owner_id);
    ref='case:'||target;
  ELSIF TG_TABLE_NAME IN ('capsules','capsule_events') THEN
    target=CASE WHEN TG_TABLE_NAME='capsules' THEN (value->>'id')::uuid ELSE (value->>'capsule_id')::uuid END;
    PERFORM public.galaxy_queue_search_source('capsule',target,value->>'subject_id');
    ref='capsule:'||target;
  ELSIF TG_TABLE_NAME='proofs' THEN
    PERFORM public.galaxy_queue_search_source('proof',(value->>'id')::uuid,value->>'subject_id');
    ref='proof:'||(value->>'id');
  ELSIF TG_TABLE_NAME IN ('evidence_submissions','verification_attempts') THEN
    target=CASE WHEN TG_TABLE_NAME='evidence_submissions' THEN (value->>'id')::uuid ELSE (value->>'evidence_id')::uuid END;
    FOR item IN SELECT id,subject_id FROM public.proofs WHERE evidence_id=target LOOP
      PERFORM public.galaxy_queue_search_source('proof',item.id,item.subject_id);
    END LOOP;
    ref='evidence:'||target;
  ELSE
    ref=CASE WHEN TG_TABLE_NAME='consents' THEN 'consent:' ELSE 'binding:' END||(value->>'id');
  END IF;
  FOR item IN SELECT source_type,source_id,subject_id FROM public.search_documents WHERE dependencies @> jsonb_build_array(ref) LOOP
    PERFORM public.galaxy_queue_search_source(item.source_type,item.source_id,item.subject_id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_search_source_changed() FROM PUBLIC;
CREATE TRIGGER search_case_changed AFTER INSERT OR UPDATE OR DELETE ON cases FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_case_event_changed AFTER INSERT OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_capsule_changed AFTER INSERT OR UPDATE OR DELETE ON capsules FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_capsule_event_changed AFTER INSERT OR DELETE ON capsule_events FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_proof_changed AFTER INSERT OR UPDATE OR DELETE ON proofs FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_evidence_changed AFTER UPDATE OR DELETE ON evidence_submissions FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_observation_changed AFTER INSERT OR DELETE ON verification_attempts FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_consent_changed AFTER UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();
CREATE TRIGGER search_binding_changed AFTER UPDATE OR DELETE ON bindings FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_source_changed();

CREATE FUNCTION public.galaxy_search_verification_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item record;
BEGIN
  IF NEW.kind='search-index' OR NOT NEW.payload ? 'evidenceId' THEN RETURN NULL; END IF;
  FOR item IN SELECT id,subject_id FROM public.proofs WHERE evidence_id=(NEW.payload->>'evidenceId')::uuid LOOP
    PERFORM public.galaxy_queue_search_source('proof',item.id,item.subject_id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_search_verification_changed() FROM PUBLIC;
CREATE TRIGGER search_verification_changed AFTER INSERT OR UPDATE OF state ON jobs FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_verification_changed();

CREATE FUNCTION public.galaxy_search_lock_sources(refs jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>2200 THEN RAISE EXCEPTION 'Invalid search dependencies'; END IF;
  PERFORM id FROM public.cases WHERE refs @> jsonb_build_array('case:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.capsules WHERE refs @> jsonb_build_array('capsule:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.evidence_submissions WHERE refs @> jsonb_build_array('evidence:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.proofs WHERE refs @> jsonb_build_array('proof:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.bindings WHERE refs @> jsonb_build_array('binding:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.consents WHERE refs @> jsonb_build_array('consent:'||id) ORDER BY id FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_search_lock_sources(jsonb) FROM PUBLIC;
