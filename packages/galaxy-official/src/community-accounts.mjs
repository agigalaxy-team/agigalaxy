import { z } from 'zod';
import { ServiceError } from './shared/service-error.mjs';
import {lockControllerMappingsWithin} from './controller-mapping-lock.mjs';
import {transaction} from './database.mjs';
import {ensureOfficialAccountProfileWithin,upsertOfficialAccountWithin} from './official-account-uid.mjs';

const iso = seconds => new Date(seconds * 1000).toISOString();
export const communityAccountView = (row, currentAccountId = null) => ({
  id:row.id,accountId:row.id,uid:row.uid,displayName:row.display_name??null,subjectType:row.subject_type??null,
  endpoint:row.endpoint,current:row.id===currentAccountId
});
const linkInput = z.strictObject({ subjectId: z.string().min(1).max(128), linkId: z.uuid(),
  endpoint: z.url(), issuer: z.url(), externalSubject: z.string().min(1).max(255),
  verifiedAt: z.number().int().nonnegative(), verificationMethod: z.enum(['email','external-account']) });

// Called only by the server's verified OIDC callback + signed Galaxy association.
// No HTTP endpoint accepts these verification facts from a caller.
export class CommunityAccountRegistry {
  constructor(access, providers = []) {
    this.access = access;
    this.providers = new Set(providers.map(provider => {
      const d = provider.describe(); return JSON.stringify([d.issuer, d.clientId]);
    }));
  }
  async linkVerifiedWithin(db, input) {
    const parsed = linkInput.safeParse(input);
    if (!parsed.success) throw new ServiceError('invalid_account_verification');
    const data = parsed.data;
    if (data.endpoint !== this.access.endpoint || data.verifiedAt > this.access.now()) throw new ServiceError('invalid_account_verification');
    // Mapping writes take the subject key before account upsert/row locks.
    // Multiple subjects sharing one account therefore never acquire each
    // other's controller key while holding that account row.
    await lockControllerMappingsWithin(db,this.access.endpoint,[data.subjectId],{exclusive:true});
    const link = (await db.query(`SELECT * FROM external_identity_links WHERE id=$1 AND subject_id=$2 AND endpoint=$3
      AND issuer=$4 AND external_subject=$5 AND revoked_at IS NULL`,
    [data.linkId, data.subjectId, data.endpoint, data.issuer, data.externalSubject])).rows[0];
    if (!link || !this.providers.has(JSON.stringify([link.issuer, link.client_id]))) throw new ServiceError('identity_provider_unavailable', 409);
    const account=await upsertOfficialAccountWithin(db,{endpoint:data.endpoint,issuer:data.issuer,externalSubject:data.externalSubject,
      verificationMethod:data.verificationMethod,verifiedAt:data.verifiedAt});
    await ensureOfficialAccountProfileWithin(db,account.id,{now:this.access.now()});
    await db.query(`INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(identity_link_id) DO NOTHING`,
    [data.linkId, account.id, data.subjectId, iso(this.access.now())]);
    return { accountId:account.id,accountVerified:true,galaxyAuthorization:false };
  }
  async availableWithin(db, actor) {
    if(actor.kind==='official-account'){
      if(actor.endpoint!==this.access.endpoint||!z.uuid().safeParse(actor.accountId).success)throw new ServiceError('access_denied',401);
      return (await db.query(`SELECT a.*,p.display_name,p.subject_type FROM community_accounts a
        LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`,[actor.accountId,this.access.endpoint])).rows;
    }
    // An active association identifies a possible target. It does not choose
    // between multiple accounts or confer any unrelated account capability.
    await lockControllerMappingsWithin(db,this.access.endpoint,[actor.subjectId]);
    const rows = (await db.query(`SELECT a.*,p.display_name,p.subject_type,l.client_id FROM community_accounts a
      JOIN community_account_links g ON g.account_id=a.id JOIN external_identity_links l ON l.id=g.identity_link_id
      LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id
      WHERE g.subject_id=$1 AND l.revoked_at IS NULL AND a.endpoint=$2 ORDER BY a.created_at,a.id`,
    [actor.subjectId, this.access.endpoint])).rows;
    return [...new Map(rows.filter(row=>this.providers.has(JSON.stringify([row.issuer,row.client_id]))).map(row=>[row.id,row])).values()];
  }
  async resolveWithin(db, actor, { lock = false, accountId = actor.accountId, requireExplicit = false } = {}) {
    const rows=await this.availableWithin(db,actor);
    if(actor.kind==='official-account'&&accountId&&accountId!==actor.accountId)throw new ServiceError('official_account_changed',409);
    if(requireExplicit&&rows.length>1&&!accountId)throw new ServiceError('account_selection_required',409);
    if(!accountId&&rows.length>1)throw new ServiceError('account_selection_required',409);
    const found=accountId?rows.find(row=>row.id===accountId):rows[0];
    if(accountId&&!found)throw new ServiceError('account_target_unavailable',403);
    if (!found) throw new ServiceError('account_verification_required', 403);
    if(!lock)return found;
    const current=(await db.query('SELECT * FROM community_accounts WHERE id=$1 FOR UPDATE',[found.id])).rows[0];
    if(!current)throw new ServiceError('account_target_unavailable',403);
    return {...found,...current};
  }
  async publicChoicesWithin(db,{query='',after=null,limit=20}={}){
    const rows=(await db.query(`SELECT a.id,a.uid,a.endpoint,p.display_name,p.subject_type FROM community_accounts a
      JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true
      WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.id>$2) AND
      ($3::text='' OR position(lower($3::text) in lower(coalesce(p.display_name,'')))>0 OR a.id::text=$3::text OR a.uid=upper($3::text))
      ORDER BY a.id LIMIT $4`,[this.access.endpoint,after,query,limit+1])).rows;
    return {items:rows.slice(0,limit).map(row=>communityAccountView(row)),nextAfter:rows.length>limit?rows[limit-1].id:null};
  }
  runAuthorized(actor,scope,operation,options={}){
    if(actor.kind!=='official-account'){
      const authorized=async(db,authorization)=>{
        const account=actor.accountId?await this.resolveWithin(db,actor):null;
        return operation(db,authorization,account?{...actor,accountId:account.id,accountAuthorized:true}:actor);
      };
      return options.resourceWrite?this.access.runResourceWrite(actor,scope,options,authorized):this.access.runAuthorized(actor,scope,authorized,options);
    }
    return transaction(this.access.db,async db=>{
      const account=await this.resolveWithin(db,actor);
      // A restriction blocks new community publication. Retraction remains a
      // control action, just as it is for the existing signed-ID path.
      if(options.resourceWrite&&!options.control&&account.restricted_until&&Date.parse(account.restricted_until)>this.access.now()*1000)throw new ServiceError('community_restricted',403);
      return operation(db,Object.freeze({kind:'official-account',accountId:account.id}),actor);
    });
  }
  async recordInteractionWithin(db, { subjectId, counterpartyId, sourceId, sourceKind }) {
    // Internal accepted interaction hook, never a self-reported account-upgrade API.
    if (subjectId === counterpartyId || !z.uuid().safeParse(sourceId).success
      || !['accepted-participation','accepted-delivery','moderator-confirmed-interaction'].includes(sourceKind)) return;
    let account;
    try { account = await this.resolveWithin(db, { subjectId }); }
    catch (error) { if (['account_verification_required','account_selection_required'].includes(error.code)) return; throw error; }
    const own = (await db.query('SELECT 1 FROM community_account_links WHERE account_id=$1 AND subject_id=$2 LIMIT 1',
      [account.id, counterpartyId])).rows.length;
    if (own) return;
    await db.query(`INSERT INTO community_interactions(account_id,source_id,source_kind,counterparty_id,created_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source_id) DO NOTHING`,
    [account.id, sourceId, sourceKind, counterpartyId, iso(this.access.now())]);
  }
}
