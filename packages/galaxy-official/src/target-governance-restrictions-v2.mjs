import { ServiceError } from './shared/service-error.mjs';

// Caller first establishes the real target and ordinary current source access.
// This projection contains only effective operational restrictions, never private
// complaint text or a professional capability verdict. It is not a permission.
export async function targetRestrictionsWithin(db, type, id, now) {
  if (!['task', 'room'].includes(type)) throw new TypeError('Unknown governance target');
  const ids = [id];
  if (type === 'room') {
    const parent = (await db.query('SELECT parent_room_id FROM chat_rooms WHERE room_id=$1', [id])).rows[0]?.parent_room_id;
    if (parent) ids.push(parent);
  }
  const rows = (await db.query(`SELECT id,restriction_scopes,restriction_until,restriction_event_id FROM target_reports_v2
    WHERE ${type === 'task' ? 'task_id' : 'room_id'}=ANY($1::uuid[]) AND restriction_until>$2 ORDER BY id`, [ids, new Date(now * 1000)])).rows;
  return { scopes: [...new Set(rows.flatMap(r => r.restriction_scopes))], restrictions: rows.map(r => ({ reportId: r.id,
    eventId: r.restriction_event_id, scopes: r.restriction_scopes, until: new Date(r.restriction_until).toISOString() })),
    authority: 'current-target-operation-restrictions; not-capability-or-source-permission' };
}
export function assertTargetOperation(restrictions, scope) {
  if (restrictions.scopes.includes(scope)) throw new ServiceError('target_operation_restricted', 409, { scope, restrictions: restrictions.restrictions });
}
