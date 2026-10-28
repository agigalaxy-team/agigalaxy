WITH inbox AS (
      SELECT 'incident'::text AS kind,n.id AS event_id,NULL::uuid AS assistance_id,NULL::uuid AS grant_id,
        NULL::text AS actor_id,n.created_at,'incidents'::text AS category FROM incident_notices n WHERE n.subject_id=$1
      UNION ALL
      SELECT 'assistance'::text AS kind,e.id AS event_id,e.assistance_id,NULL::uuid AS grant_id,e.subject_id AS actor_id,e.created_at,
        CASE WHEN e.payload_text::jsonb->'event'->>'kind'='invite' THEN 'invitations' ELSE 'collaboration' END AS category
      FROM assistance_events e JOIN consents c ON c.id=e.consent_id JOIN assistance_requests a ON a.id=e.assistance_id
      WHERE e.subject_id<>$1 AND e.payload_text::jsonb ? 'event'
        AND (c.intent->'viewers' ? $1 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
          AND (a.requester_id=$1 OR a.snapshot->'selected'->>'providerId'=$1))
      UNION ALL
      SELECT 'context',g.id,g.assistance_id,g.id,g.subject_id,g.created_at,'materials' FROM context_grants g WHERE g.participant_id=$1
      UNION ALL
      SELECT 'context-accept',a.id,g.assistance_id,g.id,a.subject_id,a.created_at,'materials'
      FROM context_acceptances a JOIN context_grants g ON g.id=a.grant_id WHERE g.subject_id=$1
      UNION ALL
      SELECT DISTINCT 'capsule',e.id,NULL::uuid,NULL::uuid,e.subject_id,e.created_at,'capsules'
      FROM capsule_events e JOIN (
        SELECT capsule_id,subject_id,observed_revision,consent_id FROM capsule_uses
        UNION ALL SELECT capsule_id,subject_id,observed_revision,consent_id FROM capsule_uses_v2
      ) u ON u.capsule_id=e.capsule_id AND u.observed_revision<e.revision
        JOIN consents c ON c.id=u.consent_id JOIN bindings b ON b.id=c.binding_id
      WHERE u.subject_id=$1 AND e.subject_id<>$1 AND c.revoked_at IS NULL AND b.revoked_at IS NULL
        AND c.expires_at>$13::timestamptz AND b.expires_at>$13::timestamptz
    ) SELECT i.*,r.read_at FROM inbox i LEFT JOIN notification_reads r ON r.subject_id=$1 AND r.kind=i.kind AND r.event_id=i.event_id
      WHERE ($2::uuid IS NULL OR (i.event_id,i.kind)>($2::uuid,$3::text))
      AND ($16::timestamptz IS NULL OR i.created_at >= $16::timestamptz)
      AND (NOT $15::boolean OR i.kind='incident')
      AND (NOT $4::boolean OR r.event_id IS NULL)
      AND (i.category='invitations' AND $5 OR i.category='collaboration' AND $6 OR i.category='materials' AND $7 OR i.category='capsules' AND $12 OR i.category='incidents' AND $14)
      AND (i.assistance_id IS NULL OR NOT (i.assistance_id=ANY($8::uuid[])))
      AND ($9::text IS NULL OR i.kind=$9 AND i.event_id=$10::uuid)
      ORDER BY i.event_id,i.kind LIMIT $11