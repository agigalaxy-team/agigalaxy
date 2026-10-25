import {fail,text,number,bool,one,iso,uuid,array} from './safe-values.mjs';

export function registeredDirectoryItem(row){
 if(!row||!uuid(row.registrationId)||!row.identity)fail();
 return {registrationId:row.registrationId,identity:{source:'keycloak-website',displayName:text(row.identity.displayName,240),enabled:bool(row.identity.enabled),emailVerified:bool(row.identity.emailVerified),registeredAt:iso(row.identity.registeredAt),presence:one(row.identity.presence,['present','not-found','outside-configured-issuer','unavailable','not-configured'])},
  business:row.business?{accountId:uuid(row.business.accountId),uid:text(row.business.uid,80),displayName:text(row.business.displayName,120),subjectType:one(row.business.subjectType,['person','organization','agent']),businessCreatedAt:iso(row.business.businessCreatedAt),participation:{restricted:bool(row.business.restriction?.active),until:iso(row.business.restriction?.until)}}:null,
  stage:{state:one(row.stage?.state,['registered','completion-required','unknown'])},observedAt:iso(row.observedAt)};
}
export function registeredDirectoryPage(value,{filterSource='all'}={}){
 const populations={all:'website-registrations-and-business-only-accounts',registered:'configured-website-registration-directory','business-only':'business-accounts-absent-from-current-registration-directory'};
 if(!Object.hasOwn(populations,filterSource))fail();
 if(!value?.source||!value.pagination)fail();
 const source=value.source,pagination=value.pagination;
 return{items:array(value.items,100).map(registeredDirectoryItem),pagination:{page:number(pagination.page),pageSize:number(pagination.pageSize),total:number(pagination.total),matchingTotal:number(pagination.matchingTotal),totalPages:number(pagination.totalPages)},
  source:{state:one(source.state,['ready','syncing','not-configured','unavailable']),generationId:uuid(source.generationId),registeredAsOf:iso(source.registeredAsOf),syncStartedAt:iso(source.syncStartedAt),coverage:one(source.coverage,['complete-generation','not-ready']),atomicSourceSnapshot:false,registeredCount:number(source.registeredCount)},
  basis:{population:populations[filterSource],selectedSource:filterSource,registeredCountScope:'current-website-registered-identities',paginationCountScope:'selected-directory-source',counts:'complete-generation',identityFields:'email-issuer-subject-excluded',businessCreatedAtIsRegistration:false}};
}
