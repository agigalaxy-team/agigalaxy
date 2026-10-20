const nativeFormat='galaxy-private-conversation-v1';
const nativeArchive=value=>!!value&&typeof value==='object'&&(value.format===undefined||value.format===nativeFormat)&&!!value.session&&Array.isArray(value.messages);
function archiveDescription(content){
 if(!nativeArchive(content))return {format:'selected-session',coverage:null,completeConversation:null,messageCount:null,excludedItems:0,hasMore:false,hasEarlier:false};
 return {format:nativeFormat,coverage:content.coverage??null,completeConversation:content.completeConversation===true,messageCount:content.messages.length,
  excludedItems:content.messages.reduce((sum,message)=>sum+(Array.isArray(message.exclusions)?message.exclusions.length:0),0),hasMore:content.nextAfter!==null&&content.nextAfter!==undefined||content.selectedCoverage?.hasLater===true,hasEarlier:content.selectedCoverage?.hasEarlier===true};
}
export function readConversationArchiveFile(text){
 if(typeof text!=='string'||new TextEncoder().encode(text).length>67108864)throw Error('会话文件超过 64 MiB，请减少所选会话或使用分段导出。');
 let value;try{value=JSON.parse(text);}catch{throw Error('文件不是可读取的 JSON，会话没有上传。');}
 if(nativeArchive(value)){
  const session=value.session;
  if(!value.messages.every(message=>message&&typeof message==='object'&&Number.isSafeInteger(message.sequence)&&message.sequence>=0&&Array.isArray(message.exclusions)))throw Error('本机会话导出的消息与排除项记录不完整，没有上传。');
  if(typeof value.galaxyId!=='string'||!/^GUID[0-9A-Z]{28}$/.test(value.galaxyId)||typeof session.archiveSessionId!=='string'||!session.archiveSessionId.trim()||session.archiveSessionId.length>200||typeof session.host!=='string'||typeof session.sessionId!=='string'||session.workspaceId!==null&&session.workspaceId!==undefined&&(typeof session.workspaceId!=='string'||!session.workspaceId.trim()||session.workspaceId.length>200))throw Error('本机会话导出的身份或来源记录不完整，没有上传。');
  return {workspaceId:session.workspaceId??null,sessions:[{sessionId:session.archiveSessionId,title:typeof session.title==='string'?session.title.slice(0,200):session.host+' · '+session.sessionId,content:value,...archiveDescription(value)}]};
 }
 if(!value||(value.workspaceId!==null&&(typeof value.workspaceId!=='string'||!value.workspaceId.trim()||value.workspaceId.length>200))||!Array.isArray(value.sessions)||!value.sessions.length||value.sessions.length>200)throw Error('请选择银河本机会话导出，或包含 workspaceId 与 sessions 数组的会话集合。');
 const seen=new Set();
 const sessions=value.sessions.map(item=>{
  if(!item||typeof item.sessionId!=='string'||!item.sessionId.trim()||item.sessionId.length>200||seen.has(item.sessionId)||!Object.hasOwn(item,'content'))throw Error('会话编号缺失或重复，文件没有上传。');
  seen.add(item.sessionId);return{sessionId:item.sessionId,title:typeof item.title==='string'?item.title.slice(0,200):item.sessionId,content:item.content,...archiveDescription(item.content)};
 });
 return {workspaceId:value.workspaceId,sessions};
}
export function conversationArchiveParts(file,sessionIds){
 const wanted=new Set(sessionIds),sessions=file.sessions.filter(item=>wanted.has(item.sessionId));
 if(!sessions.length||sessions.length!==wanted.size)throw Error('请先选择此文件中需要归档的会话。');
 const text=JSON.stringify({workspaceId:file.workspaceId,sessions}),bytes=new TextEncoder().encode(text),decoder=new TextDecoder(),parts=[];
 if(bytes.length>67108864)throw Error('所选会话超过 64 MiB，请减少保存范围。');
 for(let offset=0;offset<bytes.length;offset+=249856)parts.push(decoder.decode(bytes.slice(offset,offset+249856),{stream:offset+249856<bytes.length}));
 return parts;
}
export async function exportConversationArchive(call,id,{signal}={}){
 const parts=[],seen=new Set();let sequence=0,archive=null;
 while(sequence!==null){
   signal?.throwIfAborted();
   if(!Number.isSafeInteger(sequence)||sequence<0||seen.has(sequence))throw Error('会话导出的分页位置无效，请重新导出。');seen.add(sequence);
   const result=await call('/v1/account/archives/export',{id,sequence});
   signal?.throwIfAborted();
  if(typeof result.content!=='string'||result.archive?.id!==id)throw Error('会话导出内容与当前选择不一致。');
  archive=result.archive;parts.push(result.content);sequence=result.nextSequence;
 }
 return {archive,content:parts.join('')};
}

const readableText=value=>{
 if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(readableText).filter(Boolean).join('\n');
 if(!value||typeof value!=='object')return '';
 if(typeof value.text==='string')return value.text;
 if(typeof value.content==='string'||Array.isArray(value.content))return readableText(value.content);
 return '';
};
/** Read saved conversation content without exposing its transport envelope. */
export function conversationArchiveReading(text){
 const file=readConversationArchiveFile(text);
 return file.sessions.map(session=>{
  const content=session.content,native=nativeArchive(content);
  const messages=native?content.messages:Array.isArray(content?.messages)?content.messages:[];
  const entries=messages.map((row,index)=>{
   const message=row?.message??row,parts=Array.isArray(row?.parts)?row.parts:[];
   const role=typeof message?.role==='string'?message.role:typeof row?.role==='string'?row.role:'message';
   const body=readableText(parts)||readableText(message)||readableText(row?.content);
   return {id:String(row?.messageId??row?.id??index),role,text:body,at:row?.capturedAt??message?.createdAt??null,excludedItems:Array.isArray(row?.exclusions)?row.exclusions.length:0};
  });
  if(!entries.length){const body=readableText(content);if(body)entries.push({id:'content',role:'message',text:body,at:null,excludedItems:0});}
  return {sessionId:session.sessionId,title:session.title,coverage:session.coverage,completeConversation:session.completeConversation,excludedItems:session.excludedItems,hasMore:session.hasMore,hasEarlier:session.hasEarlier,entries};
 });
}
