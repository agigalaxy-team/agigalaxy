import {createConnection} from 'node:net';
import {once} from 'node:events';
import {ServiceError} from '../../../galaxy-contracts/src/service-error.mjs';
export class AttachmentClamAV {
 constructor({host='127.0.0.1',port=3310,timeoutMs=60000,maxBytes=10485760,maxSignatureAgeSeconds=259200,now=()=>Math.floor(Date.now()/1000)}){
  if(!['localhost','127.0.0.1','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw new Error('ClamAV must use a loopback socket');
  Object.assign(this,{host,port,timeoutMs,maxBytes,maxSignatureAgeSeconds,now});
 }
 async command(command,bytes){
  const socket=createConnection({host:this.host,port:this.port});const parts=[];let size=0;
  const answer=new Promise((resolve,reject)=>{
   socket.on('data',chunk=>{size+=chunk.length;if(size>4096){socket.destroy();reject(new Error());return;}parts.push(chunk);if(chunk.includes(0)){resolve(Buffer.concat(parts).toString('utf8').split('\0')[0]);socket.end();}});
   socket.on('error',reject);socket.on('end',()=>{if(!parts.length||!Buffer.concat(parts).includes(0))reject(new Error());});
  });answer.catch(()=>{});
  const timeout=setTimeout(()=>socket.destroy(new Error('deadline')),this.timeoutMs);
  try{
   await once(socket,'connect');socket.write(Buffer.from('z'+command+'\0'));
   if(bytes){for(let start=0;start<bytes.length;start+=65536){const chunk=bytes.subarray(start,start+65536),header=Buffer.alloc(4);header.writeUInt32BE(chunk.length);if(!socket.write(Buffer.concat([header,chunk])))await once(socket,'drain');}socket.write(Buffer.alloc(4));}
   return await answer;
  }catch{throw new ServiceError('attachment_scanner_unavailable',503);}finally{clearTimeout(timeout);socket.destroy();}
 }
 async scan(bytes){
  if(bytes.length>this.maxBytes)throw new ServiceError('attachment_too_large',413);
  const version=await this.command('VERSION'),matched=/^ClamAV ([0-9.]+)\/([0-9]+)\/(.+)$/.exec(version);
  if(!matched)throw new ServiceError('attachment_scanner_version_unavailable',503);
  const signatureTime=Date.parse(matched[3]+' UTC')/1000;
  if(!Number.isFinite(signatureTime)||signatureTime>this.now()+300||signatureTime<this.now()-this.maxSignatureAgeSeconds)throw new ServiceError('attachment_scanner_signatures_stale',503);
  const response=await this.command('INSTREAM',bytes),result={engine:'ClamAV',engineVersion:matched[1],databaseVersion:matched[2],databaseUpdatedAt:signatureTime,checkedAt:this.now(),scope:'configured-signatures-and-scan-limits',guaranteedSafe:false};
  if(response==='stream: OK')return {...result,state:'clean'};
  if(/^stream: .{1,200} FOUND$/.test(response))return {...result,state:'blocked',reason:'scanner-detection'};
  throw new ServiceError('attachment_scan_incomplete',503);
 }
}
