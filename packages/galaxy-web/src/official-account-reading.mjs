/** Keep an unchanged, freshly checked session from restarting its consumers. */
export function sameOfficialSession(previous,next){
 if(!previous||!next)return false;
 return previous.state===next.state&&previous.expiresAt===next.expiresAt&&previous.csrfToken===next.csrfToken
  &&previous.nextAfter===next.nextAfter&&previous.galaxyAuthorization===next.galaxyAuthorization
  &&['id','uid','displayName','avatarKey','email','emailVerified'].every(key=>previous.account?.[key]===next.account?.[key])
  &&previous.linkedIds.length===next.linkedIds.length&&previous.linkedIds.every((item,index)=>item.subjectId===next.linkedIds[index].subjectId&&item.linkedAt===next.linkedIds[index].linkedAt);
}

/** A session's renewed expiry is not a new account/client. Read authority live. */
export function createCurrentOfficialAccount({client,accountId,csrfToken,getCurrent,now=()=>Date.now()}){
 const current=()=>{
  const model=getCurrent(),session=model?.session;
  if(['offline','unavailable'].includes(model?.phase))throw Object.assign(Error('official_account_unavailable'),{code:'official_account_unavailable'});
  if(model?.phase!=='signed-in'||model.client!==client||!session||session.account.id!==accountId||session.csrfToken!==csrfToken||session.expiresAt*1000<=now())throw Object.assign(Error('official_account_changed'),{code:'official_account_changed'});
  return session;
 };
 return {id:accountId,assertCurrent:()=>{current();},
  async call(path,input,options={}){const session=current(),result=await client.call(path,input,{...options,session});current();return result;},
  async transfer(path,input,options={}){const session=current(),result=await client.transfer(path,input,{...options,session});current();return result;},
 };
}
