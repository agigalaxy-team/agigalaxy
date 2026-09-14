export const apiReads = Object.freeze({
  readSubject: (db, subjectId) => db.query('SELECT * FROM public.galaxy_api_lock_subject($1)', [subjectId]),
  lockEvidenceRead: (db, evidenceId, subjectId) => db.query('SELECT * FROM public.galaxy_api_lock_evidence_read($1,$2)', [evidenceId, subjectId]),
  lockEvidenceWrite: (db, evidenceId, subjectId) => db.query('SELECT * FROM public.galaxy_api_lock_evidence_write($1,$2)', [evidenceId, subjectId]),
});
