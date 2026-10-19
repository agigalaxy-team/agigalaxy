import {z} from 'zod';
import {body,authenticate} from './request.mjs';
import {ServiceError} from '../../shared/service-error.mjs';
import {OfficialAccountData} from '../../official-account-data.mjs';
import {communityAccountView} from '../../community-accounts.mjs';

const methods={create:'createArchive',chunk:'appendChunk',complete:'completeArchive',list:'listArchives',status:'archiveStatus',export:'exportChunk',delete:'deleteArchive',cleanup:'cleanup'};
export async function dispatchAccountArchives({access,communityAccounts,request,url,send}){
 if(!url.pathname.startsWith('/v2/account-archives/'))return false;
 if(request.method==='POST'&&url.pathname==='/v2/account-archives/accounts'&&!url.search){
   const actor=await authenticate(request,access,'binding');await body(request,[]);
   send(200,await access.runAuthorized(actor,'binding',async db=>({accounts:(await communityAccounts.availableWithin(db,actor)).map(row=>communityAccountView(row)),subjectId:actor.subjectId})));return true;
 }
 const operation=methods[url.pathname.slice('/v2/account-archives/'.length)];
 if(request.method!=='POST'||!operation||url.search)throw new ServiceError('not_found',404);
 const authenticated=await authenticate(request,access,'binding'),accountId=request.headers['x-galaxy-account-id'];
 if(!z.uuid().safeParse(accountId).success)throw new ServiceError('account_selection_required',409);
 const actor={...authenticated,accountId};
 const input=await body(request,operation==='cleanup'?[]:undefined,{maxBytes:operation==='appendChunk'?1572864:32768});
 const write=['createArchive','appendChunk','completeArchive'].includes(operation);
 const result=await communityAccounts.runAuthorized(actor,'binding',async(db,_authorization,authorizedActor)=>{
   const target=await communityAccounts.resolveWithin(db,authorizedActor,{accountId,requireExplicit:true});
   const archiveActor={...authorizedActor,kind:'linked-id',accountId:target.id,accountAuthorized:true,endpoint:access.endpoint};
   const data=new OfficialAccountData({db,endpoint:access.endpoint,now:access.now,inTransaction:true});
   return data[operation](archiveActor,input);
 },{resourceWrite:write});
 send(200,result);return true;
}
