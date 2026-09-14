// Migration 33. Extend the existing derived index; original migration 32 stays immutable.
export const builderSearchIndexMigrationSql=`
ALTER TABLE search_documents DROP CONSTRAINT search_documents_source_type_check;
ALTER TABLE search_documents ADD CONSTRAINT search_documents_source_type_check CHECK(source_type IN ('case','history','proof','capsule','worker','hub'));

CREATE OR REPLACE FUNCTION public.galaxy_queue_search_source(kind text,source uuid,owner_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF kind NOT IN ('case','history','proof','capsule','worker','hub') OR source IS NULL OR owner_id IS NULL THEN RETURN; END IF;
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

CREATE FUNCTION public.galaxy_search_builder_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE value jsonb; target uuid; kind text; owner_id text;
BEGIN
  value=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='builders' THEN
    target=(value->>'id')::uuid;kind=value->>'type';owner_id=value->>'owner_id';
  ELSE
    target=(value->>'builder_id')::uuid;
    SELECT b.type,b.owner_id INTO kind,owner_id FROM public.builders b WHERE b.id=target;
  END IF;
  PERFORM public.galaxy_queue_search_source(kind,target,owner_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_search_builder_changed() FROM PUBLIC;
CREATE TRIGGER search_builder_changed AFTER INSERT OR UPDATE OR DELETE ON builders FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_builder_changed();
CREATE TRIGGER search_builder_event_changed AFTER INSERT OR DELETE ON builder_events FOR EACH ROW EXECUTE FUNCTION public.galaxy_search_builder_changed();

CREATE OR REPLACE FUNCTION public.galaxy_search_lock_sources(refs jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>2200 THEN RAISE EXCEPTION 'Invalid search dependencies'; END IF;
  PERFORM id FROM public.cases WHERE refs @> jsonb_build_array('case:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.capsules WHERE refs @> jsonb_build_array('capsule:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.builders WHERE refs @> jsonb_build_array('builder:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.evidence_submissions WHERE refs @> jsonb_build_array('evidence:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.proofs WHERE refs @> jsonb_build_array('proof:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.bindings WHERE refs @> jsonb_build_array('binding:'||id) ORDER BY id FOR SHARE;
  PERFORM id FROM public.consents WHERE refs @> jsonb_build_array('consent:'||id) ORDER BY id FOR SHARE;
END $$;

-- Resume scanning existing registrations even if the previous four-type scan completed.
UPDATE search_index_control SET scan_type='',scan_after=NULL,scan_complete=false,updated_at=now();
`;

