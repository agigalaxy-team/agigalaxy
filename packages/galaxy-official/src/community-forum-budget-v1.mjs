import {ServiceError} from './shared/service-error.mjs';
import {forumStamp} from './community-forum-permissions-v1.mjs';
import {communityAccountView} from './community-accounts.mjs';
import {p14QuotaCounts} from './operations/rules/quota.mjs';

export const forumBudgetTables=['forum_posts_v1','forum_versions_v1','forum_replies_v1','forum_events_v1','forum_permissions_v1','forum_reports_v1','forum_governance_events_v1','forum_write_receipts_v1'];
// Once-stored signed Consent evidence is charged once per actual Account group.
// Fixed reservations cover IDs, indexes and accepted-operation audit metadata.
export const forumAccountBytesSql=[
 ...forumBudgetTables.map(table=>`SELECT coalesce(sum(1024${['forum_events_v1','forum_governance_events_v1'].includes(table)?'+octet_length(payload_text)+octet_length(result::text)':table==='forum_write_receipts_v1'?'+octet_length(locator::text)+octet_length(result::text)':table==='forum_permissions_v1'?'+coalesce(octet_length(signer_public_key),0)+octet_length(fields::text)+octet_length(viewers::text)+octet_length(account_viewers::text)':table==='forum_reports_v1'?'+octet_length(target::text)':''}),0)::bigint bytes FROM ${table} WHERE account_id=$1`),
 'SELECT count(*)*512::bigint bytes FROM forum_daily_usage_v1 WHERE account_id=$1',
 'SELECT coalesce(sum(1024+octet_length(title)+octet_length(theme)+octet_length(description)+octet_length(audience::text)),0)::bigint bytes FROM forum_sections_v2 WHERE maintainer_account_id=$1',
 'SELECT coalesce(sum(1024+octet_length(payload_text)+octet_length(result::text)),0)::bigint bytes FROM forum_section_events_v2 WHERE account_id=$1',
 'SELECT count(*)*512::bigint bytes FROM forum_notification_reads_v2 WHERE account_id=$1',
 `SELECT coalesce(sum(coalesce(octet_length(c.signature_envelope),0)+coalesce(octet_length(c.signed_payload_text),0)+octet_length(c.intent::text)+512),0)::bigint bytes
  FROM consents c WHERE c.id IN (SELECT consent_id FROM forum_permissions_v1 WHERE account_id=$1 UNION SELECT consent_id FROM forum_write_receipts_v1 WHERE account_id=$1)`,
 `SELECT coalesce(sum(octet_length(to_jsonb(a)::text)+512),0)::bigint bytes FROM audit_events a
  WHERE a.consent_id IN (SELECT consent_id FROM forum_permissions_v1 WHERE account_id=$1 UNION SELECT consent_id FROM forum_write_receipts_v1 WHERE account_id=$1)`,
].join(' UNION ALL ');
export const forumSubjectBytesSql=forumAccountBytesSql.split(' UNION ALL ').filter(sql=>!['FROM forum_daily_usage_v1','FROM forum_sections_v2','FROM forum_notification_reads_v2'].some(table=>sql.includes(table))).map(sql=>sql.replaceAll('account_id=$1','subject_id=$1')).join(' UNION ALL ');
export async function forumAccountUsage(db,accountId){return BigInt((await db.query(`SELECT coalesce(sum(bytes),0)::text bytes FROM (${forumAccountBytesSql}) owned_forum_bytes`,[accountId])).rows[0].bytes);}
export class CommunityForumBudgetV1 {
 constructor(access,accounts,publicWrites,{policy,policyHash}){Object.assign(this,{access,accounts,publicWrites,policy,policyHash});}
 async quotaWithin(db,account,category){
  const now=this.access.now(),tier=await this.publicWrites.tierWithin(db,account,now),day=forumStamp(now).slice(0,10);
  const used=Number((await db.query('SELECT used FROM forum_daily_usage_v1 WHERE account_id=$1 AND day=$2 AND category=$3',[account.id,day,category])).rows[0]?.used??0),limit=this.policy[tier][category];
  return {category,...p14QuotaCounts(limit,used),tier,resetAt:forumStamp((Math.floor(now/86400)+1)*86400),policyVersion:this.policy.version};
 }
 async startWithin(db,actor,category){
  const account=await this.accounts.resolveWithin(db,actor,{lock:true}),now=this.access.now();
  if(account.restricted_until&&Date.parse(account.restricted_until)>now*1000)throw new ServiceError('community_restricted',403);
  const quota=await this.quotaWithin(db,account,category);
  if(!quota.remaining)throw Object.assign(new ServiceError('forum_quota_exceeded',429),{quota,retryAfterSeconds:Math.max(1,Math.ceil(Date.parse(quota.resetAt)/1000-now))});
  return {account,quota,before:await forumAccountUsage(db,account.id)};
 }
 async finishWithin(db,state){
  const after=await forumAccountUsage(db,state.account.id);
  if(after>BigInt(this.policy.accountForumMaxBytes)&&after>state.before)throw new ServiceError('forum_storage_quota_exceeded',409);
  const day=forumStamp(this.access.now()).slice(0,10);
  await db.query(`INSERT INTO forum_daily_usage_v1(account_id,day,category,used) VALUES($1,$2,$3,1)
   ON CONFLICT(account_id,day,category) DO UPDATE SET used=forum_daily_usage_v1.used+1`,[state.account.id,day,state.quota.category]);
  // The new daily counter itself must fit; a failing transaction refunds it.
  const complete=await forumAccountUsage(db,state.account.id);
  if(complete>BigInt(this.policy.accountForumMaxBytes)&&complete>state.before)throw new ServiceError('forum_storage_quota_exceeded',409);
  return {...state.quota,used:state.quota.used+1,remaining:state.quota.remaining-1};
 }
 async checkGrowthWithin(db,accountId,before){const after=await forumAccountUsage(db,accountId);if(after>BigInt(this.policy.accountForumMaxBytes)&&after>before)throw new ServiceError('forum_storage_quota_exceeded',409);}
 status(actor,context={}){return this.accounts.runAuthorized(actor,actor.kind==='official-account'||actor.scopes?.includes('assistance')?'assistance':'moderation',async(db,_authorization,currentActor)=>{
  actor=this.contextActorWithin?await this.contextActorWithin(db,currentActor,context):currentActor;
  const now=this.access.now();
  const available=await this.accounts.availableWithin(db,actor),base={policy:this.policy,policyHash:this.policyHash,restriction:null,
   publication:{checkedAt:now,minPublishedUntil:now+1,maxPublishedUntil:now+this.policy.maxPermissionSeconds,maxPermissionSeconds:this.policy.maxPermissionSeconds},
   availableAccounts:available.map(row=>({...communityAccountView(row,actor.accountId),verificationMethod:row.verification_method}))};let account;
  try{account=await this.accounts.resolveWithin(db,actor);}catch(error){
   if(error.code==='account_verification_required')return {...base,accountId:null,currentAccount:null,accountVerified:false,quotas:[],reason:error.code};
   if(error.code==='account_selection_required')return {...base,accountId:null,currentAccount:null,accountVerified:true,accountSelectionRequired:true,quotas:[],reason:error.code};throw error;
  }
  const quotas=[];for(const category of ['post','version','reply','report'])quotas.push(await this.quotaWithin(db,account,category));
  return {...base,availableAccounts:base.availableAccounts.map(row=>({...row,current:row.id===account.id})),accountId:account.id,currentAccount:communityAccountView(account,account.id),accountVerified:true,accountSelectionRequired:false,quotas,storage:{usedBytes:Number(await forumAccountUsage(db,account.id)),maxBytes:this.policy.accountForumMaxBytes},
   restriction:account.restricted_until&&Date.parse(account.restricted_until)>this.access.now()*1000?{until:new Date(account.restricted_until).toISOString(),reason:account.restriction_reason}:null};
 });}
}
