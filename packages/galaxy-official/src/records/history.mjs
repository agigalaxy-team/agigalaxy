import { historyQuerySchema as querySchema } from "../shared/history-schema.mjs";
import { transaction } from "../infrastructure/database.mjs";
import { ServiceError } from "../shared/service-error.mjs";
import { digest } from "../shared/digest.mjs";
import { canReadProjection } from "../domain/consent-policy.mjs";
import { projectCaseReviews } from "../domain/case-review.mjs";
import { createHistoryRebuild } from "../domain/history-rebuild.mjs";
import { historyCollaborationContext } from "../domain/history-collaboration.mjs";
import { applyHistoryFieldPolicy } from "../domain/history-fields.mjs";
import { historyReportedProgress } from "../domain/history-progress.mjs";
import { explainHistoryMatch } from "../domain/history-search.mjs";
import { summarizeCiProofViews } from "../shared/ci-provenance.mjs";

export function projectCase(parent, events, owner, proofs = []) {
  const root = events.find(event => event.kind === 'case');
  const corrections = events.filter(event => event.kind === 'revision' && !event.review).map(event => ({ id: event.id,
    correctsEventId: event.correctsEventId, reason: event.reason, summary: event.summary }));
  const attempts = events.filter(event => event.kind === 'attempt').map(event => ({ id: event.id, sequence: event.sequence,
    ...(owner ? { approach: event.approach, configuration: event.configuration } : {}) }));
  const results = events.filter(event => event.kind === 'result').map(event => ({ id: event.id, attemptId: event.attemptId,
    outcome: event.outcome, summary: event.summary, failureReason: event.failureReason, limitations: event.limitations,
    corrected: corrections.some(correction => correction.correctsEventId === event.id) }));
  const item = { caseId: parent.id, sourceVersion: parent.version, title: root.title, summary: root.summary,
    state: parent.state, attempts, results, corrections, reviews: projectCaseReviews(events), proofs, capabilityVerified: false,
    verification: 'reported-results; proofs retain their own limited scope',
    ...(owner ? { participants: root.participants, source: root.source,
      registeredAt: new Date(parent.created_at).toISOString() } : {}) };
  return { ...item, projectionHash: digest(JSON.stringify(item)) };
}

export class HistoryService {
  constructor(access, consents, proofs, capsules,assistance=null,profiles=null,moderation=null) { this.access = access; this.consents = consents; this.proofs = proofs; this.capsules = capsules; this.assistance=assistance; this.profiles=profiles;this.moderation=moderation; }
  async queryV2(actor, input) {
    if (!this.v2) throw new ServiceError('history_v2_unavailable', 503);
    return this.v2.query(actor, input);
  }
  async query(actor, input = {},{candidateIds=null}={}) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_history_query');
    const options = parsed.data;
    // Source/configuration and registration metadata belong to the owner view.
    if ([options.sourceKind, options.environment, options.createdFrom, options.createdBefore].some(value => value !== undefined)
      && (!actor || options.subjectId !== actor.subjectId)) throw new ServiceError('history_owner_filters_required', 403);
    const terms = [...new Set(options.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean))];
    if (terms.length > 8) throw new ServiceError('invalid_history_query');
    const read = async db => {
      const now = new Date(this.access.now() * 1000).toISOString();
      const derivedFilter=Boolean(options.capabilityId||options.verificationStrength);
      const candidateLimit=derivedFilter?200:options.limit+1;
      // Filter every event grant before matching or pagination. Private histories
      // never influence result counts or continuation cursors.
      const parents = (await db.query(`SELECT p.* FROM cases p JOIN case_events root ON root.case_id=p.id AND root.kind='case'
        WHERE ($1::text IS NULL OR p.subject_id=$1) AND ($2::uuid IS NULL OR p.id>$2)
        AND ($13::uuid[] IS NULL OR p.id=ANY($13))
        AND (p.subject_id=$3 OR p.state<>'withdrawn')
        AND ($9::text IS NULL OR root.payload->'source'->>'kind'=$9)
        AND ($10::text IS NULL OR EXISTS (SELECT 1 FROM case_events attempt
          WHERE attempt.case_id=p.id AND attempt.kind='attempt'
          AND lower(attempt.payload->'configuration'->>'environment')=lower($10)))
        AND ($11::timestamptz IS NULL OR p.created_at >= $11)
        AND ($12::timestamptz IS NULL OR p.created_at < $12)
        AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM case_events result
          WHERE result.case_id=p.id AND result.kind='result' AND result.payload->>'outcome'=$8))
        AND NOT EXISTS (SELECT 1 FROM unnest($6::text[]) term WHERE
          strpos(lower((root.payload->>'title') || ' ' || (root.payload->>'summary')),term)=0)
        AND NOT EXISTS (SELECT 1 FROM case_events e LEFT JOIN consents c ON c.id=e.consent_id
          LEFT JOIN bindings b ON b.id=c.binding_id WHERE e.case_id=p.id AND
          (c.id IS NULL OR b.id IS NULL OR c.subject_id<>p.subject_id OR b.subject_id<>p.subject_id
          OR c.revoked_at IS NOT NULL OR b.revoked_at IS NOT NULL OR c.expires_at<=$4 OR b.expires_at<=$4
          OR c.intent->>'recipient'<>$5 OR c.intent->>'action'<>'case.teaser.publish'
          OR c.intent->>'objectId'<>e.id::text OR c.intent->>'payloadHash'<>e.payload_hash
          OR NOT (p.subject_id=COALESCE($3,'') OR
            (c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile') OR
            (c.intent->>'visibility'='Private' AND c.intent->'viewers' ? COALESCE($3,'')))))
        ORDER BY p.id LIMIT $7 FOR SHARE OF p`, [options.subjectId ?? null, options.after ?? null, actor?.subjectId ?? null,
        now, this.access.endpoint, terms, derivedFilter?candidateLimit+1:candidateLimit, options.outcome ?? null,
        options.sourceKind ?? null, options.environment ?? null, options.createdFrom ?? null, options.createdBefore ?? null,candidateIds])).rows;
      const items = [];
      let scannedAfter=null;
      for (const parent of parents.slice(0,candidateLimit)) {
        scannedAfter=parent.id;
        const rows = (await db.query('SELECT * FROM case_events WHERE case_id=$1 ORDER BY version LIMIT 1001', [parent.id])).rows;
        if (rows.length > 1000) throw new ServiceError('case_event_limit', 413);
        let allowed = true;
        for (const event of rows) {
          try {
            const grant = await this.consents.require(db, { id: event.consent_id, subjectId: parent.subject_id,
              action: 'case.teaser.publish', objectId: event.id, recipient: this.access.endpoint, payloadJson: event.payload_text });
            if (!canReadProjection(grant, { viewerId: actor?.subjectId ?? null, projection: 'history', now: this.access.now() })) allowed = false;
          } catch (error) { if (error instanceof ServiceError) allowed = false; else throw error; }
        }
        if (!allowed) continue;
        const linked = (await db.query(`SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id
          JOIN consents c ON c.id=p.consent_id JOIN bindings b ON b.id=c.binding_id
          WHERE e.case_id=$1 AND p.revoked_at IS NULL AND c.revoked_at IS NULL AND b.revoked_at IS NULL
          AND c.expires_at>$3 AND b.expires_at>$3 AND c.subject_id=p.subject_id AND b.subject_id=p.subject_id
          AND c.intent->>'recipient'=$4 AND c.intent->>'action'='proof.publish'
          AND c.intent->>'objectId'=p.id::text AND c.intent->>'payloadHash'=p.payload_hash
          AND (p.subject_id=$2 OR c.intent->>'visibility'='Public' AND c.intent->>'purpose'='public-profile'
            OR c.intent->>'visibility' IN ('Private','Proof-only') AND c.intent->'viewers' ? COALESCE($2,''))
          ORDER BY p.id LIMIT 20`, [parent.id,actor?.subjectId??null,now,this.access.endpoint])).rows;
        const proofs = [];
        for (const row of linked) {
          try { proofs.push(await this.proofs.readWithin(db, actor, row.id)); }
          catch (error) { if (!(error instanceof ServiceError)) throw error; }
        }
        const item = projectCase(parent, rows.map(row => row.payload), actor?.subjectId === parent.subject_id, proofs);
        if (this.capsules) {
          const reuse = await this.capsules.usesWithin(db, actor, {caseId:parent.id,limit:20});
          if (reuse.items.length) { item.capsuleReuse = reuse;
            const {projectionHash:_oldHash,...projection}=item; item.projectionHash=digest(JSON.stringify(projection)); }
        }
        const matchReasons = terms.map(term => `title/summary contains: ${term}`);
        if(this.assistance)item.collaborationContext=await historyCollaborationContext(db,actor,parent,this.assistance);
        item.reportedProgress=historyReportedProgress(rows);
        if(this.moderation)item.moderationContext=await this.moderation.caseContextWithin(db,actor,parent.id);
        const view=actor?(actor.subjectId===parent.subject_id?'owner':'authorized'):'public';
        const visible=applyHistoryFieldPolicy(item,view);
        const searchExplanation=explainHistoryMatch(visible,options,terms,this.access.now());
        if(!searchExplanation)continue;
        visible.rebuild=createHistoryRebuild(visible,rows,{endpoint:this.access.endpoint,view});
        if (options.outcome) matchReasons.push(`reported outcome: ${options.outcome}`);
        if (options.sourceKind) matchReasons.push(`source kind: ${options.sourceKind}`);
        if (options.environment) matchReasons.push(`attempt environment: ${options.environment}`);
        if (options.createdFrom) matchReasons.push(`registered at or after: ${options.createdFrom}`);
        if (options.createdBefore) matchReasons.push(`registered before: ${options.createdBefore}`);
        if(options.capabilityId)matchReasons.push(`visible requested capability: ${options.capabilityId}`);
        if(options.verificationStrength)matchReasons.push(`visible verification strength: ${options.verificationStrength}`);
        items.push({ ...visible, searchExplanation, matchReasons: matchReasons.length ? matchReasons : ['case ID order'] });
        if(items.length>options.limit)break;
      }
      const page = items.slice(0, options.limit);
      const windowLimited=items.length<=options.limit&&parents.length>candidateLimit;
      const nextCursor=items.length>options.limit?page.at(-1).caseId:windowLimited?scannedAfter:null;
      const declaration=options.subjectId&&this.profiles?await this.profiles.readWithin(db,actor,options.subjectId):{selfDeclared:{}};
      return { projectionVersion: 1, subjectId: options.subjectId ?? null, ...declaration, derived: true,
        view: actor ? (options.subjectId === actor.subjectId ? 'owner' : 'authorized') : 'public',
        items: page, nextCursor,
        search:{rule:'visible-history-rules@1',order:'case-id',windowLimited,scanLimit:candidateLimit,
          coverage:windowLimited?'bounded-visible-window; continue-with-cursor':'current-page',globalCountProvided:false},
        pageSummary: { cases: page.length, results: page.reduce((sum, item) => sum + item.results.length, 0),ciSources:summarizeCiProofViews(page.flatMap(item=>item.proofs)) },
        checkedAt: this.access.now(), refresh:{mode:'on-demand',state:'rebuilt',backgroundQueue:false,checkedAt:this.access.now()},capabilityVerified: false };
    };
    return actor ? this.access.runAuthorized(actor, 'history', read) : transaction(this.access.db, read);
  }
}
