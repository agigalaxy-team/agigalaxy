import * as z from 'zod/v4';
import {readWithTransientRecovery} from '../../../../../integrations/shared/read-task.mjs';
import {sha256Hex, equalJson} from '../../../../galaxy-official/src/shared/web-primitives.mjs';
import {readingBookmarkReferenceSchema, readingBookmarkCommandSchema, readingBookmarkStateSchema,
  readingBookmarkReceiptReplySchema, accountReadingBookmarksPageSchema, readingBookmarkKey} from '../../../../galaxy-official/src/shared/reading-bookmarks-v1-schema.mjs';
import {accountBookmarkJournalStore} from "./account-bookmark-pending.mjs";

/** @typedef {import('zod/v4').infer<typeof readingBookmarkReferenceSchema>} ReadingBookmarkReference */
const journalSchema = z.strictObject({operations: z.record(z.string(), z.strictObject({
  command: readingBookmarkCommandSchema, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  bindingId: z.string(), generation: z.number(), blockedReason: z.string().optional(),
}))});
/** @typedef {import('zod/v4').infer<typeof journalSchema>} BookmarkJournal */
/** @typedef {BookmarkJournal['operations'][string]} BookmarkOperation */
/** @typedef {import('zod/v4').infer<typeof readingBookmarkReceiptReplySchema>|{state:'pending',reason:string,reference:ReadingBookmarkReference}} AccountBookmarkResult */
const failure = (code, message) => Object.assign(new Error(message), {code});

/** Account ownership never supplies or synthesizes a Galaxy subject credential.
 * @param {{client:ReturnType<typeof import('../accounts/official-account-client.mjs').createOfficialAccountClient>,
 * getSession:()=>import('../accounts/official-account-panel').OfficialSession|null,endpoint:string,
 * store?:{getLocal:(name:string,owner:string)=>Promise<unknown>,updateLocal:(name:string,update:(raw:unknown)=>unknown,owner:string)=>Promise<unknown>},
 * locks?:Pick<LockManager,'request'>|null,onAcknowledged?:(receipt:import('zod/v4').infer<typeof readingBookmarkReceiptReplySchema>)=>unknown}} options */
export function createAccountReadingBookmarksClient({client,getSession,endpoint,store=accountBookmarkJournalStore,locks=globalThis.navigator?.locks??null,onAcknowledged}){
  const initial=getSession(),ownerId=initial?.account.id;
  if(!ownerId)throw failure('official_account_session_expired','请登录后继续收藏。');
  const journalKey='account-reading-bookmarks-v2:'+endpoint;
  let queue=Promise.resolve();
  function capture(){
    const selected=getSession();
    if(selected?.account.id!==ownerId||selected.expiresAt*1000<=Date.now())throw failure('official_account_session_expired','请登录后继续收藏。');
    const assertCurrent=()=>{
      const current=getSession();
      if(current?.account.id!==ownerId||current.csrfToken!==selected.csrfToken||current.expiresAt*1000<=Date.now())throw failure('official_account_changed','账户已变化，请重新打开收藏。');
    };
    return {session:selected,assertCurrent};
  }
  /** @template T @param {ReturnType<typeof capture>} lease @param {()=>Promise<T>} action @returns {Promise<T>} */
  async function guarded(lease,action){
    lease.assertCurrent();let value;
    try{value=await action();}catch(error){lease.assertCurrent();throw error;}
    lease.assertCurrent();return value;
  }
  /** @param {ReturnType<typeof capture>} lease @param {string} method @param {unknown} input @param {{signal?:AbortSignal}} [options] */
  const read=(lease,method,input,options={})=>{
    const action=()=>guarded(lease,()=>client.call('/v1/account/bookmarks/'+method,input,{...options,session:lease.session}));
    return ['query','status','receipt'].includes(method)?readWithTransientRecovery(action,{signal:options.signal,check:lease.assertCurrent}):action();
  };
  const load=async lease=>journalSchema.parse(await guarded(lease,()=>store.getLocal(journalKey,ownerId))??{operations:{}});
  /** @param {ReturnType<typeof capture>} lease @param {(journal:BookmarkJournal)=>BookmarkJournal} action */
  const update=(lease,action)=>guarded(lease,()=>store.updateLocal(journalKey,raw=>{lease.assertCurrent();return action(journalSchema.parse(raw??{operations:{}}));},ownerId));
  /** @template T @param {(lease:ReturnType<typeof capture>)=>Promise<T>} action @returns {Promise<T>} */
  const serial=action=>{
    const lease=capture(),invoke=()=>guarded(lease,()=>action(lease));
    const run=()=>locks?locks.request('account-bookmarks:'+endpoint+':'+ownerId,{mode:'exclusive'},invoke):invoke();
    const next=queue.then(run,run);queue=next.then(()=>{},()=>{});return next;
  };
  /** @param {ReturnType<typeof capture>} lease @param {BookmarkOperation} record */
  async function receipt(lease,record){
    if(await sha256Hex(JSON.stringify(record.command))!==record.payloadHash)throw failure('reading_bookmark_original_changed','刚才的收藏暂时无法继续，请重新读取。');
    const value=readingBookmarkReceiptReplySchema.parse(await read(lease,'receipt',{operationId:record.command.operationId,payloadHash:record.payloadHash}));
    if(value.operationId!==record.command.operationId||value.payloadHash!==record.payloadHash||value.state==='acknowledged'&&!equalJson(value.bookmark.reference,record.command.reference))throw failure('reading_bookmark_receipt_mismatch','暂时无法确认收藏结果。');
    return value;
  }
  /** @param {ReturnType<typeof capture>} lease @param {string} key @param {BookmarkOperation} record @param {import('zod/v4').infer<typeof readingBookmarkReceiptReplySchema>} value @returns {Promise<import('zod/v4').infer<typeof readingBookmarkReceiptReplySchema>>} */
  async function settle(lease,key,record,value){
    await update(lease,journal=>{
      const current=journal.operations[key];
      if(current?.command.operationId!==record.command.operationId||current.payloadHash!==record.payloadHash)return journal;
      const operations={...journal.operations};delete operations[key];return {operations};
    });
    if(value?.state==='acknowledged'&&record.command.saved&&value.bookmark.saved&&onAcknowledged){
      // Only a verified receipt reaches this point, including receipt recovery.
      // Optional usage collection never changes a successful bookmark result.
      try{void Promise.resolve(onAcknowledged(value)).catch(()=>{});}catch{}
    }
    return value;
  }
  /** @param {ReturnType<typeof capture>} lease @param {string} key @param {BookmarkOperation} record @returns {Promise<AccountBookmarkResult>} */
  async function continueRecord(lease,key,record,explicit=false){
    const known=await receipt(lease,record);
    if(known.state==='acknowledged')return settle(lease,key,record,known);
    if(record.blockedReason&&!explicit)return {state:'pending',reason:record.blockedReason,reference:record.command.reference};
    if(record.blockedReason){await settle(lease,key,record,known);return known;}
    try{
      const value=readingBookmarkReceiptReplySchema.parse(await read(lease,'command',record.command));
      if(value.state!=='acknowledged'||value.operationId!==record.command.operationId||value.payloadHash!==record.payloadHash||!equalJson(value.bookmark.reference,record.command.reference))throw failure('reading_bookmark_receipt_mismatch','暂时无法确认收藏结果。');
      return settle(lease,key,record,value);
    }catch(error){
      if(error?.outcome==='rejected'&&['reading_bookmark_changed','reading_bookmark_operation_conflict','reading_bookmark_source_unavailable','invalid_reading_bookmark_request'].includes(error.code)){
        await update(lease,journal=>{
          const current=journal.operations[key];
          return current?.command.operationId===record.command.operationId?{operations:{...journal.operations,[key]:{...current,blockedReason:error.code}}}:journal;
        });return {state:'pending',reason:error.code,reference:record.command.reference};
      }throw error;
    }
  }
  return {
    ownerId,endpoint,current(){capture().assertCurrent();},
    /** @param {ReadingBookmarkReference} reference @param {{signal?:AbortSignal}} [options] */
    async status(reference,options={}){
      const selected=readingBookmarkReferenceSchema.parse(reference),value=readingBookmarkStateSchema.parse(await read(capture(),'status',{reference:selected},options));
      if(!equalJson(value.reference,selected))throw failure('reading_bookmark_receipt_mismatch','收藏对象暂时无法确认。');return value;
    },
    /** @param {unknown} [input] @param {{signal?:AbortSignal}} [options] */
    async query(input={},options={}){
      const page=accountReadingBookmarksPageSchema.parse(await read(capture(),'query',input,options));
      if(page.accountId!==ownerId)throw failure('reading_bookmark_receipt_mismatch','收藏账户暂时无法确认。');return page;
    },
    pending(){return serial(async lease=>Object.values((await load(lease)).operations));},
    /** @param {ReadingBookmarkReference|null} [reference] */
    resumePending(reference=null){return serial(async lease=>{
      const selected=reference?readingBookmarkKey(reference):null,journal=await load(lease);
      /** @type {AccountBookmarkResult[]} */ const items=[];
      for(const[key,record]of Object.entries(journal.operations))if(!selected||key===selected){
        try{items.push(await continueRecord(lease,key,record));}catch{lease.assertCurrent();items.push({state:'pending',reason:'temporarily-unavailable',reference:record.command.reference});}
      }return {items};
    });},
    /** @param {ReadingBookmarkReference} reference @param {boolean} saved */
    setSaved(reference,saved){
      const selected=readingBookmarkReferenceSchema.parse(reference),key=readingBookmarkKey(selected);
      return serial(async lease=>{
        const original=(await load(lease)).operations[key];
        if(original){const known=await continueRecord(lease,key,original);if(known.state==='pending')throw failure('reading_bookmark_pending','正在保存收藏，请稍后重试。');if(original.command.saved===saved)return known;}
        const previous=readingBookmarkStateSchema.parse(await read(lease,'status',{reference:selected}));
        if(!equalJson(previous.reference,selected))throw failure('reading_bookmark_receipt_mismatch','收藏对象暂时无法确认。');
        const command=readingBookmarkCommandSchema.parse({operationId:crypto.randomUUID(),reference:selected,saved,expectedRevision:previous.revision});
        const record={command,payloadHash:await guarded(lease,()=>sha256Hex(JSON.stringify(command))),bindingId:'account:'+ownerId,generation:1};
        await update(lease,journal=>{if(journal.operations[key])throw failure('reading_bookmark_pending','正在保存收藏，请稍后重试。');return {operations:{...journal.operations,[key]:record}};});
        return continueRecord(lease,key,record);
      });
    },
    retry(reference){const key=readingBookmarkKey(reference);return serial(async lease=>{const record=(await load(lease)).operations[key];return record?continueRecord(lease,key,record,true):null;});},
  };
}
