// Called on the already-authorized, locked transaction connection. Snapshot
// only named public identifiers; never copy the consent/challenge payload.
export async function recordObjectAudit(db, { subjectId, objectId, action, httpRequestId = null, credentialScopes, callerBindingId }) {
  if (!Array.isArray(credentialScopes) || typeof callerBindingId !== 'string') throw new Error('Audit authorization unavailable');
  const consent = ['consent.create', 'consent.revoke'].includes(action);
  if (!consent && !['worker-pack.event','qualification.request.event','configuration.event', 'task.event', 'project.event', 'contact.event', 'recruitment.event', 'experience.submit', 'profile.publish', 'proof.publish', 'proof.revoke', 'evidence.submit', 'assistance.event', 'context.create', 'context.accept', 'context.revoke', 'moderation.report', 'moderation.event', 'capsule.event', 'capsule.use', 'capsule.permission', 'builder.event'].includes(action)) throw new Error('Unsupported audit action');
  const configuration=action==='configuration.event',qualificationRequest=action==='qualification.request.event';
  const project=action==='project.event', contact=action==='contact.event', recruitment=action==='recruitment.event', experience=action==='experience.submit';
  const profile=action==='profile.publish';
  const builder = action === 'builder.event'||action==='worker-pack.event',packUse=action==='worker-pack.event';
  const capsule = action.startsWith('capsule.');
  const moderation = action.startsWith('moderation.');
  const context = action.startsWith('context.');
  const assistance = action === 'assistance.event' || action === 'task.event';
  const task = action === 'task.event';
  const evidence = action === 'evidence.submit';
  const capsuleTarget=action==='capsule.event' ? 'c.id=(SELECT consent_id FROM capsule_events WHERE id=$2::text::uuid AND subject_id=$1)' : action==='capsule.permission'
    ? 'c.id=(SELECT consent_id FROM capsule_permissions WHERE id=$2::text::uuid AND subject_id=$1 UNION SELECT revoke_consent_id FROM capsule_permissions WHERE revoke_id=$2::text::uuid AND subject_id=$1)'
    : 'c.id=(SELECT consent_id FROM capsule_uses WHERE id=$2::text::uuid AND subject_id=$1 UNION SELECT consent_id FROM capsule_uses_v2 WHERE id=$2::text::uuid AND subject_id=$1)';
  const target = profile ? 'c.id=(SELECT consent_id FROM profile_statements WHERE id=$2::text::uuid AND subject_id=$1)' : packUse ? 'c.id=(SELECT consent_id FROM worker_pack_use_events WHERE operation_id=$2::text::uuid AND subject_id=$1)' : builder ? 'c.id=(SELECT consent_id FROM builder_events WHERE id=$2::text::uuid AND subject_id=$1)' : capsule ? capsuleTarget : moderation ? (action === 'moderation.report' ? 'c.id=(SELECT consent_id FROM moderation_reports WHERE id=$2::text::uuid AND reporter_id=$1)'
    : 'c.id=(SELECT consent_id FROM moderation_events WHERE id=$2::text::uuid AND subject_id=$1)') : context ? (action === 'context.accept'
    ? 'c.id=(SELECT consent_id FROM context_acceptances WHERE id=$2::text::uuid AND subject_id=$1)'
    : 'c.id=(SELECT consent_id FROM context_grants WHERE id=$2::text::uuid AND subject_id=$1)') : assistance ? 'c.id=(SELECT consent_id FROM assistance_events WHERE id=$2::text::uuid AND subject_id=$1)' : consent ? 'c.id=$2::text::uuid'
    : evidence ? 'c.id=(SELECT consent_id FROM evidence_submissions WHERE id=$2::text::uuid AND subject_id=$1)'
    : 'c.id=(SELECT consent_id FROM proofs WHERE id=$2::text::uuid AND subject_id=$1)';
  const result = await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
    context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
    SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,$4,c.id,b.id,$5,$2::text,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
    FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id
        JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1
        JOIN binding_challenges cch ON cch.id=cb.challenge_id
    WHERE ${qualificationRequest ? 'c.id=(SELECT consent_id FROM qualification_permission_request_events WHERE id=$2::text::uuid AND subject_id=$1)' : configuration ? 'c.id=(SELECT consent_id FROM configuration_events WHERE operation_id=$2::text::uuid AND subject_id=$1)' : recruitment ? 'c.id=(SELECT consent_id FROM recruitment_events WHERE operation_id=$2::text::uuid AND subject_id=$1)' : contact ? 'c.id=(SELECT consent_id FROM contact_events_v2 WHERE operation_id=$2::text::uuid AND subject_id=$1)' : project ? 'c.id=(SELECT consent_id FROM project_events_v2 WHERE operation_id=$2::text::uuid AND subject_id=$1)' : experience ? 'c.id=(SELECT e.consent_id FROM experience_events e JOIN experience_objects o ON o.id=e.object_id WHERE e.operation_id=$2::text::uuid AND o.subject_id=$1)' : task ? 'c.id=(SELECT consent_id FROM task_events WHERE id=$2::text::uuid AND subject_id=$1)' : target} AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS
      (SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)
    RETURNING sequence`, [subjectId, objectId, action, configuration || recruitment || project || contact || profile ? 'history' : qualificationRequest || experience ? 'assistance' : builder ? 'builders' : capsule ? 'capsules' : moderation ? 'moderation' : context ? 'context' : assistance ? 'assistance' : consent ? 'consent' : evidence ? 'evidence' : 'proof', httpRequestId, JSON.stringify(credentialScopes), callerBindingId]);
  if (result.rows.length === 1) return;
  const prior = await db.query('SELECT sequence FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3',
    [subjectId, action, objectId]);
  if (prior.rows.length !== 1) throw new Error('Audit context unavailable');
}
