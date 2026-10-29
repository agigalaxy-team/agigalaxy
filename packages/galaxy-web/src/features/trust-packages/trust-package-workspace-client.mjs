import {createTaskLocalDraftClient,taskLocalDraftView} from "../tasks/publish/task-local-draft-client.mjs";
import {createProfileClient} from "../profiles/profile-client.mjs";
import {trustAudienceAllows} from "../../../../galaxy-contracts/src/verification/trust-package.mjs";
import {trustCanonical} from "../../../../galaxy-contracts/src/trust-package-crypto.mjs";
import {trustContainerSchema} from "../../../../galaxy-contracts/src/trust-package-schema.mjs";

export const trustReferenceKey=ref=>JSON.stringify([ref.endpoint,ref.kind,ref.id,ref.version]);
export function matchingTrustPermission(permissions,ref,audience,subjectId,now=Math.floor(Date.now()/1000)){
 return permissions.filter(item=>item.status==='active'&&item.granteeId===subjectId&&item.expiresAt>now
  &&trustCanonical(item.source)===trustCanonical(ref)&&trustAudienceAllows(item.audience,audience)).sort((a,b)=>b.expiresAt-a.expiresAt)[0]??null;
}
const sameHead=(a,b)=>!!a&&!!b&&a.id===b.id&&a.revision===b.revision;
const clone=value=>structuredClone(value);

/** Local form and read projection adapter. Signing remains in the existing client. */
/** @param {any} runtime @param {{subjectId:string,connected?:boolean}} options */
export function createTrustPackageWorkspaceClient(runtime,{subjectId,connected=true}){
 const endpoint=runtime.api.endpoint,scope=runtime.taskDraftScope(),initial=runtime.api.snapshot?.()??null;
 const lease=connected?runtime.receiptStatus.captureLease():null;let closed=false;
 function check(){lease?.assertCurrent();const current=runtime.api.snapshot?.()??null;
  if(closed||runtime.api.endpoint!==endpoint||runtime.taskDraftScope().key!==scope.key
   ||['subjectId','bindingId','generation'].some(key=>initial?.[key]!==current?.[key]))throw Error('trust_identity_changed');}
 const wait=async fn=>{check();try{const value=await fn();check();return value;}catch(error){check();throw error;}};
 const call=(path,input)=>wait(()=>runtime.api.call(path,input));
  const exportKey=contextKey=>'trust-package:context-export:'+contextKey;
  async function readExport(contextKey){
   const record=await wait(()=>runtime.getLocal(exportKey(contextKey),subjectId));
   if(!record)return null;
   const parsed=trustContainerSchema.safeParse(record.container);
   if(record.contextKey!==contextKey||record.endpoint!==endpoint||record.subjectId!==subjectId||!parsed.success)throw Error('trust_original_package_unavailable');
   const manifest=JSON.parse(parsed.data.manifestJson);if(manifest.subjectId!==subjectId||manifest.packageId!==record.packageId)throw Error('trust_original_package_unavailable');
   return {...record,container:parsed.data};
  }
 function draft(name){
  const local=createTaskLocalDraftClient({captureLease:()=>({endpoint,subjectId,deviceId:scope.deviceId,
   bindingId:initial?.bindingId??null,generation:initial?.generation??null,assertCurrent:check}),
   getLocal:()=>runtime.getLocal(name,subjectId),updateLocal:(_name,updater)=>runtime.updateLocal(name,updater,subjectId)});
  return Object.freeze({...local,
   async readAttempt(){const saved=await wait(()=>runtime.getLocal(name,subjectId)),view=taskLocalDraftView(saved);
    return saved?.attempt&&sameHead(view?.head,saved.attempt.draftHead)?clone(saved.attempt):null;},
   async attach(locator,head){await local.flush();if(!head)return false;let attached=false;
    await wait(()=>runtime.updateLocal(name,current=>{check();const view=taskLocalDraftView(current);if(!sameHead(view?.head,head))return current;
     attached=true;return{...current,attempt:{...clone(locator),draftHead:clone(head)}};},subjectId));return attached;},
   async settle(receipt){await local.flush();const saved=await wait(()=>runtime.getLocal(name,subjectId)),view=taskLocalDraftView(saved),attempt=saved?.attempt;
    if(!attempt||!sameHead(view?.head,attempt.draftHead))return false;
    const result=await wait(()=>receipt(clone(attempt)));if(result?.state!=='acknowledged')return false;
    return local.clear(view.head);}
  });
 }
 async function names(ids){const profile=createProfileClient(runtime,{subjectId,authenticated:connected});
  try{const values=[];for(let start=0;start<ids.length;start+=20)values.push(...await wait(()=>profile.displayNames(ids.slice(start,start+20))));return values;}
  finally{profile.close();}}
  return Object.freeze({check,close(){closed=true;},draft,names,readExport,
   /** @param {Record<string, unknown> | null} [compose] Local form retained with this exact export. */
   rememberExport:(contextKey,result,compose=null)=>wait(()=>runtime.putLocal(exportKey(contextKey),{contextKey,endpoint,subjectId,packageId:result.packageId,container:result.container,...(compose?{compose:clone(compose)}:{})},subjectId)),
  async peoplePage(kind,{after}={}){const page=await call(kind==='contacts'?'/v2/contacts/query':'/v2/chat/rooms/query',
   {...(kind==='contacts'?{direction:'both',limit:50}:{limit:30}),...(after?{after}:{})}),found=new Map();
   if(kind==='contacts')for(const item of page.items??[]){if(item.state!=='accepted')continue;const id=item.initiatorId===subjectId?item.recipientId:item.initiatorId;if(id&&id!==subjectId)found.set(id,'联系人');}
   else for(const room of page.rooms??[])for(const member of room.members??[])if(member.subjectId!==subjectId)found.set(member.subjectId,'共同对话');
   const values=await names([...found.keys()]);return{items:values.map(item=>({...item,relation:found.get(item.subjectId)})),next:kind==='contacts'?page.nextAfter??null:page.next??null};
  },
  async workPage(view,{after}={}){const history=view==='history',page=await call(history?'/v2/history/query':'/v2/tasks/query',
   {...(history?{subjectId,timeWindow:{kind:'all-visible'}}:{view}),limit:20,...(after?{after}:{})});
   return{items:history?(page.items??[]).filter(item=>item.kind==='case-history'):page.items??[],next:history?page.nextCursor??null:page.nextAfter??null};
  },
  async readWork(work){if(!work.caseId)throw Error('trust_source_unavailable');
   const view=await call('/v2/cases/'+work.caseId+'/read',work.taskId?{taskId:work.taskId}:{}),items=[];
   for(const event of view.events??[])if(event.actorId===subjectId)items.push({ref:{endpoint,kind:'case-event',id:event.eventId,caseId:work.caseId,
    version:event.caseVersion,...(work.taskId?{taskId:work.taskId}:{})},title:event.title??event.summary??event.description??event.strategy??'本人工作记录',bodyText:JSON.stringify(event),authorId:subjectId});
   let after;const seen=new Set();
   for(;;){const page=await call('/v2/history/query',{subjectId,timeWindow:{kind:'all-visible'},query:work.caseId,limit:20,...(after?{after}:{})});
    for(const item of page.items??[])if(item.kind==='case-history'&&item.caseId===work.caseId)for(const record of item.verificationRecords??[]){
     const type=record.objectType??record.type;if(!['evidence','verification'].includes(type)||!record.id)continue;
     try{const read=await call('/v2/verification-records/read',{type,id:record.id,...(record.version?{version:record.version}:{})});
      if(!read.record||read.record.reportedBy!==subjectId||!['current','superseded'].includes(read.referenceStatus))continue;items.push({ref:{endpoint,kind:type,id:record.id,version:read.version,caseId:work.caseId},
       title:read.record.summary??read.record.observation??read.record.description??'本人检查材料',bodyText:JSON.stringify(read.record),authorId:subjectId});
     }catch(error){check();if(!['not_found','verification_record_unavailable','consent_required','reference_not_visible'].includes(error?.code))throw error;}
    }
    if(!page.nextCursor)break;if(seen.has(page.nextCursor))throw Error('trust_source_cursor_invalid');seen.add(page.nextCursor);after=page.nextCursor;
   }
   return[...new Map(items.map(item=>[trustReferenceKey(item.ref),item])).values()];
  },
  async sourceReading(selection,{audience,expiresAt}){const result=await call('/v2/trust-package/sources',{selections:[selection],audience,expiresAt}),item=result.items?.[0];
   if(!item||item.state!=='available')return{ref:selection.ref,state:'unavailable',reason:item?.reason??'trust_source_unavailable'};
   let bodyText=item.snapshot.bodyText,readExpiresAt;
   if(item.snapshot.permission?.signed){try{const bytes=item.snapshot.permission.signed.split('.')[1].replaceAll('-','+').replaceAll('_','/'),payload=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(bytes),ch=>ch.charCodeAt(0))));readExpiresAt=payload.expiresAt;}catch{throw Error('trust_source_unavailable');}}
   if(!bodyText&&selection.ref.kind==='case-event'){const view=await call('/v2/cases/'+selection.ref.caseId+'/read',selection.ref.taskId?{taskId:selection.ref.taskId}:{}),
    event=(view.events??[]).find(event=>event.eventId===selection.ref.id&&event.caseVersion===selection.ref.version&&event.actorId===subjectId);
    if(event)bodyText=JSON.stringify(event);if(view.readExpiresAt)readExpiresAt=Math.min(readExpiresAt??Infinity,view.readExpiresAt);}
   if(!bodyText&&['evidence','verification'].includes(selection.ref.kind)){
    const view=await call('/v2/verification-records/read',{type:selection.ref.kind,id:selection.ref.id,version:selection.ref.version});
    if(view.record?.reportedBy===subjectId&&['current','superseded'].includes(view.referenceStatus))bodyText=JSON.stringify(view.record);
   }
   // The final source read clears text obtained just before a license or source
   // change. UI-only reading is never inserted into a reference-only package.
   const current=await call('/v2/trust-package/sources',{selections:[selection],audience,expiresAt});
   if(current.items?.[0]?.state!=='available')return{ref:selection.ref,state:'unavailable',reason:current.items?.[0]?.reason??'trust_source_unavailable'};
   if(readExpiresAt!==undefined&&readExpiresAt<=Math.floor(Date.now()/1000))return{ref:selection.ref,state:'unavailable',reason:'trust_permission_expired'};
   return{...item,snapshot:{...item.snapshot,...(bodyText?{bodyText}: {})},...(readExpiresAt!==undefined?{readExpiresAt}:{})};
  },
  permissions:(role,{after}={})=>call('/v2/trust-package/permissions/query',{role,...(after?{after}:{})}),
  permissionStatus:id=>call('/v2/trust-package/permissions/status',{id}),
   async exportReceipt(locator){if(locator.kind!=='trust-package-export'||locator.endpoint!==endpoint||locator.subjectId!==subjectId)throw Error('trust_operation_unavailable');
    const scoped=typeof locator.contextKey==='string'?await readExport(locator.contextKey):null;
    if(scoped?.packageId===locator.packageId)return{state:'acknowledged',packageId:locator.packageId};
    const saved=await wait(()=>runtime.trustPackages.lastExport());return{state:saved?.packageId===locator.packageId?'acknowledged':'absent',packageId:locator.packageId};}
 });
}

/** Merge only explicit service relationships; a missing Case is never invented. */
export function mergeTrustWorks(previous,incoming){const all=[...previous,...incoming],map=new Map();
 for(const item of all){const key=item.taskId?'task:'+item.taskId:item.caseId?'case:'+item.caseId:null;if(!key)continue;const old=map.get(key);
  map.set(key,{...old,...item,request:item.request??old?.request,caseId:item.caseId??old?.caseId,title:item.request?.title??old?.request?.title??item.title??old?.title});}
 return[...map.values()];
}
