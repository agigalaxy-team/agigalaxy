// One statement gives the collector a consistent PostgreSQL statement snapshot.
// Only aggregates cross this boundary; no subject, payload or credential values.
export async function operationalSnapshot(db, now = Date.now()) {
  const row = (await db.query(`WITH queue AS (
    SELECT count(*) FILTER(WHERE state='pending') AS pending,
      count(*) FILTER(WHERE state='running') AS running,
      count(*) FILTER(WHERE state='completed') AS completed,
      count(*) FILTER(WHERE state='failed') AS failed,
      count(*) FILTER(WHERE state='running' AND locked_until>$1) AS active,
      greatest(coalesce(max(extract(epoch FROM ($1::timestamptz-created_at))) FILTER(WHERE state IN ('pending','running')),0),0) AS oldest
    FROM jobs
  ), invalidated AS (
    SELECT j.id,least(c.revoked_at,b.revoked_at) AS revoked_at
    FROM jobs j JOIN evidence_submissions e ON j.payload->>'evidenceId'=e.id::text
      JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
    WHERE j.state IN ('pending','running') AND (c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL)
    UNION ALL
    SELECT j.id,least(c.revoked_at,b.revoked_at) FROM jobs j JOIN builder_events r ON j.payload->>'requestId'=r.id::text
      JOIN consents c ON c.id=r.consent_id JOIN bindings b ON b.id=c.binding_id
    WHERE j.kind='builder-probe' AND j.state IN ('pending','running') AND (c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL)
  ), evidence_jobs AS (
    SELECT j.id,j.payload,e.consent_id,e.case_id,e.result_id,r.payload AS result
    FROM jobs j JOIN evidence_submissions e ON j.payload->>'evidenceId'=e.id::text
      JOIN case_events r ON r.id=e.result_id AND r.case_id=e.case_id
    WHERE j.state IN ('pending','running')
  ), job_grants AS (
    SELECT id,consent_id FROM evidence_jobs
    UNION
    SELECT j.id,a.consent_id FROM evidence_jobs j JOIN case_events a ON a.case_id=j.case_id
      AND (a.kind='case' OR a.id=j.result_id OR a.id::text=j.result->>'attemptId')
    UNION
    SELECT j.id,m.consent_id FROM evidence_jobs j JOIN moderation_events m
      ON m.id::text=j.payload#>>'{revalidation,eventId}' AND m.report_id::text=j.payload#>>'{revalidation,reportId}'
    UNION
    SELECT j.id,a.consent_id FROM jobs j JOIN builder_events r ON r.id::text=j.payload->>'requestId'
      JOIN builder_events a ON a.builder_id=r.builder_id AND
        (a.id=r.id OR a.id::text=r.payload_text::jsonb->>'declarationId' OR a.id::text=r.payload_text::jsonb->>'controlId')
    WHERE j.kind='builder-probe' AND j.state IN ('pending','running')
  ), invalidated_dependencies AS (
    SELECT j.id,min(least(c.revoked_at,b.revoked_at)) AS revoked_at FROM job_grants j
      JOIN consents c ON c.id=j.consent_id JOIN bindings b ON b.id=c.binding_id
    WHERE c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL GROUP BY j.id
  ), invalidated_search AS (
    SELECT d.source_type,d.source_id FROM search_documents d
    WHERE EXISTS(SELECT 1 FROM consents c WHERE c.revoked_at IS NOT NULL AND d.dependencies @> jsonb_build_array('consent:'||c.id))
       OR EXISTS(SELECT 1 FROM bindings b WHERE b.revoked_at IS NOT NULL AND d.dependencies @> jsonb_build_array('binding:'||b.id))
  )
  SELECT pg_database_size(current_database())::text AS database_bytes,
    queue.*,
    (SELECT count(*) FROM invalidated) AS revoked_jobs,
    (SELECT greatest(coalesce(max(extract(epoch FROM ($1::timestamptz-revoked_at))),0),0) FROM invalidated) AS oldest_revocation,
    (SELECT count(*) FROM invalidated_dependencies) AS dependent_revoked_jobs,
    (SELECT greatest(coalesce(max(extract(epoch FROM ($1::timestamptz-revoked_at))),0),0) FROM invalidated_dependencies) AS oldest_dependent_revocation,
    (SELECT count(*) FROM invalidated_search) AS invalidated_search_documents,
    (SELECT count(DISTINCT subject_id) FROM bindings WHERE revoked_at IS NULL AND expires_at>$1) AS connected,
    (SELECT count(DISTINCT e.subject_id) FROM evidence_submissions e
      JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
      JOIN cases parent ON parent.id=e.case_id AND parent.state<>'withdrawn'
      JOIN case_events result ON result.id=e.result_id AND result.case_id=e.case_id
      JOIN LATERAL (SELECT observation FROM verification_attempts v WHERE v.evidence_id=e.id ORDER BY ordinal DESC LIMIT 1) latest ON true
      WHERE e.state='observed' AND c.revoked_at IS NULL AND c.expires_at>$1
        AND b.revoked_at IS NULL AND b.expires_at>$1
        AND (SELECT count(*) FROM case_events ce JOIN consents ancestor ON ancestor.id=ce.consent_id
          JOIN bindings owner_binding ON owner_binding.id=ancestor.binding_id
          WHERE ce.case_id=e.case_id AND (ce.kind='case' OR ce.id=e.result_id OR ce.id::text=result.payload->>'attemptId')
            AND ancestor.revoked_at IS NULL AND ancestor.expires_at>$1
            AND owner_binding.revoked_at IS NULL AND owner_binding.expires_at>$1)=3
        AND latest.observation->>'status'='observed'
        AND (latest.observation->>'validUntil')::numeric>extract(epoch FROM $1::timestamptz)) AS evidence_bearing
  FROM queue`, [new Date(now).toISOString()])).rows[0];
  return Object.fromEntries(Object.entries(row).map(([key,value]) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('Invalid operational aggregate');
    return [key,number];
  }));
}
