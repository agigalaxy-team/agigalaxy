import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { discoveryQueryV2Schema, discoveryDetailV2Schema, sameOpportunityRef } from './shared/discovery-schema-v2.mjs';
import { historyV2QuerySchema } from './shared/history-v2-schema.mjs';
import { defaultDiscoveryPreferences } from './shared/discovery-schema.mjs';
import { effectiveDiscovery, matchProjects, contactFunctions } from './domain/discovery-match.mjs';
import { ServiceError } from './shared/service-error.mjs';
import { digest } from './shared/digest.mjs';
import { transaction } from './database.mjs';

const windowSize = 200, cursorSeconds = 900;
const entries = ['discover', 'publish-task', 'participate-task', 'ordinary-chat'];
const parse = (schema, input) => { const result = schema.safeParse(input); if (!result.success) throw new ServiceError('invalid_discovery_v2_query'); return result.data; };

// The temporary cursor key stores no query or candidate data and requires no
// persistent credential. Restart/another process intentionally requires restart
// of pagination. Raw positions could identify private profiles, so never encode
// them in a plain base64 cursor. Every page still checks current source access.
export class DiscoveryV2Service {
  constructor(access, { profiles, notifications, history, projects=null, inbox=null, scanWindowLimit = windowSize } = {}) {
    if (!Number.isInteger(scanWindowLimit) || scanWindowLimit < 1 || scanWindowLimit > windowSize) throw new Error('Invalid discovery scan window');
    Object.assign(this, { access, profiles, notifications, history, projects, inbox });
    this.scanWindowLimit = scanWindowLimit;
    this.cursorKey = randomBytes(32);
  }
  run(actor, operation) {
    return actor ? this.access.runAuthorized(actor, 'history', operation) : transaction(this.access.db, operation);
  }
  sealCursor(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
    cipher.setAAD(Buffer.from('galaxy-discovery-v2'));
    const body = Buffer.concat([cipher.update(JSON.stringify({ ...value, expiresAt: this.access.now() + cursorSeconds })), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  openCursor(value, queryHash, viewerId) {
    try {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value || bytes.length < 29) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.cursorKey, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from('galaxy-discovery-v2')); cipher.setAuthTag(bytes.subarray(12, 28));
      const cursor = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
      if (cursor.v !== 2 || cursor.queryHash !== queryHash || cursor.viewerId !== viewerId || cursor.expiresAt <= this.access.now()) throw new Error();
      return cursor;
    } catch { throw new ServiceError('discovery_cursor_unavailable_restart', 409); }
  }
  async contextWithin(db, actor, options) {
    let source, sourceRef = null;
    if (options.context.kind === 'project') {
      if (!actor) throw new ServiceError('access_denied', 401);
      const own = await this.profiles.readWithin(db, actor, actor.subjectId);
      source = own.selfDeclared.projects?.find(project => project.id === options.context.projectId);
      if(this.projects&&(await db.query('SELECT id FROM projects_v2 WHERE id=$1',[options.context.projectId])).rows.length){
        const project=await this.projects.readWithin(db,actor,options.context.projectId);
        source={...project.document,id:project.projectId};
        sourceRef={sourceKind:'project',subjectId:project.ownerId,projectId:project.projectId,
          documentEventId:project.source.documentEventId,policyEventId:project.source.policyEventId};
      }
      if (!source) throw new ServiceError('discovery_project_not_found', 404);
      sourceRef ??= { subjectId: actor.subjectId, projectId: source.id, statementId: own.selfDeclaredSource.id };
    } else source = options.context;
    const settings = actor ? (await this.notifications.preferencesWithin(db, actor)).settings.discovery : null;
    const current = settings ? effectiveDiscovery(settings, this.access.now()) : null;
    // An explicit active query supplies its own purposes/functions. It does not
    // opt its author into being discovered. Missing default preferences are not
    // an explicit refusal; a saved off/pause remains authoritative.
    const enabled = !current || current.enabled;
    const wish=this.projects&&sourceRef?.sourceKind==='project'
      ?await this.projects.effectiveWishWithin(db,actor.subjectId,source.id,{active:true,purposes:options.purposes})
      :{enabled,purposes:options.purposes,functions:[],temporaryUntil:current?.temporaryUntil??null};
    return { source, sourceRef, wish };
  }
  async opportunityWithin(db, actor, row, context) {
    if(this.inbox&&await this.inbox.isBlockedWithin(db,actor?.subjectId,row.subject_id))return [];
    const profile = await this.profiles.readWithin(db, actor, row.subject_id);
    const saved = await this.notifications.preferencesWithin(db, { subjectId: row.subject_id });
    const wish = effectiveDiscovery(saved.settings.discovery ?? defaultDiscoveryPreferences, this.access.now());
    const items=this.recruitment?await this.recruitment.opportunitiesWithin(db,actor,row.subject_id,context):[];
    if (!wish.enabled) return items;
    const statement = profile.selfDeclaredSource?(await db.query('SELECT revision,created_at FROM profile_statements WHERE id=$1', [profile.selfDeclaredSource.id])).rows[0]:null;
    const imported=this.projects?(await db.query('SELECT id FROM projects_v2 WHERE creator_id=$1 AND source_statement_id IS NOT NULL',[row.subject_id])).rows.map(p=>p.id):[];
    for (const project of profile.selfDeclared.projects ?? []) {
      if (!statement||!project.discoverable||imported.includes(project.id)) continue;
      const match = matchProjects(context.source, project, context.wish, wish);
      if (!match) continue;
      const opportunityRef = { subjectId: row.subject_id, projectId: project.id, statementId: profile.selfDeclaredSource.id };
      items.push({ id: digest(JSON.stringify(opportunityRef)), opportunityRef, subjectId: row.subject_id,
        projectId: project.id, project, displayName: profile.selfDeclared.displayName ?? null,
        participant: { subjectId: row.subject_id, kind: 'unknown', kindSource: 'not-declared-in-current-profile' },
        classification: 'self-declared', capabilityVerified: false, match,
        help: { statement: project.summary, functions: contactFunctions(match.sharedFunctions,context.wish,wish), purposes: match.purposes,
          basis: 'current-project-declaration-and-expressed-discovery-willingness', commitment: 'not-contacted' },
        contactState: 'welcome', willingness: { classification: 'expressed-preference', revision: saved.revision,
          purposes: match.purposes, temporaryUntil: wish.temporaryUntil, requiresRecipientAcceptance: true },
        sources: [{ ...opportunityRef, revision: statement.revision,
          recordedAt: new Date(statement.created_at).toISOString(), sourceUrl: project.sourceUrl ?? null }],
        experience: { status: 'not-loaded', refs: [], lookup: 'discovery-detail', absenceMeaning: 'not-a-history-or-capability-judgment' },
        nextActions: ['inspect', 'consider-contact'], invitationSent: false, roomJoined: false,
      });
    }
    if(this.projects)for(const record of (await db.query("SELECT id,created_at FROM projects_v2 WHERE owner_id=$1 AND state='active' ORDER BY id",[row.subject_id])).rows){
      let view;
      try{view=await this.projects.readWithin(db,actor,record.id);}catch(error){if(error instanceof ServiceError&&[403,404].includes(error.status))continue;throw error;}
      if(view.operationsVisibility?.hidden||!view.document.discoverable)continue;
      const project={...view.document,id:view.projectId},specific=await this.projects.effectiveWishWithin(db,row.subject_id,project.id);
      const match=matchProjects(context.source,project,context.wish,specific);if(!match)continue;
      const opportunityRef={sourceKind:'project',subjectId:row.subject_id,projectId:project.id,documentEventId:view.source.documentEventId,policyEventId:view.source.policyEventId};
      items.push({id:digest(JSON.stringify(opportunityRef)),opportunityRef,subjectId:row.subject_id,projectId:project.id,project,
        displayName:profile.selfDeclared.displayName??null,
        participant:{subjectId:row.subject_id,kind:project.participantKind,kindSource:'self-declared-project-document'},
        classification:'self-declared',capabilityVerified:false,match,
        help:{statement:project.summary,functions:contactFunctions(match.sharedFunctions,context.wish,specific),purposes:match.purposes,basis:'current-project-declaration-and-expressed-discovery-willingness',commitment:'not-contacted'},
        contactState:'welcome',willingness:{classification:'expressed-preference',purposes:match.purposes,temporaryUntil:specific.temporaryUntil,requiresRecipientAcceptance:true},
        sources:[{sourceKind:'project',projectId:project.id,revision:view.revision,...view.source,recordedAt:new Date(record.created_at).toISOString(),sourceUrl:project.sourceUrl??null}],
        experience:{status:'not-loaded',refs:[],lookup:'discovery-detail',absenceMeaning:'not-a-history-or-capability-judgment'},nextActions:['inspect','consider-contact'],invitationSent:false,roomJoined:false});
    }
    return items;
  }
  async query(actor, input) {
    const options = parse(discoveryQueryV2Schema, input);
    return this.run(actor, db => this.queryWithin(db, actor, options));
  }
  async queryWithin(db, actor, options) {
    const context = await this.contextWithin(db, actor, options), viewerId = actor?.subjectId ?? null;
    const result = { schemaVersion: 2, items: [], nextAfter: null, enabled: context.wish.enabled,
      sourceContext: { kind: options.context.kind, ref: context.sourceRef, persistedContext: false },
      computedAt: this.access.now(), method: 'functional-tags-v1', capabilityVerified: false,
      activeEntries: entries, interpretation: 'user-side-model-or-user',
      coverage: { windowLimited: false, scanWindowLimit: this.scanWindowLimit, ordering: 'functional-overlap-within-window',
        recruitmentPerSubjectLimit: this.recruitment?200:null, recruitmentFullPagination: this.recruitment?'/v2/recruitment/query':null,
        globalCountProvided: false, globalRanking: false, currentAuthorizedSources: true },
    };
    if (!context.wish.enabled) return { ...result, disabledReason: 'explicit-discovery-off-or-paused' };
    const queryHash = digest(JSON.stringify({ context: options.context, sourceRef: context.sourceRef, purposes: options.purposes, limit: options.limit }));
    const cursor = options.after ? this.openCursor(options.after, queryHash, viewerId) : { startAfter: null, lastKey: null };
    const rows = (await db.query(`SELECT subject_id FROM (
      SELECT DISTINCT subject_id FROM (${this.projects?"SELECT subject_id FROM profile_statements UNION SELECT owner_id AS subject_id FROM projects_v2 WHERE state='active'":"SELECT subject_id FROM profile_statements"}${this.recruitment?" UNION SELECT contact_subject_id AS subject_id FROM recruitment_opportunities WHERE state='active'":''}) sources
      WHERE ($1::text IS NULL OR subject_id<>$1) AND ($2::text IS NULL OR subject_id>$2)
      ORDER BY subject_id
    ) latest ORDER BY subject_id LIMIT $3`, [viewerId, cursor.startAfter, this.scanWindowLimit + 1])).rows;
    const window = rows.slice(0, this.scanWindowLimit), items = [];
    for (const row of window) items.push(...await this.opportunityWithin(db, actor, row, context));
    items.sort((a, b) => b.match.score - a.match.score || a.id.localeCompare(b.id));
    // Only data already readable in this matching window enters the digest.
    // Private profile edits do not become observable source-change errors.
    const sourceHash = digest(JSON.stringify(items));
    let offset = 0;
    if (cursor.lastKey) {
      if (cursor.sourceHash !== sourceHash) throw new ServiceError('discovery_sources_changed_retry', 409);
      const last = items.findIndex(item => item.id === cursor.lastKey);
      if (last < 0) throw new ServiceError('discovery_cursor_unavailable_restart', 409);
      offset = last + 1;
    }
    result.items = items.slice(offset, offset + options.limit);
    result.coverage.windowLimited = rows.length > this.scanWindowLimit;
    if (offset + options.limit < items.length) result.nextAfter = this.sealCursor({ v: 2, queryHash, viewerId,
      startAfter: cursor.startAfter, lastKey: result.items.at(-1).id, sourceHash });
    else if (rows.length > this.scanWindowLimit) result.nextAfter = this.sealCursor({ v: 2, queryHash, viewerId,
      startAfter: window.at(-1).subject_id, lastKey: null });
    return result;
  }
  async detail(actor, input) {
    const options = parse(discoveryDetailV2Schema, input);
    return this.run(actor, async db => {
      const context = await this.contextWithin(db, actor, options), ref = options.opportunityRef;
      if (!context.wish.enabled || ref.subjectId === actor?.subjectId) throw new ServiceError('discovery_opportunity_unavailable', 404);
      const opportunities = await this.opportunityWithin(db, actor, { subject_id: ref.subjectId }, context);
      const opportunity = opportunities.find(item => sameOpportunityRef(item.opportunityRef,ref));
      if (!opportunity) throw new ServiceError('discovery_opportunity_unavailable', 404);
      if (!this.history?.queryWithin) throw new ServiceError('discovery_history_unavailable', 503);
      // One selected subject, preserving the existing History reader's current
      // authorization, origin and outcome distinctions. No success-only filter.
      const experience = await this.history.queryWithin(db, actor, historyV2QuerySchema.parse({
        subjectId: ref.subjectId, query: '', after: options.experienceAfter, limit: options.experienceLimit,
      }));
      return { schemaVersion: 2, opportunity: { ...opportunity, experience: { status: experience.items.length ? 'loaded' : 'no-visible-page',
        refs: experience.items.map(item => ({ key: item.key, kind: item.kind, caseId: item.caseId ?? null, taskId: item.taskId ?? null })),
        absenceMeaning: 'only-currently-visible-history; no-capability-or-eligibility-judgment' } }, experience,
        experienceRelation: 'subject-history; user-must-assess-relevance-to-current-project',
        capabilityVerified: false, activeEntries: entries, persistedContext: false,
        interpretation: 'user-side-model-or-user', computedAt: this.access.now() };
    });
  }
}
