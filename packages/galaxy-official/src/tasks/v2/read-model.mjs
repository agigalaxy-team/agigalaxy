import {transaction} from "../../database.mjs";
import {ServiceError} from "../../shared/service-error.mjs";
import {taskReceiptV2Schema,taskQueryV2Schema} from "../../shared/task-schema-v2.mjs";
import {legacyAssistanceTaskV2} from "../../domain/task-v2.mjs";
import {hasTaskMaterials,hasTaskText} from "../../shared/task-material-v1-schema.mjs";
import {uuid,absent} from './helpers.mjs';
import {TaskAuthorityV2} from './authority.mjs';

// Current authorized Task/Participation projections, exact receipt lookup and disclosure-safe public/owner pagination; unreadable candidates never become keyword hits.
export class TaskReadModelV2 extends TaskAuthorityV2{
  async taskReceipt(actor, input) {
    const parsed = taskReceiptV2Schema.safeParse(input); if (!parsed.success) throw new ServiceError('invalid_task_receipt');
    return this.access.runAuthorized(actor, 'assistance', async db => {
      const row = await this.taskRepository.event(db, parsed.data.eventId);
      if (row && row.subject_id !== actor.subjectId) throw new ServiceError('not_found', 404);
      const matches = row && row.task_id === input.taskId && row.payload_hash === input.payloadHash;
      return { ...parsed.data, state: !row ? 'absent' : matches ? 'acknowledged' : 'conflict', checkedAt: this.access.now(),
        ...(matches ? { version: row.version, participationVersion: row.participation_version,
          participationId: row.participation_id ?? null, kind: row.kind } : {}),
        authority: 'accepted-event-only; not-current-authorization' };
    });
  }
  async readTaskWithin(db, actor, id) {
    const { row, paused, governance } = await this.requireTaskWithin(db, actor, id);
    const state = row.snapshot, requester = actor?.subjectId === row.requester_id;
    const result = { schemaVersion: 2, taskId: id, caseId: row.case_id, request: state.request, requesterId: row.requester_id,
      version: state.version, state: state.state, enrollmentOpen: state.state === 'open' && state.request.enrollmentExpiresAt > this.access.now()&&!governance.scopes.includes('new-participation-paused'),
      paused, governance, paymentExecuted: false, contextAccessGranted: false, roomMembershipGranted: false,
      compatibility: { writableApiVersion: 2, legacyWrites: false }, view: requester ? 'requester' : actor ? 'participant-or-reader' : 'public' };
    if(hasTaskMaterials(state.request)||hasTaskText(state.request)){
      if(!this.taskMaterials)throw new ServiceError('task_material_reader_unavailable',503);
      Object.assign(result,await this.taskMaterials.projectWithin(db,actor,row));
    }
    if (!actor) return result;
    const visibleIds = new Set(), events = await this.taskRepository.events(db, id);
    for (const event of events) {
      try { if (this.visible(await this.taskGrant(db, event), actor.subjectId)) visibleIds.add(event.id); }
      catch (error) { if (!absent(error)) throw error; }
    }
    const visible = eventId => visibleIds.has(eventId);
    const suggestions = requester && visible(state.suggestions.eventId) ? structuredClone(state.suggestions)
      : { state: requester ? 'not-available' : 'private', items: [] };
    const invitations = state.invitations.filter(i => (requester || i.recipientId === actor.subjectId) && visible(i.invitationId)).map(i => {
      const replies = i.replies.filter(r => visible(r.eventId));
      return { ...i, state: i.state === 'revoked' ? 'revoked' : i.expiresAt <= this.access.now() ? 'expired' : replies.at(-1)?.response ?? 'pending', replies };
    });
    const applications = state.applications.filter(a => (requester || a.subjectId === actor.subjectId) && visible(a.applicationId));
    result.contacts = { suggestions, responses: { invitations, applications } };
    const rows = await this.taskRepository.participations(db, id);
    result.participations = rows.filter(p => (requester || p.subject_id === actor.subjectId) && visible(p.snapshot.proposalEventId)).map(p => {
      const own = structuredClone(p.snapshot);
      if (!visible(own.scopeEventId)) { own.agreedScope = null; own.scopeAvailable = false; }
      if (own.pendingScope && !visible(own.pendingScope.eventId)) own.pendingScope = null;
      own.deliveries = own.deliveries.filter(d => visible(d.deliveryId)).map(d => ({ ...d,
        acceptance: d.acceptance && visible(d.acceptance.eventId) ? d.acceptance : null }));
      if (own.dispute && !visible(own.dispute.eventId)) own.dispute = null;
      if (own.disputeResolution && !visible(own.disputeResolution.eventId)) own.disputeResolution = null;
      if (own.feedback && !visible(own.feedback.eventId)) own.feedback = null;
      own.events = own.events.filter(e => visible(e.event.eventId));
      return own;
    });
    return result;
  }
  async getTask(actor, id) {
    if (!uuid(id)) throw new ServiceError('not_found', 404);
    return this.access.runAuthorized(actor, 'assistance', async db => {
      if (await this.taskRepository.get(db, id)) return this.readTaskWithin(db, actor, id);
      const legacy = await this.readWithin(db, actor, id); return legacyAssistanceTaskV2(legacy);
    });
  }
  async getPublicTask(id) {
    if (!uuid(id)) throw new ServiceError('not_found', 404);
    return transaction(this.access.db, db => this.readTaskWithin(db, null, id));
  }
  async queryTasksWithin(db, actor, options) {
    const items = []; let position = options.after ?? null;
    for (;;) {
    const candidates = (await db.query(`SELECT id FROM task_requests
      WHERE ($1::uuid IS NULL OR id>$1)
      AND ($2='open' AND snapshot->>'state'='open' AND (snapshot->'request'->>'enrollmentExpiresAt')::bigint>$3
        OR $2='requested' AND requester_id=$4
        OR $2='participating' AND EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=task_requests.id AND p.subject_id=$4)
        OR $2='participating' AND snapshot->'invitations' @> jsonb_build_array(jsonb_build_object('recipientId',$4::text))
        OR $2='participating' AND EXISTS(SELECT 1 FROM task_events e WHERE e.task_id=task_requests.id AND e.subject_id=$4))
      ORDER BY id LIMIT 100`, [position, options.view, this.access.now(), actor?.subjectId ?? null])).rows;
    for (const candidate of candidates) {
      try {
        const item = await this.readTaskWithin(db, actor, candidate.id);
        if (options.view === 'open' && (item.paused||item.governance.scopes.some(s=>['discovery-hidden','new-participation-paused'].includes(s)))) continue;
        // Match only the currently readable request. Neither private keyword
        // hits nor an unavailable candidate's ID become a count or cursor.
        if (!`${item.request.title} ${item.request.summary}`.toLowerCase().includes(options.query.toLowerCase())) continue;
        const { contacts: _contacts, participations: _participations, ...publicSummary } = item;
        items.push(publicSummary);
        if (items.length > options.limit) break;
      } catch (error) { if (!absent(error)) throw error; }
    }
    if (items.length > options.limit || candidates.length < 100) break;
    position = candidates.at(-1).id;
    }
    return { items: items.slice(0, options.limit), nextAfter: items.length > options.limit ? items[options.limit - 1].taskId
      : null, coverage: 'visible-page-only' };
  }
  async queryTasks(actor, input = {}) {
    const options = taskQueryV2Schema.safeParse(input); if (!options.success) throw new ServiceError('invalid_task_query');
    return this.access.runAuthorized(actor, 'assistance', db => this.queryTasksWithin(db, actor, options.data));
  }
  async queryPublicTasks(input = {}) {
    const options = taskQueryV2Schema.safeParse(input); if (!options.success || options.data.view !== 'open') throw new ServiceError('invalid_task_query');
    return transaction(this.access.db, db => this.queryTasksWithin(db, null, options.data));
  }
}
