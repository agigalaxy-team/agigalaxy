import {capsuleVersionV2Schema} from "../../shared/capsule-v2-schema.mjs";
import {CapsuleSourcesV2,capsuleRule as rule,parseCapsuleV2 as parse} from "./sources.mjs";
import {transaction} from "../../database.mjs";
import {operationsVisibilityWithin} from "../../operations-content-visibility.mjs";
import {capsuleReceiptV2Schema,capsuleVersionsV2Schema,capsulePermissionsQueryV2Schema} from "../../shared/capsule-v2-schema.mjs";
import {absent,ownControl} from './helpers.mjs';

// Exact published versions, current source/visibility qualifications, explicit permissions and original owner receipts. No latest-visible fallback is introduced.
export class CapsuleVersionReads extends CapsuleSourcesV2{
  async receipt(actor, input) {
    const options = capsuleReceiptV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_receipt',400);
    return this.access.runAuthorized(actor,'capsules',async db=>{
      const {type,operationId,payloadHash}=options.data;
      // Receipt ownership is independent of now-withdrawn source/body access.
      // A recorded hash confirms accepted bytes, never current permission.
      let row;
      if(type==='publication') row=(await db.query('SELECT id,capsule_id,version_id,revision,consent_id,payload_hash FROM capsule_events WHERE id=$1 AND subject_id=$2',[operationId,actor.subjectId])).rows[0];
      else if(type==='use') row=(await db.query('SELECT id,capsule_id,version_id,kind,consent_id,payload_hash FROM capsule_uses_v2 WHERE id=$1 AND subject_id=$2',[operationId,actor.subjectId])).rows[0];
      else row=(await db.query(`SELECT id AS permission_id,CASE WHEN id=$1 THEN consent_id ELSE revoke_consent_id END AS consent_id,
        CASE WHEN id=$1 THEN payload_hash ELSE revoke_payload_hash END AS payload_hash FROM capsule_permissions WHERE subject_id=$2 AND (id=$1 OR revoke_id=$1)`,[operationId,actor.subjectId])).rows[0];
      if(!row)return {state:'absent',operationId,currentReadPermissionConfirmed:false};
      if(row.payload_hash!==payloadHash)return {state:'conflict',operationId,currentReadPermissionConfirmed:false};
      return {state:'acknowledged',operationId,consentId:row.consent_id,...(row.capsule_id?{capsuleId:row.capsule_id,versionId:row.version_id}:{}),
        ...(row.permission_id?{permissionId:row.permission_id}:{}),...(row.revision?{revision:row.revision}:{}),currentReadPermissionConfirmed:false};
    });
  }
  async versions(actor,input){
    const options=capsuleVersionsV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_query',400);
    const read=async db=>{
      const p=options.data,rows=(await db.query("SELECT id,subject_id FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY id",[p.capsuleId])).rows,items=[];
      for(const row of rows)try{
        const current=await this.versionWithin(db,actor,p.capsuleId,row.id);
        items.push({versionId:row.id,version:current.payload.version,title:current.sourceStatus==='source-unavailable'?null:current.payload.title,
          ...ownControl(actor,current.row,'publication'),
          sourceStatus:current.sourceStatus,deprecated:current.deprecated,securityIssue:current.securityIssue,
          ...(actor?.subjectId===row.subject_id?{disclosure:{visibility:current.grant.visibility,viewers:current.grant.viewers}}:{})});
      }catch(error){if(!absent(error))throw error;}
      const remaining=items.filter(i=>!p.after||i.versionId>p.after),page=remaining.slice(0,p.limit);
      const parent=actor?(await db.query('SELECT revision FROM capsules WHERE id=$1 AND subject_id=$2',[p.capsuleId,actor.subjectId])).rows[0]:null;
      return {capsuleId:p.capsuleId,items:page,nextAfter:remaining.length>p.limit?page.at(-1).versionId:null,
        ...(parent?{management:{revision:parent.revision,publishedVersionCount:rows.length}}:{}),coverage:'currently-authorized-versions; no-latest-fallback'};
    };
    return actor?this.access.runAuthorized(actor,'capsules',read):transaction(this.access.db,read);
  }
  async permissions(actor,input={}){
    const options=capsulePermissionsQueryV2Schema.safeParse(input);
    rule(options.success,'invalid_capsule_query',400);
    return this.access.runAuthorized(actor,'capsules',async db=>{
      const p=options.data,rows=(await db.query(`SELECT p.id FROM capsule_permissions p JOIN consents c ON c.id=p.consent_id
        WHERE p.payload_text<>'' AND ($2='owned' AND p.subject_id=$1 OR $2='granted' AND p.subject_id<>$1
        AND (c.intent->'viewers' ? $1 OR c.intent->>'visibility'='Public')) ORDER BY p.id`,[actor.subjectId,p.view])).rows,items=[];
      for(const row of rows)try{
        const {row:source,payload}=await this.permissionWithin(db,actor,row.id,{allowRevoked:true});
        if(p.view==='granted'&&!payload.grantees.includes(actor.subjectId))continue;
        let sourceStatus='current';
        try{for(const ref of payload.sources)await this.sourceWithin(db,{subjectId:source.subject_id},ref);}
        catch(error){if(!absent(error))throw error;sourceStatus='source-unavailable';}
        items.push({permissionId:row.id,authorId:source.subject_id,payload,revoked:!!source.revoked_at,
          expired:!!payload.expiresAt&&Date.parse(payload.expiresAt)<=this.access.now()*1000,sourceStatus,
          coauthorApproval:false,externalRightsVerified:false});
      }catch(error){if(!absent(error))throw error;}
      const remaining=items.filter(i=>!p.after||i.permissionId>p.after),page=remaining.slice(0,p.limit);
      return {items:page,nextAfter:remaining.length>p.limit?page.at(-1).permissionId:null,coverage:'currently-authorized-explicit-permissions'};
    });
  }
  async getPermission(actor, { permissionId }) {
    return this.access.runAuthorized(actor, 'capsules', async db => {
      const { row, payload } = await this.permissionWithin(db, actor, permissionId, { allowRevoked: true });
      return { permissionId, authorId: row.subject_id, payload, revoked: !!row.revoked_at,
        coauthorApproval: false, externalRightsVerified: false };
    });
  }
  async maintenanceWithin(db, actor, capsuleId, versionId) {
    const rows = (await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND version_id=$2 AND kind<>'version' ORDER BY revision", [capsuleId, versionId])).rows;
    let deprecated = false, securityIssue = false; const notices = [];
    for (const row of rows) {
      // Operational withdrawal is not undone by revoking its explanatory text.
      if (row.kind === 'deprecate') deprecated = true;
      if (row.kind === 'security-issue') securityIssue = true;
      if (row.kind === 'resolve-security') securityIssue = false;
      if (!row.payload_text) continue;
      try { if (this.legacy.visible(await this.legacy.grant(db, row, 'capsule.publish'), actor)) notices.push(JSON.parse(row.payload_text)); }
      catch (error) { if (!absent(error)) throw error; }
    }
    return { deprecated, securityIssue, notices };
  }
  async versionWithin(db, actor, capsuleId, versionId, { tolerateUnavailableSource = true,ignoreOperationsVisibility=false } = {}) {
    const rows = (await db.query("SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC", [capsuleId, versionId ?? null])).rows;
    // A no-version read targets the latest published version, and does not
    // silently fall back to an old visible version when that latest one is private.
    const row = rows[0]; rule(row?.payload_text, 'capsule_unavailable', 404);
    const operationsVisibility=await operationsVisibilityWithin(db,{endpoint:this.access.endpoint,kind:'method',id:capsuleId,now:this.access.now()});
    rule(!operationsVisibility.hidden||ignoreOperationsVisibility||actor?.subjectId===row.subject_id,'capsule_unavailable',404);
    const grant = await this.legacy.grant(db, row, 'capsule.publish');
    rule(this.legacy.visible(grant, actor), 'capsule_unavailable', 404);
    const raw = JSON.parse(row.payload_text), payload = raw.schemaVersion === 2 ? parse(row.payload_text, capsuleVersionV2Schema) : raw;
    const maintenance = await this.maintenanceWithin(db, actor, capsuleId, row.id);
    if (payload.schemaVersion !== 2) {
      const legacy = await this.legacy.readWithin(db, actor, { capsuleId, versionId: row.id });
      return { row, grant, payload, ...maintenance, source: { legacy, sourceCurrent: !legacy.sourceNeedsReview,
        synthetic: null, permissions: [], attributions: [], capabilityVerified: false }, sourceStatus: 'legacy-v1-source-policy',
      compatibility: 'legacy-author-declared-attribution; no-retroactive-source-signatures' };
    }
    let source, sourceStatus = 'current';
    try {
      // Current source checks use the publisher's licensed access, not a public
      // reader's raw-room identity. Only selected published content is returned.
      source = await this.publicationSourcesWithin(db, { subjectId: row.subject_id }, payload, grant, { requireCurrentResult: false });
      if (!source.sourceCurrent) sourceStatus = source.sourceCurrentness === 'unavailable'
        ? 'source-currentness-unavailable' : 'source-result-superseded';
    } catch (error) { if (!absent(error) || !tolerateUnavailableSource) throw error; sourceStatus = 'source-unavailable'; source = { reason: error.code }; }
    return { row, grant, payload, ...maintenance, source, sourceStatus, compatibility: 'native-v2' };
  }
}
