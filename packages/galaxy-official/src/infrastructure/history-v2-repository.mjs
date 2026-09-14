// Candidate scans are private implementation detail. Grants are checked before
// matching, pagination, or deriving a cursor. No candidate count is published.
export function historyV2Repository(db) {
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
      ORDER BY c.id LIMIT 100`, [subjectId, after]).then(r => r.rows),
    records: caseId => db.query('SELECT id,object_type,subject_id FROM verification_objects WHERE case_id=$1 ORDER BY id', [caseId]).then(r => r.rows),
    proofs: caseId => db.query('SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE e.case_id=$1 ORDER BY p.id', [caseId]).then(r => r.rows),
    rootTaskEvent: taskId => db.query(`SELECT e.* FROM task_requests t JOIN task_events e ON e.id=t.root_event_id WHERE t.id=$1`, [taskId]).then(r => r.rows[0]),
  };
}
