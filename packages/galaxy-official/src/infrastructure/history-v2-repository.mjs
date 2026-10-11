// Candidate scans are private implementation detail. Grants are checked before
// matching, pagination, or deriving a cursor. No candidate count is published.
export function historyV2Repository(db, candidateVisibility = null) {
  return {
    tasks: (subjectId, after = null) => db.query(`SELECT t.id FROM task_requests t
      WHERE ($2::uuid IS NULL OR t.id>$2) AND ($1::text IS NULL OR t.requester_id=$1 OR EXISTS
        (SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$1))
      ORDER BY t.id LIMIT 100`, [subjectId, after]).then(r => r.rows),
    cases: (subjectId, after = null) => db.query(`SELECT c.* FROM cases c
      WHERE ($2::uuid IS NULL OR c.id>$2) AND c.state<>'withdrawn' AND ($1::text IS NULL OR c.subject_id=$1
        OR EXISTS(SELECT 1 FROM case_events e WHERE e.case_id=c.id AND e.subject_id=$1)
        OR EXISTS(SELECT 1 FROM verification_objects v WHERE v.case_id=c.id AND v.subject_id=$1)
        OR EXISTS(SELECT 1 FROM task_requests t JOIN task_participations p ON p.task_id=t.id WHERE t.case_id=c.id AND p.subject_id=$1))
      AND (NOT $3::boolean
        OR c.subject_id=$4
        OR EXISTS(SELECT 1 FROM case_events e WHERE e.case_id=c.id AND e.subject_id=$4)
        -- An independently visible report, Task or reuse may still supply a
        -- history entry when the root event is private. Keep these candidates
        -- conservatively; only the canonical services decide their permission.
        OR EXISTS(SELECT 1 FROM verification_objects v WHERE v.case_id=c.id)
        OR EXISTS(SELECT 1 FROM task_requests t WHERE t.case_id=c.id)
        OR EXISTS(SELECT 1 FROM capsule_uses_v2 u WHERE u.case_id=c.id)
        OR EXISTS(SELECT 1 FROM evidence_submissions e JOIN proofs p ON p.evidence_id=e.id WHERE e.case_id=c.id)
        OR EXISTS(SELECT 1 FROM case_events e
          JOIN consents g ON g.id=e.consent_id AND g.subject_id=e.subject_id
          JOIN bindings b ON b.id=g.binding_id
          WHERE e.case_id=c.id AND octet_length(e.payload_text)>0
          AND g.revoked_at IS NULL AND b.revoked_at IS NULL AND g.expires_at>$5 AND b.expires_at>$5
          AND g.intent->>'action'='case.teaser.publish' AND g.intent->>'objectId'=e.id::text
          AND g.intent->>'recipient'=$6 AND g.intent->>'payloadHash'=e.payload_hash
          AND (g.intent->>'subjectId'=$4 OR (
            NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=e.subject_id
              AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
            AND ((g.intent->>'visibility'='Public' AND g.intent->>'purpose'='public-profile')
              OR (g.intent->>'visibility' IN ('Private','Hub-scoped') AND g.intent->'viewers' ? $4))))))
      ORDER BY c.id LIMIT 100`, [subjectId, after, candidateVisibility !== null, candidateVisibility?.viewerId ?? null,
        candidateVisibility ? new Date(candidateVisibility.now * 1000).toISOString() : null,
        candidateVisibility?.endpoint ?? null]).then(r => r.rows),
    records: caseId => db.query('SELECT id,object_type,subject_id FROM verification_objects WHERE case_id=$1 ORDER BY id', [caseId]).then(r => r.rows),
    proofs: caseId => db.query('SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE e.case_id=$1 ORDER BY p.id', [caseId]).then(r => r.rows),
    rootTaskEvent: taskId => db.query(`SELECT e.* FROM task_requests t JOIN task_events e ON e.id=t.root_event_id WHERE t.id=$1`, [taskId]).then(r => r.rows[0]),
  };
}
