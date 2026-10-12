import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {digest} from '../../../galaxy-official/src/shared/digest.mjs';
import {readingBookmarkReferenceSchema,readingBookmarkCommandSchema,readingBookmarkStateSchema,readingBookmarkReceiptReplySchema,readingBookmarkKey} from '../../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';

export const nativeBookmarkSetSchema=z.strictObject({reference:readingBookmarkReferenceSchema,saved:z.boolean()});
// The user chooses only the object and saved state. The local journal holds
// references and stable operations, never a retained copy of source content.
export function createNativeBookmarkSetter(runtime){
 const queues=new Map();
 async function change(input){
  const selected=nativeBookmarkSetSchema.parse(input);
  await runtime.ensureConnection();
  const lease=runtime.receiptStatus.captureLease();lease.assertCurrent();
  const subjectId=lease.subjectId,key='native-bookmark:'+lease.endpoint+':'+subjectId+':'+readingBookmarkKey(selected.reference);
  const call=async(method,body)=>{lease.assertCurrent();try{const result=await runtime.api.call('/v2/reading-bookmarks/'+method,body);lease.assertCurrent();return result;}catch(error){lease.assertCurrent();throw error;}};
  const current=async()=>{const state=readingBookmarkStateSchema.parse(await call('status',{reference:selected.reference}));
   if(readingBookmarkKey(state.reference)!==readingBookmarkKey(selected.reference))throw Error('reading_bookmark_reference_mismatch');
   return state;};
  const clear=async operationId=>{lease.assertCurrent();await runtime.store.update(key,prior=>prior?.command?.operationId===operationId?null:prior);lease.assertCurrent();};
  async function finish(row,alreadySent=false){
   const command=readingBookmarkCommandSchema.parse(row.command);
   if(readingBookmarkKey(command.reference)!==readingBookmarkKey(selected.reference)||digest(JSON.stringify(command))!==row.payloadHash)throw Error('reading_bookmark_local_record_invalid');
   const checked=value=>{const result=readingBookmarkReceiptReplySchema.parse(value);
    if(result.operationId!==command.operationId||result.payloadHash!==row.payloadHash||result.state==='acknowledged'&&readingBookmarkKey(result.bookmark.reference)!==readingBookmarkKey(command.reference))throw Error('reading_bookmark_receipt_mismatch');
    return result;};
   try{
    let receipt=alreadySent?{state:'absent'}:checked(await call('receipt',{operationId:command.operationId,payloadHash:row.payloadHash}));
    if(receipt.state==='absent'){
     try{receipt=checked(await call('command',command));}
     catch(error){
      // A lost response is checked immediately. If that check also fails,
      // retain the original operation for the next same-object attempt.
      if(error.status>=400&&error.status<500)throw error;
      receipt=checked(await call('receipt',{operationId:command.operationId,payloadHash:row.payloadHash}));
      if(receipt.state!=='acknowledged')throw error;
     }
    }
    if(receipt.state!=='acknowledged')throw Error('reading_bookmark_result_unknown');
    await clear(command.operationId);
    return {state:'acknowledged',bookmark:await current(),reconciled:!alreadySent};
   }catch(error){
    if(error.status>=400&&error.status<500){await clear(command.operationId);
     if(error.code==='reading_bookmark_changed')return {state:'changed',bookmark:await current()};
    }
    throw error;
   }
  }
  async function run(){
   lease.assertCurrent();const pending=await runtime.store.get(key);lease.assertCurrent();
   if(pending){const result=await finish(pending);
    // Recovering an old save reports today's state, including a later removal
    // from another device. It does not silently save the object again.
    if(pending.command.saved===selected.saved||result.state==='changed')return result;
   }
   const state=await current();if(state.saved===selected.saved)return {state:'acknowledged',bookmark:state};
   const command=readingBookmarkCommandSchema.parse({operationId:randomUUID(),...selected,expectedRevision:state.revision});
   const candidate={command,payloadHash:digest(JSON.stringify(command))};
   lease.assertCurrent();const stored=await runtime.store.update(key,prior=>prior??candidate);lease.assertCurrent();
   if(stored.command.operationId!==command.operationId){
    const result=await finish(stored);
    if(stored.command.saved!==selected.saved)throw Error('reading_bookmark_changed');
    return result;
   }
   return finish(stored,true);
  }
  const before=queues.get(key)??Promise.resolve(),operation=before.catch(()=>{}).then(run);queues.set(key,operation);
  try{return await operation;}finally{if(queues.get(key)===operation)queues.delete(key);}
 }
 return change;
}
