import {ServiceError} from "../shared/service-error.mjs";

const accountPattern=/^account:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const identityPattern=/^GUID[A-Z0-9]{28}$/;
export const isAccountChatRef=value=>typeof value==='string'&&accountPattern.test(value);
export function chatActorRef(actor){
  if(actor?.kind==='official-account'){
    const ref='account:'+actor.accountId;
    if(!isAccountChatRef(ref))throw new ServiceError('access_denied',401);
    return ref;
  }
  if(!identityPattern.test(actor?.subjectId??''))throw new ServiceError('access_denied',401);
  return actor.subjectId;
}
export function chatActorView(ref){
  const account=typeof ref==='string'?accountPattern.exec(ref):null;
  if(account)return {kind:'official-account',actorRef:ref,accountId:account[1],galaxySubjectId:null};
  if(identityPattern.test(ref??''))return {kind:'identity',actorRef:ref,accountId:null,galaxySubjectId:ref};
  throw new ServiceError('invalid_chat_participant',400);
}
// This table contains chat participation references, never Galaxy subjects or
// credentials. Known account recipients need not publish their whole profile.
export async function ensureChatParticipantWithin(db,ref,endpoint){
  const view=chatActorView(ref);
  const found=view.kind==='official-account'
    ?(await db.query('SELECT id FROM community_accounts WHERE id=$1 AND endpoint=$2',[view.accountId,endpoint])).rows[0]
    :(await db.query('SELECT id FROM subjects WHERE id=$1',[ref])).rows[0];
  if(!found)throw new ServiceError('chat_participant_unavailable',404);
  await db.query(`INSERT INTO chat_participants_v3(actor_ref,kind,subject_id,account_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(actor_ref) DO NOTHING`,[ref,view.kind,view.galaxySubjectId,view.accountId]);
  return view;
}
export const ensureChatActorWithin=(db,actor,endpoint)=>ensureChatParticipantWithin(db,chatActorRef(actor),endpoint);
