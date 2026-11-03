import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';

const digest=value=>createHash('sha256').update(value).digest('hex');

// Checkpoints contain only opaque source identity, byte offsets and hashes.
async function dataRoot(options) {
 if(options.configPath) {
  const config=JSON.parse(await readFile(options.configPath,'utf8'));
  if(typeof config.dataDirectory!=='string'||!isAbsolute(config.dataDirectory))throw Error('archive_data_directory_unavailable');
  return config.dataDirectory;
 }
 return resolve(options.dataDirectory||process.env.GALAXY_DATA_DIR||join(homedir(),'.galaxy'));
}
async function firstLine(path) {
 let chunks=[],size=0;
 for await(const chunk of createReadStream(path,{start:0,highWaterMark:65536})) {
  const end=chunk.indexOf(10);const part=end<0?chunk:chunk.subarray(0,end);size+=part.length;
  if(size>1024*1024)throw Error('archive_header_invalid');
  chunks.push(part);if(end>=0)return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 throw Error('archive_header_incomplete');
}
function messageRecord(host,record,sessionId) {
 if(host==='codex')return record?.type==='response_item'&&record.payload!==null&&typeof record.payload==='object'&&!Array.isArray(record.payload)&&typeof record.payload.type==='string';
 return record?.sessionId===sessionId&&(record.type==='user'||record.type==='assistant')&&record.message&&typeof record.message==='object';
}
export async function captureTranscript({host,sessionId,transcriptPath,galaxyId,options,capture,acquire,release}) {
 if(!['codex','claude-code'].includes(host)||typeof transcriptPath!=='string'||!isAbsolute(transcriptPath))return;
 const key=digest(JSON.stringify([galaxyId,host,sessionId,transcriptPath]));
 if(!(await acquire({galaxyId,key}))?.acquired)return;
 try {
  const root=join(await dataRoot(options),'host-transcript-cursors');
  await mkdir(root,{recursive:true});
  const info=await stat(transcriptPath);if(!info.isFile())return;
  if(host==='codex') {
   const header=await firstLine(transcriptPath);
   if(header?.type!=='session_meta'||header.payload?.id!==sessionId)return;
  }
  const generation=JSON.stringify([info.dev,info.ino,info.birthtimeMs]);
  const checkpoint=join(root,key+'.json');let state;
  try {state=JSON.parse(await readFile(checkpoint,'utf8'));}catch(error){if(error?.code!=='ENOENT')throw error;}
  let position=state?.generation===generation&&Number.isSafeInteger(state.offset)&&state.offset>=0&&state.offset<=info.size?state.offset:0;
  if(position&&Number.isSafeInteger(state.lineStart)&&typeof state.lineHash==='string') {
   const handle=await open(transcriptPath,'r');
   try {const length=position-state.lineStart;if(length<=0||length>9*1024*1024)position=0;else {const bytes=Buffer.alloc(length);const result=await handle.read(bytes,0,length,state.lineStart);if(result.bytesRead!==length||digest(bytes)!==state.lineHash)position=0;}}finally{await handle.close();}
  }
  const started=Date.now();let pending=Buffer.alloc(0),lineStart=position;
  for await(const chunk of createReadStream(transcriptPath,{start:position,end:Math.max(position,info.size-1),highWaterMark:65536})) {
   pending=Buffer.concat([pending,chunk]);let end;
   while((end=pending.indexOf(10))>=0) {
    const line=pending.subarray(0,end+1),raw=line.subarray(0,end);pending=pending.subarray(end+1);
    let record;try {record=JSON.parse(raw.toString('utf8'));}catch{return;}
    if(host==='claude-code'&&record.sessionId&&record.sessionId!==sessionId)return;
    if(messageRecord(host,record,sessionId)) {
     const messageId='transcript-record:'+digest(JSON.stringify([host,sessionId,generation,lineStart,digest(raw)]));
     const result=await capture({galaxyId,host,sessionId,messageId,message:record,parts:[]});
     if(!result?.captured&&result?.reason!=='outside-selected-retention')return;
    }
    position=lineStart+line.length;
    const next={generation,offset:position,lineStart,lineHash:digest(line)};
    const tmp=checkpoint+'.'+randomUUID()+'.tmp';
    await writeFile(tmp,JSON.stringify(next),{mode:0o600});
    try {await rename(tmp,checkpoint);}catch(error){await rm(tmp,{force:true});throw error;}
    lineStart=position;
    if(Date.now()-started>=1000)return;
   }
   if(pending.length>9*1024*1024)return;
  }
 } finally {await release({galaxyId,key});}
}
