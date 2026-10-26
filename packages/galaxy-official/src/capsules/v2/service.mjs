import {capsuleReadSchema,capsuleQuerySchema} from "../../shared/capsule-v2-schema.mjs";
import {capsuleRule as rule} from "./sources.mjs";
import {transaction} from "../../database.mjs";
import {absent,ownControl} from './helpers.mjs';
import {CapsuleUses} from './uses.mjs';

// Formal v2 service, current authorized content projection, maintenance notices and bounded public discovery.
export class CapsuleServiceV2 extends CapsuleUses{
  async readWithin(db, actor, input) {
    const current = await this.versionWithin(db, actor, input.capsuleId, input.versionId);
    const ownState = actor?.subjectId === current.row.subject_id ? (await db.query('SELECT revision FROM capsules WHERE id=$1',[input.capsuleId])).rows[0] : null;
    if (current.sourceStatus === 'source-unavailable') return { capsuleId: input.capsuleId, versionId: current.row.id,
      ...ownControl(actor,current.row,'publication'),
      version: null, sourceStatus: current.sourceStatus, reason: current.source.reason,
      ...(ownState?{authorId:current.row.subject_id,revision:ownState.revision}:{}),
      ...await this.maintenanceWithin(db, actor, input.capsuleId, current.row.id), newApplicationAllowed: false, capabilityVerified: false };
    return { capsuleId: input.capsuleId, versionId: current.row.id, authorId: current.row.subject_id, version: current.payload,
      ...ownControl(actor,current.row,'publication'),
      ...(ownState ? { revision: ownState.revision } : {}),
      sourceStatus: current.sourceStatus, permissions: current.source.permissions, attributions: await this.attributionsWithin(db, actor, current.source.attributions),
      ...(current.payload.schemaVersion === 2 ? { sourceReading: await this.resolutionReadingWithin(db, actor, current.payload.sourceResolution) } : {}),
      deprecated: current.deprecated, securityIssue: current.securityIssue, notices: current.notices,
      newApplicationAllowed: !current.deprecated && !current.securityIssue && current.source.sourceCurrent,
      synthetic: current.source.synthetic, compatibility: current.compatibility,
      readingIsReuse: false, coauthorApproval: false, capabilityVerified: false };
  }
  async visibleUpdateWithin(db,actor,event){
    // A prior authorized reference/application establishes interest. Read alone
    // never does. Recheck exact use Consent instead of trusting candidate SQL.
    const uses=(await db.query(`SELECT id,subject_id,consent_id,payload_text FROM capsule_uses
      WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3
      UNION ALL SELECT id,subject_id,consent_id,payload_text FROM capsule_uses_v2
      WHERE capsule_id=$1 AND subject_id=$2 AND observed_revision<$3`,[event.capsule_id,actor.subjectId,event.revision])).rows;
    let authorized=false;
    for(const use of uses)try{if(this.legacy.visible(await this.legacy.grant(db,use,'capsule.use'),actor)){authorized=true;break;}}
      catch(error){if(!absent(error))throw error;}
    if(!authorized)return null;
    const current=await this.versionWithin(db,actor,event.capsule_id,event.version_id),payload=JSON.parse(event.payload_text);
    const unavailable=current.sourceStatus==='source-unavailable';
    return {title:unavailable?'Capsule 来源或版本状态已变化':current.payload.title,
      capsuleId:event.capsule_id,versionId:event.version_id,actorId:event.subject_id,eventKind:payload.kind,
      sourceStatus:current.sourceStatus,deprecated:current.deprecated,securityIssue:current.securityIssue,
      summary:unavailable?null:payload.summary??'New Capsule version',
      object:{type:'capsule',id:event.capsule_id,versionId:event.version_id},sourceBodyIncluded:false};
  }
  get(actor, input) { rule(capsuleReadSchema.safeParse(input).success, 'invalid_capsule_query', 400);
    return actor ? this.access.runAuthorized(actor, 'capsules', db => this.readWithin(db, actor, input)) : transaction(this.access.db, db => this.readWithin(db, null, input)); }
  async query(actor, input = {}) {
    const parsed = capsuleQuerySchema.safeParse(input); rule(parsed.success, 'invalid_capsule_query', 400); const options = parsed.data;
    const read = async db => {
      let cursor = null; const items = [];
      for (;;) {
        const rows = (await db.query('SELECT id FROM capsules WHERE ($1::text IS NULL OR subject_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100', [options.authorId ?? null, cursor])).rows;
        for (const row of rows) try {
          const item = await this.readWithin(db, actor, { capsuleId: row.id });
          if (!item.version || options.capabilityId && item.version.capabilityId !== options.capabilityId
            || !`${item.version.title} ${item.version.problemPattern}`.toLowerCase().includes(options.query.toLowerCase())) continue;
          items.push({ capsuleId: row.id, versionId: item.versionId, sourceVersion: item.version.version,
            authorId: item.authorId, publicationClass: item.version.publicationClass, synthetic: item.version.synthetic,
            title: item.version.title, problemPattern: item.version.problemPattern, capabilityId: item.version.capabilityId,
            sourceStatus: item.sourceStatus, deprecated: item.deprecated, securityIssue: item.securityIssue,
            newApplicationAllowed: item.newApplicationAllowed, capabilityVerified: false });
        } catch (error) { if (!absent(error)) throw error; }
        if (rows.length < 100) break; cursor = rows.at(-1).id;
      }
      const remaining = items.filter(item => !options.after || item.capsuleId > options.after), page = remaining.slice(0, options.limit);
      return { items: page, nextAfter: remaining.length > options.limit ? page.at(-1).capsuleId : null, coverage: 'visible-page-only', windowLimited: false };
    };
    return actor ? this.access.runAuthorized(actor, 'capsules', read) : transaction(this.access.db, read);
  }
}
