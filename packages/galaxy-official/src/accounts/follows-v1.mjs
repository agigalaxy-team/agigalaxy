import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {ServiceError} from "../shared/service-error.mjs";
import {digest} from "../shared/digest.mjs";
import {accountFollowCommandSchema,accountFollowStatusRequestSchema,accountFollowReceiptRequestSchema,accountFollowQuerySchema,accountFollowReceiptSchema} from "../shared/account-follows-schema.mjs";

const parse=(schema,input)=>{const value=schema.safeParse(input);if(!value.success)throw new ServiceError('invalid_account_follow_request');return value.data;};
const stamp=value=>new Date(value).toISOString();
const relationship=(targetAccountId,row)=>({id:row?.id??null,targetAccountId,following:row?.following===true,revision:row?.revision??0,
 followedAt:row?stamp(row.followed_at):null,updatedAt:row?stamp(row.updated_at):null});

export class AccountFollowsV1{
 constructor({accounts,endpoint,now=()=>accounts.access.now()}){Object.assign(this,{accounts,endpoint,now});}
 run(actor,write,operation){
  if(actor?.kind!=='official-account'||actor.endpoint!==this.endpoint||!z.uuid().safeParse(actor.accountId).success)throw new ServiceError('official_account_login_required',401);
  return this.accounts.runAuthorized(actor,'binding',async(db,_authorization,current)=>{
   if(current.kind!=='official-account'||current.accountId!==actor.accountId||current.endpoint!==this.endpoint)throw new ServiceError('official_account_changed',409);
   const owner=await this.accounts.resolveWithin(db,current,{lock:write});
   return operation(db,owner.id);
  },{resourceWrite:write,control:true});
 }
 async statusWithin(db,ownerId,targetAccountId){
  const row=(await db.query('SELECT id,target_account_id,following,revision,followed_at,updated_at FROM account_follows_v1 WHERE account_id=$1 AND target_account_id=$2',[ownerId,targetAccountId])).rows[0];
  return relationship(targetAccountId,row);
 }
 async targetWithin(db,targetAccountId,{lock=false}={}){
  return (await db.query(`SELECT a.id,a.uid,p.display_name,p.subject_type FROM community_accounts a
   JOIN official_account_profiles_v1 p ON p.account_id=a.id
   WHERE a.id=$1 AND a.endpoint=$2 AND p.query_enabled=true${lock?' FOR SHARE OF p':''}`,[targetAccountId,this.endpoint])).rows[0]??null;
 }
 status(actor,input){const request=parse(accountFollowStatusRequestSchema,input);return this.run(actor,false,async(db,ownerId)=>({accountId:ownerId,
  relationship:await this.statusWithin(db,ownerId,request.targetAccountId),canFollow:ownerId!==request.targetAccountId&&!!await this.targetWithin(db,request.targetAccountId),checkedAt:this.now()}));}
 async receiptWithin(db,ownerId,request){
  const row=(await db.query('SELECT request_hash,result FROM account_follow_operations_v1 WHERE account_id=$1 AND operation_id=$2',[ownerId,request.operationId])).rows[0];
  if(!row)return {state:'absent',accountId:ownerId,operationId:request.operationId,payloadHash:request.payloadHash};
  if(row.request_hash!==request.payloadHash)throw new ServiceError('account_follow_operation_conflict',409);
  return accountFollowReceiptSchema.parse(row.result);
 }
 receipt(actor,input){const request=parse(accountFollowReceiptRequestSchema,input);return this.run(actor,false,(db,ownerId)=>this.receiptWithin(db,ownerId,request));}
 command(actor,input){
  const request=parse(accountFollowCommandSchema,input),payloadHash=digest(JSON.stringify(request));
  return this.run(actor,true,async(db,ownerId)=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,839191))',[ownerId+':'+request.operationId]);
   const prior=await this.receiptWithin(db,ownerId,{operationId:request.operationId,payloadHash});
   if(prior.state==='acknowledged')return prior;
   if(ownerId===request.targetAccountId)throw new ServiceError('account_follow_self',409);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,839192))',[ownerId+':'+request.targetAccountId]);
   const row=(await db.query('SELECT id,following,revision,followed_at,updated_at FROM account_follows_v1 WHERE account_id=$1 AND target_account_id=$2 FOR UPDATE',[ownerId,request.targetAccountId])).rows[0];
   if((row?.revision??0)!==request.expectedRevision)throw new ServiceError('account_follow_changed',409);
   if(request.following&&!await this.targetWithin(db,request.targetAccountId,{lock:true}))throw new ServiceError('account_follow_target_unavailable',404);
   // A known owner can always cancel an existing choice, even after the target
   // closes public query. Cancellation cannot disclose the target's profile.
   const at=stamp(this.now()*1000);
   if((row?.following??false)!==request.following){
    await db.query(`INSERT INTO account_follows_v1(id,account_id,target_account_id,following,revision,created_at,followed_at,updated_at)
     VALUES($1,$2,$3,$4,1,$5,$5,$5) ON CONFLICT(account_id,target_account_id) DO UPDATE SET following=$4,
     revision=account_follows_v1.revision+1,followed_at=CASE WHEN $4 THEN $5 ELSE account_follows_v1.followed_at END,updated_at=$5`,
    [row?.id??randomUUID(),ownerId,request.targetAccountId,request.following,at]);
   }
   const result={state:'acknowledged',accountId:ownerId,operationId:request.operationId,payloadHash,relationship:await this.statusWithin(db,ownerId,request.targetAccountId)};
   await db.query('INSERT INTO account_follow_operations_v1(account_id,operation_id,request_hash,result,created_at) VALUES($1,$2,$3,$4,$5)',[ownerId,request.operationId,payloadHash,JSON.stringify(result),at]);
   return result;
  });
 }
 query(actor,input={}){
  const request=parse(accountFollowQuerySchema,input);return this.run(actor,false,async(db,ownerId)=>{
   let cursor=null;
   if(request.after){try{
    cursor=JSON.parse(Buffer.from(request.after.slice(4),'base64url').toString('utf8'));
    if(!cursor||Object.keys(cursor).sort().join(',')!=='accountId,at,id'||cursor.accountId!==ownerId||!z.uuid().safeParse(cursor.id).success||typeof cursor.at!=='string'||!Number.isFinite(Date.parse(cursor.at)))throw Error();
   }catch{throw new ServiceError('account_follow_cursor_unavailable',409);}}
   const rows=(await db.query(`SELECT f.id,f.target_account_id,f.following,f.revision,f.followed_at,f.updated_at,
    p.account_id AS profile_account_id,a.uid,p.display_name,p.subject_type
    FROM account_follows_v1 f
    LEFT JOIN community_accounts a ON a.id=f.target_account_id AND a.endpoint=$2
    LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id AND p.query_enabled=true
    WHERE f.account_id=$1 AND f.following=true AND ($3::timestamptz IS NULL OR (f.followed_at,f.id)<($3::timestamptz,$4::uuid))
    ORDER BY f.followed_at DESC,f.id DESC LIMIT $5`,[ownerId,this.endpoint,cursor?.at??null,cursor?.id??null,request.limit+1])).rows;
   // A null display name is still a readable profile. Use the actual public
   // profile join as the gate, never a name or the existence of the old choice.
   const items=rows.slice(0,request.limit).map(row=>({relationship:relationship(row.target_account_id,row),source:row.profile_account_id?
    {state:'available',profile:{accountId:row.target_account_id,uid:row.uid??null,displayName:row.display_name??null,subjectType:row.subject_type??null}}:
    {state:'unavailable',profile:null}}));
   const last=rows[request.limit-1],at=this.now();
   return {accountId:ownerId,items,nextAfter:rows.length>request.limit?'af1.'+Buffer.from(JSON.stringify({accountId:ownerId,at:stamp(last.followed_at),id:last.id})).toString('base64url'):null,
    checkedAt:at,readExpiresAt:at+30,visibility:'Private'};
  });
 }
}
