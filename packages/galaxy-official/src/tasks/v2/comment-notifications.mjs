// Only IDs are candidates. Every delivery attempt rechecks the original source;
// neither a reply quotation nor a notification stores private source text.
export async function commentNotificationView(
  db,
  actor,
  c,
  { comments, commentGovernance },
) {
  if (c.kind === 'task-comment') {
    if (!comments) return null;
    const e = await comments.event(db, c.event_id);
    if (!e) return null;
    const row = await comments.row(db, e.comment_id);
    if (!row || row.current_event_id !== e.id) return null;
    const v = await comments.readWithin(db, actor, e.comment_id);
    if (!v.body) return null;
    return {
      title: '任务评论有更新',
      eventKind: e.kind,
      actorId: e.subject_id,
      object: {
        type: 'task-comment',
        id: e.comment_id,
        taskId: e.task_id,
        revision: e.revision,
      },
      sourceExpiresAt: v.expiresAt,
      serviceReceipt: false,
    };
  }
  if (!commentGovernance) return null;
  const e = (
    await db.query('SELECT * FROM comment_governance_events_v2 WHERE id=$1', [
      c.event_id,
    ])
  ).rows[0];
  if (!e) return null;
  const v = await commentGovernance.readWithin(db, actor, e.report_id);
  if (!v.events.some((x) => x.eventId === e.id)) return null;
  return {
    title: '评论处理记录有更新',
    eventKind: e.kind,
    actorId: e.subject_id,
    object: {
      type: 'comment-governance',
      id: e.report_id,
      taskId: c.task_id,
      eventId: e.id,
    },
    serviceReceipt: true,
  };
}
