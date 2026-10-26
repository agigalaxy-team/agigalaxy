import {randomUUID} from 'node:crypto';
import {ServiceError} from "../../shared/service-error.mjs";
import {accountTypeChangeSchema} from "../../shared/business-admin-schema.mjs";
import {ensureOfficialAccountProfileWithin} from "../../accounts/uid.mjs";

export const businessRestrictionView=(row,now)=>({
 scope:'community-participation',active:!!row.restricted_until&&Date.parse(row.restricted_until)>now*1000,
 until:row.restricted_until?new Date(row.restricted_until).toISOString():null,
 reason:row.restriction_reason??null,revision:row.restriction_revision??0
});

// Both the owner and the operations service use the same type-change rules and
// row lock. An operator is recorded as an operator, never as the account owner.
export async function changeAccountTypeWithin(db,{accountId,endpoint,now,source,input,permissions=null}){
 const parsed=accountTypeChangeSchema.safeParse(input);
 if(!parsed.success)throw new ServiceError('invalid_account_data');
 const data=parsed.data;
 const owner=source?.kind==='account-owner'&&source.accountId===accountId;
 const operator=source?.kind==='business-operator'&&source.endpoint===endpoint&&typeof source.operatorId==='string'&&!!source.operatorId;
 if(!owner&&!operator)throw new ServiceError('business_admin_denied',403);
 if(operator){if(!permissions)throw new ServiceError('operations_authorization_unavailable',503);source=await permissions.requireAction(source,'accounts.type.change',{db});}
 if(!(await db.query('SELECT 1 FROM community_accounts WHERE id=$1 AND endpoint=$2 FOR UPDATE',[accountId,endpoint])).rows.length)throw new ServiceError('not_found',404);
 await ensureOfficialAccountProfileWithin(db,accountId,{now});
 const row=(await db.query('SELECT * FROM official_account_profiles_v1 WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
 if(row.revision!==data.expectedRevision)throw new ServiceError('account_settings_changed',409);
 if(row.subject_type===data.subjectType)throw new ServiceError('account_type_unchanged',409);
 const revision=row.revision+1,at=new Date(now*1000).toISOString();
 await db.query(`INSERT INTO official_account_type_history_v1(id,account_id,revision,previous_type,next_type,reason,basis,created_at,actor_kind,operator_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
 [randomUUID(),accountId,revision,row.subject_type,data.subjectType,data.reason,data.basis,at,owner?'account-owner':'business-operator',operator?source.operatorId:null]);
 await db.query('UPDATE official_account_profiles_v1 SET subject_type=$2,revision=$3,updated_at=$4 WHERE account_id=$1',[accountId,data.subjectType,revision,at]);
 return {accountId,previousType:row.subject_type,subjectType:data.subjectType,revision,
  basisKind:owner?'account-owner-statement':'operator-recorded-statement',permissionsChanged:false};
}

export async function changeAccountRestrictionWithin(db,{accountId,endpoint,now,source,input,release=false,permissions=null}){
 const duty=source?.kind==='operations-ai-service'&&permissions?.aiServiceAuthority?.acceptsDuty(source);
 if((source?.kind!=='business-operator'&&!duty)||source.endpoint!==endpoint)throw new ServiceError('business_admin_denied',403);
 if(!permissions)throw new ServiceError('operations_authorization_unavailable',503);
 const action=release?'accounts.restriction.release':'accounts.restriction.apply';
 source=duty?await permissions.aiServiceAuthority.requireDutyOperation(source,[action],{accountId,...input},{db,action:release?'restriction-release':'restriction-set'}):await permissions.requireAction(source,action,{db});
 const row=(await db.query('SELECT * FROM community_accounts WHERE id=$1 AND endpoint=$2 FOR UPDATE',[accountId,endpoint])).rows[0];
 if(!row)throw new ServiceError('not_found',404);
 if(row.restriction_revision!==input.expectedRevision)throw new ServiceError('account_restriction_changed',409);
 if(!release&&(!Number.isFinite(Date.parse(input.until))||Date.parse(input.until)<=now*1000))throw new ServiceError('invalid_restriction_expiry',400);
 const before=businessRestrictionView(row,now);
 const changed=(await db.query(`UPDATE community_accounts SET restricted_until=$3,restriction_reason=$4,restriction_revision=restriction_revision+1
  WHERE id=$1 AND endpoint=$2 RETURNING *`,[accountId,endpoint,release?null:input.until,release?null:input.reason])).rows[0];
 return {accountId,before,restriction:businessRestrictionView(changed,now)};
}
