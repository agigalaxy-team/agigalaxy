import canonicalize from 'canonicalize';
import {sharedSummaryPublishSchema,sharedSummaryReceiptSchema,sharedSummaryReceiptResultSchema} from "../shared/chat-shared-summary-schema.mjs";
export async function sharedSummaryRequestHash(input){const request=sharedSummaryPublishSchema.parse(input),bytes=new TextEncoder().encode(canonicalize(request));
 return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');}
export function createChatSharedSummaryClient({call}){
 if(typeof call!=='function')throw new Error('Current authenticated API transport required');
 const methods=Object.fromEntries(['publish','get','list','retract'].map(method=>[method,(input,options)=>call('/v2/chat/shared-summaries/'+method,input,options)]));
 methods.receipt=async(input,options)=>{const query=sharedSummaryReceiptSchema.parse(input),result=sharedSummaryReceiptResultSchema.parse(await call('/v2/chat/shared-summaries/receipt',query,options));
  if(Object.entries(query).some(([key,value])=>result[key]!==value))throw new Error('shared_summary_receipt_mismatch');return result;};
 return Object.freeze(methods);
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
 const request=sharedSummaryPublishSchema.parse({shareId,roomId:room.roomId,expectedMemberRevision:room.memberRevision,audience:'room-authorized-members',content,...(supersedesShareId?{supersedesShareId}:{})});
 return{request,requestHash:await sharedSummaryRequestHash(request),localRevision:r.localRevision};
}
