import {attachmentPrepareSchema} from '../../galaxy-official/src/shared/chat-attachments-schema.mjs';
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const operations=new WeakMap();
const storedStates=new Set(['scan-pending','scanning','available','blocked','erased','revoked','expired']);
export function createAttachmentsClient({api,getLocal,putLocal}){
 const path='/v2/chat/attachments/',key=roomId=>'chat-attachment-operation:'+roomId;
 const subjectId=api.snapshot()?.subjectId,endpoint=api.endpoint;
 const owner=()=>{if(!subjectId||api.snapshot()?.subjectId!==subjectId||api.endpoint!==endpoint)throw new Error('身份或连接已改变，请重新打开原房间。');};
 const guard=async fn=>{owner();const result=await fn();owner();return result;};
 const load=roomId=>guard(()=>getLocal(key(roomId)));
 const save=(roomId,value)=>guard(()=>putLocal(key(roomId),value));
 const call=(name,input)=>guard(()=>api.call(path+name,input));
 const serial=async(roomId,fn)=>{owner();let locks=operations.get(api);if(!locks){locks=new Set();operations.set(api,locks);}if(locks.has(roomId))throw new Error('本房间已有附件操作正在处理。');locks.add(roomId);try{return await fn();}finally{locks.delete(roomId);}};
 const validRecord=(record,roomId)=>{owner();if(record&&(record.subjectId!==subjectId||record.input.roomId!==roomId))throw new Error('请先连接原来选择文件的身份。');return record;};
 async function receipt(record,value){
  if(value.attachmentId!==record.input.attachmentId||value.roomId!==record.input.roomId||value.sha256!==record.input.sha256||value.size!==record.input.size)throw new Error('附件回执不匹配，请保留原操作。');
  if(storedStates.has(value.state))await save(record.input.roomId,null);
  return value;
 }
 async function upload(record,file,{signal,onStage=()=>{}}={}){
  validRecord(record,record.input.roomId);signal?.throwIfAborted();
  const bytes=new Uint8Array(await guard(()=>file.arrayBuffer()));
  if(bytes.length!==record.input.size||await sha(bytes)!==record.input.sha256)throw new Error('所选文件与原操作不一致。');
  signal?.throwIfAborted();onStage('确认上传记录');const prepared=await receipt(record,await call('prepare',record.input));
  if(storedStates.has(prepared.state))return prepared;
  signal?.throwIfAborted();onStage('正在上传');const result=await receipt(record,await guard(()=>api.attachmentTransfer(path+record.input.attachmentId+'/upload',{bytes,signal})));
  onStage('等待扫描');return result;
 }
 return Object.freeze({
  config:()=>call('config',{}),query:(roomId,after)=>call('query',{roomId,...(after?{after}:{})}),
  pending:async roomId=>validRecord(await load(roomId),roomId),
  reconcile:roomId=>serial(roomId,async()=>{const record=validRecord(await load(roomId),roomId);if(!record)return {state:'none'};return receipt(record,await call('read',{attachmentId:record.input.attachmentId}));}),
  /** @param {string} roomId @param {File} file @param {{confirmed?:boolean,signal?:AbortSignal,onStage?:(stage:string)=>void}} [options] */
  async send(roomId,file,{confirmed=false,...options}={}){return serial(roomId,async()=>{
   if(!confirmed||!api.snapshot())throw new Error('请确认将所选文件上传为房间临时附件。');
   if(await load(roomId))throw new Error('请先恢复或撤销上一次上传。');
   const limits=await call('config',{});if(!limits.supported)throw new Error('附件服务目前不可用。');
   if(!file.size||file.size>limits.maxFileBytes)throw new Error('文件为空或超出本房间的单文件限额。');
   options.signal?.throwIfAborted();const bytes=new Uint8Array(await guard(()=>file.arrayBuffer())),input=attachmentPrepareSchema.parse({attachmentId:crypto.randomUUID(),roomId,name:file.name,
    mediaType:(file.type||'application/octet-stream').toLowerCase(),size:bytes.length,sha256:await sha(bytes),purpose:'temporary-room-attachment',confirmed:true});
   options.signal?.throwIfAborted();const record={subjectId,input};await save(roomId,record);
   return upload(record,file,options);
  });},
  async retry(roomId,file,options={}){return serial(roomId,async()=>{if(!options.confirmed)throw new Error('请确认恢复原文件上传。');const record=validRecord(await load(roomId),roomId);if(!record)throw new Error('没有待恢复上传。');return upload(record,file,options);});},
  async revoke(roomId,attachmentId){return serial(roomId,async()=>{const result=await call('revoke',{attachmentId});const record=await load(roomId);if(record?.input.attachmentId===attachmentId)await save(roomId,null);return result;});},
  async abandon(roomId){return serial(roomId,async()=>{const record=validRecord(await load(roomId),roomId);if(record){try{await call('revoke',{attachmentId:record.input.attachmentId});}
   catch(error){if(error.code!=='attachment_unavailable')throw error;owner();}await save(roomId,null);}});},
  read:attachmentId=>call('read',{attachmentId}),
  async download(item,{ownExport=false}={}){const result=await guard(()=>api.attachmentTransfer(path+item.attachmentId+(ownExport?'/export-content':'/content')));
   if(result.sha256!==item.sha256||result.bytes.length!==item.size)throw new Error('文件与当前显示的附件不一致。');return result.bytes;}
 });
}
