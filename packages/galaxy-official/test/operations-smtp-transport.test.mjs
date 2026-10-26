import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {createOperationsSmtpTransport} from '../src/operations-smtp-transport.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

async function smtpFixture(t){
 const sockets=new Set(),messages=[],commands=[],control={rejectSender:false,dropAfterData:false,revokeAtRecipient:false,revoked:false};
 const server=createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});let buffer='',data=false;
  socket.write('220 localhost synthetic SMTP\r\n');
  socket.on('data',chunk=>{
   buffer+=chunk.toString('utf8');
   while(true){
    if(data){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;messages.push(buffer.slice(0,end));buffer=buffer.slice(end+5);data=false;if(control.dropAfterData){socket.destroy();return;}socket.write('250 synthetic submitted\r\n');continue;}
    const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);const name=line.split(' ',1)[0].toUpperCase();commands.push(name);
    if(name==='EHLO'||name==='HELO')socket.write('250-localhost\r\n250-PIPELINING\r\n250 AUTH PLAIN\r\n');
    else if(name==='AUTH')socket.write('235 synthetic authenticated\r\n');
    else if(name==='MAIL')socket.write(control.rejectSender?'550 sender rejected\r\n':'250 sender accepted\r\n');
    else if(name==='RCPT'){if(control.revokeAtRecipient)control.revoked=true;socket.write('250 recipient accepted\r\n');}
    else if(name==='DATA'){data=true;socket.write('354 continue\r\n');}
    else if(name==='QUIT'){socket.end('221 bye\r\n');return;}
    else if(name==='RSET'||name==='NOOP')socket.write('250 okay\r\n');
    else socket.write('500 unsupported\r\n');
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 return {commands,messages,control,configuration:{host:'127.0.0.1',port:server.address().port,tls:'starttls',connectionTimeoutMs:1000,greetingTimeoutMs:1000,socketTimeoutMs:1000},credentials:{user:'synthetic-user',pass:'synthetic-password'}};
}

test('pinned SMTP transport distinguishes connection, confirmed submission, pre-DATA refusal and an uncertain post-DATA result',{timeout:15000},async t=>{
 const f=await smtpFixture(t),transport=createOperationsSmtpTransport({allowLoopbackPlaintext:true});
 const authorized=async()=>{if(f.control.revoked)throw new ServiceError('operations_permission_denied',403);};
 const input=()=>({credentials:f.credentials,authorize:authorized,to:'synthetic@example.invalid',senderKey:'notice',subject:'合成消息',title:'合成通知',paragraphs:['LOCAL_SYNTHETIC_BODY'],messageId:'<'+randomUUID()+'@messages.agigalaxy.org>'});
 assert.equal((await transport.verify(f.configuration,{credentials:f.credentials,authorize:authorized})).submission,'connected');assert.equal(f.commands.filter(x=>x==='DATA').length,0);
 const first=input();assert.deepEqual(await transport.submit(f.configuration,first),{submission:'submitted',code:null,retryable:false});assert.equal(f.messages.length,1);
 assert.match(f.messages[0],/notice@agigalaxy\.org/);assert.match(f.messages[0],/Reply-To:.*team@agigalaxy\.org/);assert(f.messages[0].includes(first.messageId));
 assert.match(f.messages[0],/multipart\/alternative/);assert.match(f.messages[0],/Auto-Submitted: auto-generated/);assert.match(f.messages[0],/agigalaxy\.org/);
 f.control.revokeAtRecipient=true;const denied=await transport.submit(f.configuration,input());assert.deepEqual(denied,{submission:'failed',code:'operations_permission_denied',retryable:true});assert.equal(f.messages.length,1);assert.equal(f.commands.filter(x=>x==='DATA').length,1,'PIPELINING must still wait for current authorization before DATA');
 f.control.revokeAtRecipient=false;f.control.revoked=false;f.control.rejectSender=true;
 assert.deepEqual(await transport.submit(f.configuration,input()),{submission:'failed',code:'smtp_permanent_rejection',retryable:false});assert.equal(f.messages.length,1);
 f.control.rejectSender=false;f.control.dropAfterData=true;
 assert.deepEqual(await transport.submit(f.configuration,input()),{submission:'unknown',code:'smtp_submission_unknown',retryable:false});assert.equal(f.messages.length,2,'there is one SMTP attempt and no library resend after lost final acknowledgement');
});
