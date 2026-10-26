import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfficialAccountClient} from "../src/features/accounts/official-account-client.mjs";
import {createFeedbackAttachmentsClient,feedbackDraftAttachmentsSchema} from '../src/features/feedback/attachments-client.mjs';

const endpoint='https://official.example.org',website='https://galaxy.example.org',now=()=>2000000000;
const session={state:'signed-in',account:{id:randomUUID()},csrfToken:'synthetic-feedback-csrf',expiresAt:now()+3600};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const limits={supported:true,maxFileBytes:10485760,maxFilesPerFeedback:4,draftRetentionDays:7,submittedRetentionDays:30,publicStorageUrls:false,automaticPhysicalCleanup:false};

test('feedback attachment transport whitelists only explicit metadata POST and upload PUT with current account/CSRF',async()=>{
 const calls=[],client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{calls.push({url,options});return response(limits);}}),id=randomUUID(),prefix='/v1/account/feedback/attachments/';
 for(const name of ['config','prepare','read','revoke'])await client.call(prefix+name,{}, {session});
 const bytes=new Uint8Array([1,2,3]);await client.transfer(prefix+id+'/upload',bytes,{method:'PUT',session});
 for(const call of calls){assert.equal(call.options.credentials,'include');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers['X-Galaxy-Account-ID'],session.account.id);assert.equal(call.options.headers['X-Galaxy-Account-CSRF'],session.csrfToken);assert.equal(call.options.headers.Authorization,undefined);}
 assert.equal(calls[4].options.body,bytes);assert.equal(calls[4].options.headers['Content-Type'],'application/octet-stream');
 for(const [path,method] of [[prefix+'query','POST'],[prefix+'read','GET'],[prefix+'config?draft=1','POST'],[prefix+'prepare/','POST'],['/v1/account/other/../feedback/attachments/config','POST'],[prefix+'read','DELETE']])await assert.rejects(client.call(path,{}, {session,method}),{code:'official_account_request_invalid'});
 for(const [path,method] of [[prefix+id+'/content','POST'],[prefix+id+'/upload','POST'],[prefix+id+'/upload?operationId='+id,'PUT'],[prefix+'../'+id+'/upload','PUT']])await assert.rejects(client.transfer(path,bytes,{session,method}),{code:'official_account_request_invalid'});
 await assert.rejects(client.transfer(prefix+id+'/upload',bytes,{method:'PUT',session:{...session,state:'signed-out'}}),{code:'official_account_session_expired'});
 assert.equal(calls.length,5);
});

test('feedback file upload recovers a lost acknowledgement using the exact original draft/file without duplicate bytes',async()=>{
 const records=new Map(),calls=[];let lost=true,uploads=0;
 const client=createOfficialAccountClient({endpoint,website,now,fetch:async(url,options)=>{
  const path=new URL(url).pathname;calls.push(path);if(path.endsWith('/config'))return response(limits);
  if(path.endsWith('/upload')){uploads++;const id=path.split('/').at(-2),record=records.get(id);records.set(id,{...record,state:'scan-pending',uploadRetryable:false});if(lost){lost=false;throw new TypeError('synthetic lost acknowledgement');}return response(records.get(id));}
  const input=JSON.parse(options.body);
  if(path.endsWith('/read'))return records.has(input.attachmentId)?response(records.get(input.attachmentId)):response({error:'feedback_attachment_unavailable'},404);
  if(path.endsWith('/prepare')){const record={...input,state:'prepared',expiresAt:new Date((now()+3600)*1000).toISOString(),uploadRetryAt:null,uploadRetryable:true};records.set(input.attachmentId,record);return response(record);}
  throw Error('unexpected path');
 }});
 let current=true;const account={assertCurrent:()=>{if(!current)throw Object.assign(Error('official_account_changed'),{code:'official_account_changed'});},call:(path,input,options)=>client.call(path,input,{...options,session}),transfer:(path,input,options)=>client.transfer(path,input,{...options,session})},files=createFeedbackAttachmentsClient({account}),file=new File(['PRIVATE_LOCAL_FILE_BYTES'],'问题说明.txt',{type:'text/plain'}),operationId=randomUUID(),record=await files.plan(file,operationId,await files.config()),states=[];
 assert.equal(record.operationId,operationId);assert.equal(record.state,'preparing');assert.equal(record.sha256.length,64);
 await assert.rejects(files.upload(record,file,{onState:async value=>states.push(value)}),/synthetic lost acknowledgement/);
 const recovered=await files.upload(record,file);assert.equal(recovered.id,record.id);assert.equal(recovered.state,'scan-pending');assert.equal(uploads,1);
 assert.equal(records.size,1);assert.equal(calls.filter(path=>path.endsWith('/prepare')).length,1);assert.equal(feedbackDraftAttachmentsSchema.parse([recovered])[0].id,record.id);
 assert.deepEqual(states.map(value=>value.state),['prepared','uploading']);
 current=false;const before=calls.length;await assert.rejects(files.read(record),{code:'official_account_changed'});assert.equal(calls.length,before,'account change stops the request before any metadata or bytes leave');
});

test('feedback attachment receipt substitution, changed bytes and unsupported storage never become ready references',async()=>{
 const file=new File(['original'],'note.txt',{type:'text/plain'}),operationId=randomUUID();let input;
 const account={assertCurrent:()=>{},call:async(path,value)=>{input=value;if(path.endsWith('/read'))throw Object.assign(Error('feedback_attachment_unavailable'),{code:'feedback_attachment_unavailable'});
  return {...value,state:'prepared',expiresAt:'2033-05-18T04:33:20.000Z',uploadRetryAt:null,uploadRetryable:true};},transfer:async()=>{throw Error('unexpected bytes');}},files=createFeedbackAttachmentsClient({account});
 await assert.rejects(files.plan(file,operationId,{...limits,supported:false}),{code:'attachment_service_unavailable'});
 const record=await files.plan(file,operationId,limits);
 await assert.rejects(files.upload(record,new File(['different'],'note.txt',{type:'text/plain'})),{code:'attachment_file_changed'});assert.equal(input.operationId,operationId);
 const malicious=createFeedbackAttachmentsClient({account:{...account,call:async()=>({...record,attachmentId:randomUUID(),state:'available',expiresAt:'2033-05-18T04:33:20.000Z',uploadRetryAt:null,uploadRetryable:false})}});
 await assert.rejects(malicious.read(record),{code:'attachment_receipt_mismatch'});
 assert.equal(feedbackDraftAttachmentsSchema.safeParse([record,record]).success,false);
});
