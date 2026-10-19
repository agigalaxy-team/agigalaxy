const pendingKey='galaxy-forum:login-draft';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const route=value=>{try{const url=new URL(value,'https://galaxy.invalid');if(url.origin!=='https://galaxy.invalid'||!url.pathname.startsWith('/app/community')||url.pathname.includes('\\'))return null;url.searchParams.delete('accountLogin');return url.pathname+url.search+url.hash;}catch{return null;}};

// This tab-local reference contains no text or authorization. Only an unsent
// visitor draft can follow the login it initiated; ID/account drafts stay owned.
export function rememberForumLoginDraft({endpoint,context,path,draft},storage=globalThis.sessionStorage,now=Date.now()){
 if(!draft||draft.operationId||!uuid(draft.id)||!Number.isSafeInteger(draft.revision)||draft.revision<1||!route(path))return false;
 try{storage.setItem(pendingKey,JSON.stringify({version:1,endpoint,context,path:route(path),reference:{id:draft.id,revision:draft.revision},expiresAt:now+600000}));return true;}catch{return false;}
}
export function forumLoginDraft({endpoint,context,path},storage=globalThis.sessionStorage,now=Date.now()){
 try{const value=JSON.parse(storage.getItem(pendingKey)??'null');
  if(value?.version!==1||value.endpoint!==endpoint||value.context!==context||value.path!==route(path)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+600000||!uuid(value.reference?.id)||!Number.isSafeInteger(value.reference?.revision)||value.reference.revision<1)return null;
  return value.reference;
 }catch{return null;}
}
export function clearForumLoginDraft(reference,storage=globalThis.sessionStorage){
 try{const value=JSON.parse(storage.getItem(pendingKey)??'null');if(value?.reference?.id===reference.id&&value.reference.revision===reference.revision)storage.removeItem(pendingKey);}catch{/* The draft itself remains in local storage. */}
}
export function forumAuthorAccountId(value){return value?.authorAccountId??value?.author?.accountId??null;}
export function forumAuthorSubjectId(value){return value?.authorId??value?.author?.subjectId??null;}
/** @param {any} value @param {{accountId?:string|null,subjectId?:string|null,targetAccountId?:string|null}} [options] */
export function forumOwnsContent(value,{accountId=null,subjectId=null,targetAccountId=null}={}){
 if(accountId)return forumAuthorAccountId(value)===accountId;
 // The caller obtains this exact target from the current authorized quota read.
 // It is authority to manage that account's forum content, not rewritten authorship.
 if(subjectId&&targetAccountId)return forumAuthorAccountId(value)===targetAccountId;
 if(!subjectId||forumAuthorSubjectId(value)!==subjectId)return false;
 return true;
}
