import { ServiceError } from '../shared/service-error.mjs';

// All methods use the caller's transaction; Case create-link shares this lock.
export class TaskRepository {
  async get(db, id, { lock = false } = {}) {
    return (await db.query(`SELECT * FROM task_requests WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [id])).rows[0];
  }
  async lockId(db, id) { await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`task-v2:${id}`]); }
  async getParticipation(db, id, { lock = false } = {}) {
    return (await db.query(`SELECT * FROM task_participations WHERE id=$1 ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [id])).rows[0];
  }
  async participations(db, id) { return (await db.query('SELECT * FROM task_participations WHERE task_id=$1 ORDER BY id', [id])).rows; }
  async event(db, id) { return (await db.query('SELECT * FROM task_events WHERE id=$1', [id])).rows[0]; }
  async events(db, id) { return (await db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY version', [id])).rows; }
  async save(db, state) {
    await db.query('UPDATE task_requests SET version=$2,snapshot=$3,case_id=$4 WHERE id=$1',
      [state.request.taskId, state.version, JSON.stringify(state), state.request.caseId]);
  }
  async saveParticipation(db, state) {
    const saved = await db.query(`INSERT INTO task_participations(id,task_id,subject_id,version,snapshot) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot
      WHERE task_participations.task_id=EXCLUDED.task_id AND task_participations.subject_id=EXCLUDED.subject_id RETURNING id`,
    [state.participationId, state.taskId, state.subjectId, state.version, JSON.stringify(state)]);
    if (!saved.rows.length) throw new ServiceError('participation_conflict', 409);
  }
  async attachCase(db, { taskId, caseId, requesterId }) {
    const row = await this.get(db, taskId, { lock: true });
    if (!row || row.requester_id !== requesterId) throw new ServiceError('task_case_link_denied', 403);
    if (row.case_id && row.case_id !== caseId) throw new ServiceError('task_case_link_conflict', 409);
    if (row.case_id === caseId) return row;
    // Linking records identity, not a change of agreement; task version is unchanged.
    row.snapshot.request.caseId = caseId;
    await this.save(db, row.snapshot);
    return { ...row, case_id: caseId };
  }
}
