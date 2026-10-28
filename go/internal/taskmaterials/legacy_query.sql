SELECT a.id FROM assistance_requests a
        JOIN cases parent ON parent.id=a.case_id
        JOIN assistance_events root ON root.id=a.id JOIN consents rootgrant ON rootgrant.id=root.consent_id
        WHERE ($1::uuid IS NULL OR a.id>$1) AND parent.state<>'withdrawn'
        AND ($2='open' AND NOT EXISTS(SELECT 1 FROM moderation_reports m WHERE (m.assistance_id=a.id OR m.case_id=a.case_id) AND m.paused=true) AND a.snapshot->>'state'='open' AND (a.snapshot->'request'->>'enrollmentExpiresAt')::bigint>$3
          OR $2='requested' AND a.requester_id=$4
          OR $2='requester-history' AND a.requester_id=$8
          OR $2='participating' AND EXISTS (SELECT 1 FROM assistance_events e WHERE e.assistance_id=a.id AND e.subject_id=$4))
        AND strpos(lower((a.snapshot->'request'->>'title') || ' ' || (a.snapshot->'request'->>'problem')),lower($5))>0
        AND (a.requester_id=$4 OR rootgrant.intent->>'visibility'='Public' AND rootgrant.intent->>'purpose'='public-profile'
          OR rootgrant.intent->>'visibility'='Private' AND rootgrant.intent->'viewers' ? $4)
        AND NOT EXISTS (SELECT 1 FROM assistance_events e LEFT JOIN consents c ON c.id=e.consent_id
          LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.assistance_id=a.id AND
          (c.id IS NULL OR b.id IS NULL OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$6 OR b.expires_at<=$6))
        AND NOT EXISTS (SELECT 1 FROM case_events e LEFT JOIN consents c ON c.id=e.consent_id
          LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.case_id=a.case_id AND
          (c.id IS NULL OR b.id IS NULL OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$6 OR b.expires_at<=$6))
        ORDER BY a.id LIMIT $7