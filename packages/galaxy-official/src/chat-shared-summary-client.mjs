import {sharedSummaryPublishSchema} from './shared/chat-shared-summary-schema.mjs';
export function createChatSharedSummaryClient({call}){
 if(typeof call!=='function')throw new Error('Current authenticated API transport required');
 return Object.freeze(Object.fromEntries(['publish','get','list','retract'].map(method=>[method,(input,options)=>call('/v2/chat/shared-summaries/'+method,input,options)])));
}
// Selection is mandatory and never inferred from a cloud sync preference. This
// pure preparation step does not publish or modify the local personal version.
export async function prepareRoomSummaryShare({local,summaryId,expectedLocalRevision,fragmentIds,keyMessageRefs,room,shareId=globalThis.crypto.randomUUID(),supersedesShareId}){
 if(!Array.isArray(fragmentIds)||!Array.isArray(keyMessageRefs)||!room?.roomId)throw new Error('summary_share_selection_required');
 const r=await local.get({summaryId});if(!r||r.roomId!==room.roomId)throw new Error('summary_share_room_mismatch');
 if(r.localRevision!==expectedLocalRevision)throw new Error('summary_share_selection_changed');
 const selected=new Set(fragmentIds);if(selected.size!==fragmentIds.length||[...selected].some(id=>!r.content.fragments.some(f=>f.id===id)))throw new Error('summary_share_selection_changed');
 const key=x=>x.messageId+':'+x.revision,keys=new Set(keyMessageRefs.map(key));
 if(keys.size!==keyMessageRefs.length||keyMessageRefs.some(x=>!r.content.keyMessageRefs.some(y=>key(x)===key(y))))throw new Error('summary_share_selection_changed');
 const content=structuredClone(r.content);content.fragments=content.fragments.filter(f=>selected.has(f.id));content.keyMessageRefs=content.keyMessageRefs.filter(r=>keys.has(key(r)));
 if(content.fragments.length!==r.content.fragments.length||content.keyMessageRefs.length!==r.content.keyMessageRefs.length)content.coverage.complete=false;
 return{request:sharedSummaryPublishSchema.parse({shareId,roomId:room.roomId,expectedMemberRevision:room.memberRevision,audience:'room-authorized-members',content,...(supersedesShareId?{supersedesShareId}:{})}),localRevision:r.localRevision};
}
