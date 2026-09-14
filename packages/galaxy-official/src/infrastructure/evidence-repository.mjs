// Named SQL operations. Uses only the supplied connection; no pool or transaction ownership.
export function evidenceRepository(db) {
  return {
    lockCase: values => db.query('SELECT state FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE', values),
    result: values => db.query("SELECT * FROM case_events WHERE id=$1 AND case_id=$2 AND kind='result'", values),
    ancestors: values => db.query("SELECT * FROM case_events WHERE case_id=$1 AND (kind='case' OR id=$2)", values),
    insert: values => db.query(`INSERT INTO evidence_submissions(id,subject_id,case_id,result_id,consent_id,source_key,payload_text,payload_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, values),
    lock: values => db.query('SELECT * FROM evidence_submissions WHERE id=$1 FOR UPDATE', values),
    enqueue: values => db.query(`INSERT INTO jobs(id,kind,deduplication_key,payload) VALUES ($1,$4,$2,$3)
        ON CONFLICT(deduplication_key) DO NOTHING`, values),
    getOwned: values => db.query('SELECT * FROM evidence_submissions WHERE id=$1 AND subject_id=$2', values),
    observations: values => db.query('SELECT job_id,observation FROM verification_attempts WHERE evidence_id=$1 ORDER BY ordinal DESC LIMIT 20', values),
    failExhausted: values => db.query(`WITH candidates AS (
      SELECT id FROM jobs WHERE kind=$2 AND state='running' AND locked_until<=$1 AND attempts>=5
      ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED)
      UPDATE jobs j SET state='failed',lease_id=NULL FROM candidates c WHERE j.id=c.id RETURNING j.id,j.payload`, values),
    markUnavailable: values => db.query(`WITH candidates AS (
      SELECT e.id FROM evidence_submissions e WHERE e.state='pending' AND EXISTS
        (SELECT 1 FROM jobs j WHERE j.kind=$1 AND j.state='failed' AND j.payload->>'evidenceId'=e.id::text)
      ORDER BY e.id LIMIT 100 FOR UPDATE OF e SKIP LOCKED)
      UPDATE evidence_submissions e SET state='unavailable' FROM candidates c WHERE e.id=c.id RETURNING e.id`, values),
    auditJobTransition: async (evidenceId, jobKind, action, verifier, jobId = null) => {
      if (!['verification.exhausted', 'evidence.unavailable'].includes(action)) throw new Error('Unsupported audit action');
      const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
        context_version,client_id,audience,scope,consent_id,binding_id,idempotency_key,binding_scopes)
        SELECT $4,$3,e.id::text,j.id::text,CASE WHEN $3='verification.exhausted' THEN 'failed' ELSE e.state END,
          1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,j.id::text || ':' || $3,b.scopes
        FROM evidence_submissions e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
        JOIN jobs j ON j.payload->>'evidenceId'=e.id::text
        WHERE e.id=$1::uuid AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id
          AND j.kind=$2 AND j.state='failed' AND ($5::uuid IS NULL OR j.id=$5::uuid)
        RETURNING 1`, [evidenceId, jobKind, action, verifier, jobId]);
      if (result.rows.length !== 1) throw new Error('Audit context unavailable');
    },
    claimCandidate: values => db.query(`SELECT * FROM jobs WHERE kind=$2 AND attempts<5 AND
        ((state='pending' AND available_at<=$1) OR (state='running' AND locked_until<=$1))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, values),
    claimBudgetCandidate: values => db.query(`SELECT j.* FROM jobs j JOIN evidence_submissions e ON j.payload->>'evidenceId'=e.id::text
      WHERE j.kind=$2 AND j.attempts<5 AND ((j.state='pending' AND j.available_at<=$1) OR (j.state='running' AND j.locked_until<=$1))
      AND (SELECT count(*) FROM jobs active LEFT JOIN evidence_submissions owned ON active.payload->>'evidenceId'=owned.id::text
        LEFT JOIN ci_requests_v2 ci ON active.payload->>'ciRequestId'=ci.id::text
        WHERE (owned.subject_id=e.subject_id OR ci.subject_id=e.subject_id OR active.kind='builder-probe' AND active.payload->>'subjectId'=e.subject_id) AND active.state='running' AND active.locked_until>$1)<$3
      ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,values),
    lease: values => db.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_id=$2,locked_until=$3 WHERE id=$1", values),
    get: values => db.query('SELECT * FROM evidence_submissions WHERE id=$1', values),
    lockJob: values => db.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', values),
    insertObservation: values => db.query('INSERT INTO verification_attempts(id,evidence_id,job_id,attempt,observation) VALUES($1,$2,$3,$4,$5)', values),
    updateState: values => db.query('UPDATE evidence_submissions SET state=$2 WHERE id=$1', values),
    finishJob: values => db.query('UPDATE jobs SET state=$2,lease_id=NULL,locked_until=NULL,available_at=$3 WHERE id=$1', values),
    auditObservation: async values => {
      const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
        context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes)
        SELECT $4,'evidence.observe',$1::text,$2::text,$3,1,'galaxy-evidence-worker',b.audience,'evidence',c.id,b.id,NULL,
          $2::text || ':' || $5::integer::text,b.scopes
        FROM evidence_submissions e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
        WHERE e.id=$1::text::uuid AND c.subject_id=e.subject_id AND b.subject_id=e.subject_id
        AND EXISTS (SELECT 1 FROM verification_attempts v WHERE v.evidence_id=e.id AND v.job_id=$2::text::uuid AND v.attempt=$5::integer)
        RETURNING 1`, values);
      if (result.rows.length !== 1) throw new Error('Audit context unavailable');
    },
  };
}
