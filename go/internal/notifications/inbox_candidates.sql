WITH inbox AS (
  SELECT 'room-message'::text kind,m.message_id event_id,m.room_id,NULL::uuid task_id,m.subject_id actor_id,m.sent_at created_at,'rooms'::text category
   FROM chat_message_refs m JOIN chat_memberships s ON s.room_id=m.room_id AND s.subject_id=$1 AND s.left_at IS NULL
   WHERE m.subject_id<>$1 AND m.state='accepted' AND m.expires_at>$2
  UNION ALL
  SELECT 'room-invite',d.decision_id,d.room_id,NULL::uuid,d.proposer_subject_id,d.created_at,'invitations'
   FROM chat_decisions d JOIN chat_rooms r USING(room_id) WHERE d.action='invite' AND d.payload->>'targetSubjectId'=$1
   AND d.state='approved' AND d.expires_at>$2 AND d.member_revision=r.member_revision AND r.state<>'archived'
  UNION ALL
  SELECT 'task-v2',e.id,NULL::uuid,e.task_id,e.subject_id,e.created_at,
   CASE WHEN e.kind='invite' THEN 'invitations' ELSE 'collaboration' END
   FROM task_events e JOIN task_requests t ON t.id=e.task_id JOIN consents c ON c.id=e.consent_id
   WHERE e.subject_id<>$1 AND e.kind NOT IN ('create','suggest-contacts') AND
    (t.requester_id=$1 OR c.intent->'viewers' ? $1 OR EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$1))
  UNION ALL
  SELECT 'task-comment',e.id,NULL::uuid,c.task_id,e.subject_id,e.created_at,'collaboration'
   FROM task_comment_events_v2 e JOIN task_comments_v2 c ON c.id=e.comment_id JOIN task_requests t ON t.id=c.task_id
   LEFT JOIN task_comments_v2 parent ON parent.id=c.reply_to_id
   WHERE e.id=c.current_event_id AND e.kind<>'retract' AND e.subject_id<>$1 AND (t.requester_id=$1 OR parent.subject_id=$1)
  UNION ALL
  SELECT 'comment-governance',e.id,NULL::uuid,c.task_id,e.subject_id,e.created_at,'incidents'
   FROM comment_governance_events_v2 e JOIN comment_reports_v2 r ON r.id=e.report_id JOIN task_comments_v2 c ON c.id=r.comment_id JOIN consents s ON s.id=e.consent_id
   WHERE e.subject_id<>$1 AND s.intent->'viewers' ? $1
  UNION ALL
  SELECT 'qualification-request',e.id,NULL::uuid,r.task_id,e.subject_id,e.created_at,'materials'
   FROM qualification_permission_request_events e JOIN qualification_permission_requests r ON r.id=e.request_id
   WHERE e.subject_id<>$1 AND (r.subject_id=$1 OR r.source_author_id=$1) AND r.expires_at>$2
  UNION ALL
  SELECT 'information-change',e.id,NULL::uuid,NULL::uuid,e.subject_id,e.available_at,'materials'
   FROM information_watch_changes_v2 e WHERE e.subject_id=$1 AND e.available_at<=$2 AND e.expires_at>$2
  UNION ALL
  SELECT 'target-governance',e.id,r.room_id,r.task_id,e.subject_id,e.created_at,'incidents'
   FROM target_governance_events_v2 e JOIN target_reports_v2 r ON r.id=e.report_id JOIN consents s ON s.id=e.consent_id
   WHERE e.subject_id<>$1 AND (s.intent->'viewers' ? $1 OR r.party_ids ? $1 AND e.kind IN ('review','pause','resolve','resume','appeal','withdraw-report'))
 ) SELECT i.*,r.read_at FROM inbox i LEFT JOIN notification_reads r ON r.subject_id=$1 AND r.kind=i.kind AND r.event_id=i.event_id
  WHERE i.created_at>$3 AND ($4::uuid IS NULL OR (i.event_id,i.kind)>($4::uuid,$5::text))
  AND ($6::text IS NULL OR i.kind=$6 AND i.event_id=$7::uuid) AND (NOT $8::boolean OR r.event_id IS NULL)
  ORDER BY i.event_id,i.kind LIMIT 200