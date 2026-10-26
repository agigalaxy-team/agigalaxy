import * as z from 'zod/v4';
import { recordNotificationAudit } from "../infrastructure/notification-audit.mjs";
import { notificationSettingsSchema, notificationQuerySchema, notificationIdSchema, notificationArchiveSchema, defaultNotificationSettings } from "../shared/notifications-schema.mjs";
import { ServiceError } from "../shared/service-error.mjs";

export async function checkInvitationLimit(db, subjectId) {
  await db.query('INSERT INTO notification_preferences(subject_id,settings) VALUES($1,$2) ON CONFLICT(subject_id) DO NOTHING', [subjectId, JSON.stringify(defaultNotificationSettings)]);
  await db.query('SELECT subject_id FROM notification_preferences WHERE subject_id=$1 FOR UPDATE', [subjectId]);
  const count = Number((await db.query(`SELECT count(*) FROM assistance_events WHERE subject_id=$1
    AND payload_text::jsonb->'event'->>'kind'='invite' AND created_at > now()-interval '1 hour'`, [subjectId])).rows[0].count);
  if (count >= 8) throw new ServiceError('invitation_rate_limit', 429);
}
export class NotificationService {
  constructor(access, assistance, context, capsules, incident=null) { Object.assign(this, { access, assistance, context, capsules, incident }); }
  async preferencesWithin(db, actor) {
    const row = (await db.query('SELECT * FROM notification_preferences WHERE subject_id=$1', [actor.subjectId])).rows[0];
    return { settings: notificationSettingsSchema.parse(row?.settings ?? structuredClone(defaultNotificationSettings)), revision: row?.revision ?? 0,
      archivedBefore: row?.archived_before ? new Date(row.archived_before).toISOString() : null, archiveSupported: true };
  }
  async preferences(actor) { return this.access.runAuthorized(actor, 'notifications', db => this.preferencesWithin(db, actor)); }
  async save(actor, input) {
    const parsed = z.strictObject({ expectedRevision: z.number().int().nonnegative(), settings: notificationSettingsSchema }).safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_notification_preferences');
    return this.access.runAuthorized(actor, 'notifications', async (db,authorization) => {
      await db.query('INSERT INTO notification_preferences(subject_id,settings) VALUES($1,$2) ON CONFLICT(subject_id) DO NOTHING', [actor.subjectId, JSON.stringify(defaultNotificationSettings)]);
      const current = (await db.query('SELECT revision,settings FROM notification_preferences WHERE subject_id=$1 FOR UPDATE', [actor.subjectId])).rows[0];
      if (current.revision !== parsed.data.expectedRevision) throw new ServiceError('notification_preferences_conflict', 409);
      // Older notification clients do not know discovery settings. Preserve them
      // under the same revision lock instead of silently opting the owner out.
      if (parsed.data.settings.discovery === undefined && current.settings.discovery !== undefined)
        parsed.data.settings.discovery = current.settings.discovery;
      await db.query('UPDATE notification_preferences SET settings=$2,revision=revision+1,updated_at=now() WHERE subject_id=$1', [actor.subjectId, JSON.stringify(parsed.data.settings)]);
      await recordNotificationAudit(db,actor,authorization,{action:'notification.preferences',objectId:actor.subjectId,idempotencyKey:actor.subjectId+':'+(current.revision+1)});
      return this.preferencesWithin(db, actor);
    });
  }
  async archive(actor, input) {
    const parsed = notificationArchiveSchema.safeParse(input);
    if (!parsed.success || parsed.data.before > this.access.now()) throw new ServiceError('invalid_notification_archive');
    return this.access.runAuthorized(actor, 'notifications', async (db, authorization) => {
      await db.query('INSERT INTO notification_preferences(subject_id,settings) VALUES($1,$2) ON CONFLICT(subject_id) DO NOTHING', [actor.subjectId, JSON.stringify(defaultNotificationSettings)]);
      const current = (await db.query('SELECT revision,archived_before FROM notification_preferences WHERE subject_id=$1 FOR UPDATE', [actor.subjectId])).rows[0];
      const before = new Date(parsed.data.before * 1000).toISOString();
      // A lost-response retry is harmless even after its revision has advanced.
      if (current.archived_before && new Date(current.archived_before).toISOString() === before)
        return { ...await this.preferencesWithin(db, actor), removedReadMarkers: 0 };
      if (current.revision !== parsed.data.expectedRevision) throw new ServiceError('notification_preferences_conflict', 409);
      if (current.archived_before && new Date(current.archived_before).getTime() > parsed.data.before * 1000)
        throw new ServiceError('notification_archive_cannot_rewind', 409);
      await db.query('UPDATE notification_preferences SET archived_before=$2,revision=revision+1,updated_at=now() WHERE subject_id=$1', [actor.subjectId, before]);
      const removed = await db.query('DELETE FROM notification_reads WHERE subject_id=$1 AND read_at<$2 RETURNING event_id', [actor.subjectId, before]);
      await recordNotificationAudit(db, actor, authorization, { action: 'notification.archive', objectId: actor.subjectId, idempotencyKey: actor.subjectId+':'+(current.revision+1) });
      return { ...await this.preferencesWithin(db, actor), removedReadMarkers: removed.rows.length };
    });
  }
  async visible(db, actor, candidate, assistanceCache = new Map()) {
    if(candidate.kind==='incident'){
      const row=(await db.query('SELECT incident_id,incident_revision,title,summary,operator_ref FROM incident_notices WHERE id=$1 AND subject_id=$2',[candidate.event_id,actor.subjectId])).rows[0];
      return row?{title:row.title,summary:row.summary,actorId:'operator:'+row.operator_ref,eventKind:'incident-update',incidentId:row.incident_id,incidentRevision:row.incident_revision}:null;
    }
    if (candidate.kind === 'capsule') return this.capsules.visibleUpdate(db, actor, candidate.event_id);
    if (candidate.kind === 'assistance') {
      if (!assistanceCache.has(candidate.assistance_id)) assistanceCache.set(candidate.assistance_id, this.assistance.load(db, candidate.assistance_id, {readOnly:true}));
      const { row, events, grants } = await assistanceCache.get(candidate.assistance_id);
      const event = events.find(item => item.id === candidate.event_id);
      if (!event || event.subject_id === actor.subjectId || !this.assistance.visible(grants.get(row.id), actor.subjectId)
        || !this.assistance.visible(grants.get(event.id), actor.subjectId)) return null;
      const payload = JSON.parse(event.payload_text).event;
      if (!payload || payload.kind === 'shortlist') return null;
      return { title: row.snapshot.request.title, eventKind: payload.kind, actorId: event.subject_id, summary: payload.note ?? payload.summary ?? payload.reason ?? null };
    }
    const grantId = candidate.grant_id;
    const metadata = await this.context.readWithin(db, actor, grantId, false);
    return { title: 'Selected material grant', eventKind: candidate.kind === 'context' ? 'material-grant' : 'material-accepted',
      actorId: candidate.actor_id, grantId: metadata.grantId };
  }
  async candidates(db, actor, options, settings, exact = null, archivedBefore = null) {
    const after = options.after?.split(':');
    return (await db.query(`WITH inbox AS (
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
      ORDER BY i.event_id,i.kind LIMIT $11`, [actor.subjectId, after?.[1] ?? null, after?.[0] ?? null, options.unreadOnly ?? false,
      settings.invitations, settings.collaboration, settings.materials, settings.mutedAssistanceIds,
      exact?.[0] ?? null, exact?.[1] ?? null, exact ? 1 : 200, settings.capsules, new Date(this.access.now()*1000).toISOString(),settings.incidents,!!this.incident&&!this.incident.canProcessEvidence(),archivedBefore])).rows;
  }
  async query(actor, input = {}) {
    const parsed = notificationQuerySchema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_notification_query');
    return this.access.runAuthorized(actor, 'notifications', async db => {
      const preferences = await this.preferencesWithin(db, actor);
      if (!preferences.settings.enabled) return { items: [], nextAfter: null, enabled: false };
      const candidates = await this.candidates(db, actor, parsed.data, preferences.settings, null, preferences.archivedBefore), items = [];
      const assistanceCache = new Map();
      for (const candidate of candidates) {
        try {
          const visible = await this.visible(db, actor, candidate, assistanceCache); if (!visible) continue;
          items.push({ id: `${candidate.kind}:${candidate.event_id}`, assistanceId: candidate.assistance_id,
            category: candidate.category, at: new Date(candidate.created_at).toISOString(), read: !!candidate.read_at, ...visible });
          if (items.length > parsed.data.limit) break;
        } catch (error) { if (!(error instanceof ServiceError) || ![403,404].includes(error.status)) throw error; }
      }
      return { items: items.slice(0, parsed.data.limit), nextAfter: items.length > parsed.data.limit ? items[parsed.data.limit-1].id : candidates.length === 200 ? `${candidates.at(-1).kind}:${candidates.at(-1).event_id}` : null, enabled: true };
    });
  }
  async markRead(actor, { id }) {
    if (!notificationIdSchema.safeParse(id).success) throw new ServiceError('invalid_notification_id');
    return this.access.runAuthorized(actor, 'notifications', async (db,authorization) => {
      const preferences = await this.preferencesWithin(db, actor);
      const candidates = await this.candidates(db, actor, {}, preferences.settings, id.split(':'), preferences.archivedBefore);
      if (!preferences.settings.enabled || !candidates.length || !await this.visible(db, actor, candidates[0])) throw new ServiceError('not_found', 404);
      // Match invitation lock order (source before preferences), then recheck the
      // cutoff under the archive lock so a concurrent archive cannot resurrect it.
      await db.query('INSERT INTO notification_preferences(subject_id,settings) VALUES($1,$2) ON CONFLICT(subject_id) DO NOTHING', [actor.subjectId, JSON.stringify(defaultNotificationSettings)]);
      await db.query('SELECT subject_id FROM notification_preferences WHERE subject_id=$1 FOR UPDATE', [actor.subjectId]);
      const current = await this.preferencesWithin(db, actor);
      if (!current.settings.enabled || !(await this.candidates(db, actor, {}, current.settings, id.split(':'), current.archivedBefore)).length)
        throw new ServiceError('not_found', 404);
      const [kind,eventId] = id.split(':');
      const inserted=await db.query('INSERT INTO notification_reads(subject_id,kind,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [actor.subjectId,kind,eventId]);
      if(inserted.rows.length)await recordNotificationAudit(db,actor,authorization,{action:'notification.read',objectId:eventId,idempotencyKey:id});
      return { id, read: true };
    });
  }
}
