import {z} from 'zod';
import {ServiceError} from '../../shared/service-error.mjs';
import {businessSummaryQuerySchema} from '../../shared/business-admin-schema.mjs';
import {hasOperationsPermission} from '../../operations-permission-catalog.mjs';
import {operationsAnalyticsPeriod} from "../analytics/service.mjs";
import {DiscoveryAccountProfile,emptyAccountProfileAnalysis} from '../../discovery-runtime/account-profile.mjs';

/** Normal-purpose account observations. It owns no long-running transaction,
 * model, profile storage, recommendation write or independent permissions. */
export class OperationsAccountProfileSummary{
 constructor({businessAdmin,discovery=null,now=businessAdmin?.now??(()=>Math.floor(Date.now()/1000))}){
  if(!businessAdmin?.authorizeAction||!businessAdmin?.accountWithin)throw new TypeError('Account profile requires BusinessAdmin authorization');
  Object.assign(this,{businessAdmin,discovery,now});
 }
 async current(operator,accountId){
  const actor=await this.businessAdmin.authorizeAction(operator,'analytics.read');
  await this.businessAdmin.accountWithin(this.businessAdmin.db,accountId);return actor;
 }
 async get(operator,accountId,input={}){
  const id=z.uuid().safeParse(accountId),query=businessSummaryQuerySchema.safeParse(input);
  if(!id.success||!query.success)throw new ServiceError('invalid_business_admin_request',400);
  accountId=id.data.toLowerCase();const {days}=query.data,actor=await this.current(operator,accountId),window=operationsAnalyticsPeriod(this.now(),days),canReadRecommendations=hasOperationsPermission(actor,'recommendations.read');
  let value;
  try{
   const reader=new DiscoveryAccountProfile({db:this.businessAdmin.db,endpoint:this.businessAdmin.endpoint,source:this.discovery?.source,recommendations:this.discovery?.recommendationOperations,now:this.now});
   value=await reader.read(accountId,{period:window.period,canReadRecommendations});
  }catch(error){
   // Authorization and missing accounts never become an apparently empty
   // profile. Source/ledger failures remain local unavailable observations.
   if([401,403].includes(error?.status)||error?.code==='operations_authorization_unavailable')throw error;
   value={...emptyAccountProfileAnalysis(window.period,'unavailable',canReadRecommendations?'unavailable':'not-authorized'),readExpiresAt:this.now()+30};
  }
  const current=await this.current(actor,accountId),checkedAt=this.now();
  if(!hasOperationsPermission(current,'recommendations.read'))value.recommendations=emptyAccountProfileAnalysis(window.period,'empty','not-authorized').recommendations;
  if(value.readExpiresAt<=checkedAt)value={...emptyAccountProfileAnalysis(window.period,'unavailable',hasOperationsPermission(current,'recommendations.read')?'unavailable':'not-authorized'),readExpiresAt:checkedAt+30};
  return {accountId,days,period:window.period,checkedAt,readExpiresAt:Math.min(checkedAt+30,value.readExpiresAt),metadataOnly:true,profile:value.profile,recommendations:value.recommendations};
 }
}
