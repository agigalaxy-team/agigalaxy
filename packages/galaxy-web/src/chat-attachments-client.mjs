import {attachmentPrepareSchema} from '../../galaxy-official/src/shared/chat-attachments-schema.mjs';
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const operations=new WeakMap();
const storedStates=new Set(['scan-pending','scanning','available','blocked','erased','revoked','expired']);
export function createAttachmentsClient({api,getLocal,putLocal}){
 const path='/v2/chat/attachments/',key=roomId=>'chat-attachment-operation:'+roomId;
 const subjectId=api.snapshot()?.subjectId,endpoint=api.endpoint;
 const changed=()=>Object.assign(new Error('身份或连接已改变，请重新打开原房间。'),{code:'attachment_authority_changed'});
 const capture=()=>{const s=api.snapshot();if(!subjectId||s?.subjectId!==subjectId||api.endpoint!==endpoint)throw changed();
  return JSON.stringify([api.endpoint,s.subjectId,s.bindingId,s.generation??null,s.control?.deviceId??null,s.control?.epoch??null]);};
 const owner=lease=>{if(capture()!==lease)throw changed();};
 const guard=async(lease,fn)=>{owner(lease);let result;try{result=await fn();}catch(error){owner(lease);throw error;}owner(lease);return result;};
 const load=(lease,roomId)=>guard(lease,()=>getLocal(key(roomId)));
 const save=(lease,roomId,value)=>guard(lease,()=>putLocal(key(roomId),value));
 const call=(lease,name,input)=>guard(lease,()=>api.call(path+name,input));
 // Each operation captures once before any async file, store, digest or API
 // work. A changed binding may explicitly review the original journal again,
 // but an already waiting caller never acquires that new connection.
 const serial=async(roomId,fn)=>{const lease=capture();let locks=operations.get(api);if(!locks){locks=new Set();operations.set(api,locks);}if(locks.has(roomId))throw new Error('本房间已有附件操作正在处理。');locks.add(roomId);try{const result=await fn(lease);owner(lease);return result;}finally{locks.delete(roomId);}};
 const validRecord=(lease,record,roomId)=>{owner(lease);if(record&&(record.subjectId!==subjectId||record.input.roomId!==roomId))throw new Error('请先连接原来选择文件的身份。');return record;};
 async function receipt(lease,record,value){
  if(value.attachmentId!==record.input.attachmentId||value.roomId!==record.input.roomId||value.sha256!==record.input.sha256||value.size!==record.input.size)throw new Error('附件回执不匹配，请保留原操作。');
  if(storedStates.has(value.processingState??value.state))await save(lease,record.input.roomId,null);
  return value;
 }
 async function upload(lease,record,file,{signal,onStage=()=>{}}={}){
  validRecord(lease,record,record.input.roomId);signal?.throwIfAborted();
  const bytes=new Uint8Array(await guard(lease,()=>file.arrayBuffer()));
  if(bytes.length!==record.input.size||await guard(lease,()=>sha(bytes))!==record.input.sha256)throw new Error('所选文件与原操作不一致。');
  signal?.throwIfAborted();onStage('确认上传记录');const prepared=await receipt(lease,record,await call(lease,'prepare',record.input));
  if(storedStates.has(prepared.processingState??prepared.state)||prepared.access?.stopped)return prepared;
  signal?.throwIfAborted();onStage('正在上传');const result=await receipt(lease,record,await guard(lease,()=>api.attachmentTransfer(path+record.input.attachmentId+'/upload',{bytes,signal})));
  onStage('等待扫描');return result;
 }
 return Object.freeze({
  config:async()=>call(capture(),'config',{}),query:async(roomId,after)=>call(capture(),'query',{roomId,...(after?{after}:{})}),
  pending:async roomId=>{const lease=capture();return validRecord(lease,await load(lease,roomId),roomId);},
  reconcile:roomId=>serial(roomId,async lease=>{const record=validRecord(lease,await load(lease,roomId),roomId);if(!record)return {state:'none'};return receipt(lease,record,await call(lease,'read',{attachmentId:record.input.attachmentId}));}),
  /** @param {string} roomId @param {File} file @param {{confirmed?:boolean,signal?:AbortSignal,onStage?:(stage:string)=>void}} [options] */
  async send(roomId,file,{confirmed=false,...options}={}){return serial(roomId,async lease=>{
   if(!confirmed||!api.snapshot())throw new Error('请确认将所选文件上传为房间临时附件。');
   if(await load(lease,roomId))throw new Error('请先恢复或撤销上一次上传。');
   const limits=await call(lease,'config',{});if(!limits.supported)throw new Error('附件服务目前不可用。');
   if(!file.size||file.size>limits.maxFileBytes)throw new Error('文件为空或超出本房间的单文件限额。');
   options.signal?.throwIfAborted();const bytes=new Uint8Array(await guard(lease,()=>file.arrayBuffer())),input=attachmentPrepareSchema.parse({attachmentId:crypto.randomUUID(),roomId,name:file.name,
    mediaType:(file.type||'application/octet-stream').toLowerCase(),size:bytes.length,sha256:await guard(lease,()=>sha(bytes)),purpose:'temporary-room-attachment',confirmed:true});
   options.signal?.throwIfAborted();const record={subjectId,input};await save(lease,roomId,record);
   return upload(lease,record,file,options);
  });},
  async retry(roomId,file,options={}){return serial(roomId,async lease=>{if(!options.confirmed)throw new Error('请确认恢复原文件上传。');const record=validRecord(lease,await load(lease,roomId),roomId);if(!record)throw new Error('没有待恢复上传。');return upload(lease,record,file,options);});},
  async revoke(roomId,attachmentId){return serial(roomId,async lease=>{const result=await call(lease,'revoke',{attachmentId});const record=await load(lease,roomId);if(record?.input.attachmentId===attachmentId)await save(lease,roomId,null);return result;});},
  async abandon(roomId){return serial(roomId,async lease=>{const record=validRecord(lease,await load(lease,roomId),roomId);if(record){try{await call(lease,'revoke',{attachmentId:record.input.attachmentId});}
   catch(error){if(error.code!=='attachment_unavailable')throw error;owner(lease);}await save(lease,roomId,null);}});},
  read:async attachmentId=>call(capture(),'read',{attachmentId}),
  async download(item,{ownExport=false}={}){const lease=capture(),result=await guard(lease,()=>api.attachmentTransfer(path+item.attachmentId+(ownExport?'/export-content':'/content')));
   if(result.sha256!==item.sha256||result.bytes.length!==item.size)throw new Error('文件与当前显示的附件不一致。');return result.bytes;}
 });
}
