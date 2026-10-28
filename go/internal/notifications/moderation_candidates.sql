WITH notices AS (
   SELECT 'moderation-report'::text kind,r.id event_id,r.id report_id,r.reporter_id actor_id,r.created_at FROM moderation_reports r JOIN consents c ON c.id=r.consent_id
    WHERE r.reporter_id<>$1 AND c.revoked_at IS NULL AND c.expires_at>$2 AND c.intent->'viewers' ? $1
   UNION ALL
   SELECT 'moderation-event',e.id,e.report_id,e.subject_id,e.created_at FROM moderation_events e JOIN consents c ON c.id=e.consent_id
    WHERE e.subject_id<>$1 AND c.revoked_at IS NULL AND c.expires_at>$2 AND c.intent->'viewers' ? $1
  ) SELECT n.*,NULL::uuid room_id,NULL::uuid task_id,'incidents'::text category,r.read_at
   FROM notices n LEFT JOIN notification_reads r ON r.subject_id=$1 AND r.kind=n.kind AND r.event_id=n.event_id
   WHERE n.created_at>$3 AND ($4::uuid IS NULL OR (n.event_id,n.kind)>($4::uuid,$5::text))
    AND ($6::text IS NULL OR n.kind=$6 AND n.event_id=$7::uuid) AND (NOT $8::boolean OR r.event_id IS NULL)
   ORDER BY n.event_id,n.kind LIMIT 200