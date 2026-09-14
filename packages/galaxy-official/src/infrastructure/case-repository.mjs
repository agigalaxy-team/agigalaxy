// Bind to the transaction client supplied by AccessService.runAuthorized.
// No pool, connect(), BEGIN or implicit transaction exists in this repository.
export function caseRepository(db) {
  const one = (sql, values) => db.query(sql, values).then(result => result.rows[0]);
  return {
    ensureCase: (id, subjectId, localRef, sourceRef) => db.query(`INSERT INTO cases(id,subject_id,local_ref,source_ref,version,state)
      VALUES ($1,$2,$3,$4,1,'open') ON CONFLICT DO NOTHING`, [id, subjectId, localRef, sourceRef]),
    lockForWrite: (id, subjectId) => one('SELECT * FROM cases WHERE id=$1 AND subject_id=$2 FOR UPDATE', [id, subjectId]),
    lockForRead: (id, subjectId) => one('SELECT * FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE', [id, subjectId]),
    lockAnyForWrite: id => one('SELECT * FROM cases WHERE id=$1 FOR UPDATE', [id]),
    lockAnyForRead: id => one('SELECT * FROM cases WHERE id=$1 FOR SHARE', [id]),
    hasV2: id => one("SELECT id FROM case_events WHERE case_id=$1 AND kind NOT IN ('case','attempt','result','revision','withdrawal') LIMIT 1", [id]).then(Boolean),
    event: id => one('SELECT * FROM case_events WHERE id=$1', [id]),
    attemptCount: id => one("SELECT count(*) FROM case_events WHERE case_id=$1 AND kind='attempt'", [id]).then(row => Number(row.count)),
    reference: (id, caseId) => one('SELECT * FROM case_events WHERE id=$1 AND case_id=$2', [id, caseId]),
    insertEvent: ({ event, caseId, subjectId, version, consentId, payloadJson, hash }) => db.query(`INSERT INTO
      case_events(id,case_id,subject_id,kind,version,consent_id,payload,payload_text,payload_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [event.eventId ?? event.id, caseId, subjectId, event.kind, version, consentId,
      JSON.stringify(event), payloadJson, hash]),
    updateState: (id, version, state) => db.query('UPDATE cases SET version=$2,state=$3 WHERE id=$1', [id, version, state]),
    audit: async (subjectId, kind, caseId, eventId, httpRequestId = null, credentialScopes, callerBindingId) => {
      if (!Array.isArray(credentialScopes) || typeof callerBindingId !== 'string') throw new Error('Audit authorization unavailable');
      const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
        context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
        SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'case-teaser',c.id,b.id,$5,$4::text,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
        FROM case_events e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id
        JOIN binding_challenges ch ON ch.id=b.challenge_id
        JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1
        JOIN binding_challenges cch ON cch.id=cb.challenge_id
        WHERE e.id=$4::text::uuid AND e.case_id=$3::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1 RETURNING sequence`,
        [subjectId, `case.${kind}`, caseId, eventId, httpRequestId, JSON.stringify(credentialScopes), callerBindingId]);
      if (result.rows.length !== 1) throw new Error('Audit context unavailable');
    },
    events: id => db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001', [id]).then(result => result.rows),
    taskLink: taskId => one('SELECT * FROM case_task_links WHERE task_id=$1', [taskId]),
    operationLink: id => one('SELECT * FROM case_task_links WHERE operation_id=$1', [id]),
    insertTaskLink: ({taskId,caseId,operationId,subjectId,hash,receipt}) => db.query(`INSERT INTO case_task_links
      (task_id,case_id,operation_id,subject_id,payload_hash,receipt) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [taskId,caseId,operationId,subjectId,hash,JSON.stringify(receipt)]),
  };
}
