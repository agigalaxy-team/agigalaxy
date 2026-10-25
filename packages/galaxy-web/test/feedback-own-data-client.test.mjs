import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createOfficialAccountClient} from '../src/official-account-client.mjs';
import {createFeedbackOwnDataClient} from '../src/features/feedback/own-data-client.mjs';

test('own feedback export uses the exact current account transport, bounded pages and a readable ZIP without operator material',async t=>{
 const accountId=randomUUID(),operationId=randomUUID(),feedbackId=randomUUID(),fileId=randomUUID(),otherId=randomUUID(),now=2000000000,bytes=Buffer.from('Only the selected owner attachment.'),requests=[],at=new Date(now*1000).toISOString(),
  session={state:'signed-in',account:{id:accountId},csrfToken:'synthetic-csrf',expiresAt:now+600},contentPath='/v1/account/data/feedback/exports/'+operationId+'/attachments/'+fileId+'/content',
  recorded={state:'recorded',operationId,kind:'export',phase:'ready',scope:'own-submitted-feedback-at-selection',feedbackCount:2,attachmentCount:1,metadataDeleted:false,attachments:{pending:0,removed:0,resultUnknown:0,objectRemoved:null,physicalBlocksReleased:null},recordedAt:at,updatedAt:at,replayed:false,checkedAt:now,readExpiresAt:now+30},
  records=[{id:feedbackId,state:'available',submittedAt:at,title:'本人反馈',body:'导出自己的说明',category:'problem',module:'other',attachments:[{id:fileId,name:'../本人材料.txt',mediaType:'text/plain',byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),state:'available',availability:'available',expiresAt:new Date((now+3600)*1000).toISOString(),contentPath}],note:'MUST_NOT_EXPORT_OPERATOR_NOTE'},
   {id:randomUUID(),state:'available',submittedAt:at,title:'另一条',body:'第二页内容',category:'suggestion',module:'other',attachments:[]}];
 const transport=createOfficialAccountClient({endpoint:'https://api.example.org',website:'https://website.example.org',now:()=>now,fetch:async(url,options)=>{
  const parsed=new URL(url);requests.push({path:parsed.pathname,query:parsed.search,method:options.method,headers:options.headers,body:options.body});
  assert.equal(options.headers['X-Galaxy-Account-ID'],accountId);assert.equal(options.headers['X-Galaxy-Account-CSRF'],'synthetic-csrf');
  if(parsed.pathname===contentPath)return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
  if(parsed.pathname.endsWith('/operations/'+operationId))return Response.json({state:'not-recorded',operationId,checkedAt:now,readExpiresAt:now+30});
  if(parsed.pathname.endsWith('/exports/'+operationId)){const second=parsed.searchParams.has('after');return Response.json({operationId,accountId,scope:'own-submitted-feedback-at-selection',items:[records[second?1:0]],nextAfter:second?null:'1',selectedAt:at,checkedAt:now,readExpiresAt:now+30});}
  return Response.json(recorded);
 }});
 let active=true;const client=createFeedbackOwnDataClient({accountId,now:()=>now,assertCurrent:()=>{if(!active)throw Object.assign(Error('changed'),{code:'official_account_changed'});},
  call:(path,input,options)=>transport.call(path,input,{...options,session}),transfer:(path,input,options)=>transport.transfer(path,input,{...options,session})});
 assert.equal((await client.lookup({operationId})).state,'not-recorded');assert.equal((await client.start({operationId,kind:'export'})).phase,'ready');
 const bundle=await client.exportBundle(operationId);assert.equal(bundle.records,2);assert.equal(bundle.attachments,1);assert.equal(bundle.unavailableAttachments,0);
 const dir=await mkdtemp(join(tmpdir(),'galaxy-feedback-export-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'feedback.zip');await writeFile(file,Buffer.from(await bundle.blob.arrayBuffer()));
 const result=JSON.parse(execFileSync('python',['-c',"import sys,json,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; data=json.loads(z.read('feedback.json')); p=data['records'][0]['attachments'][0]['archivePath']; print(json.dumps({'records':len(data['records']),'names':z.namelist(),'body':z.read(p).decode(),'serialized':json.dumps(data,ensure_ascii=False)},ensure_ascii=False))",file],{encoding:'utf8'}));
 assert.equal(result.records,2);assert.equal(result.body,bytes.toString());assert(result.names.every(name=>!name.startsWith('/')&&!name.split('/').includes('..')));assert(!result.serialized.includes('MUST_NOT_EXPORT_OPERATOR_NOTE'));assert(!result.serialized.includes('/v1/account/'));
 const before=requests.length;await assert.rejects(transport.call('/v1/account/data/feedback/exports/'+operationId+'?after=1&after=2',null,{method:'GET',session}),{code:'official_account_request_invalid'});
 await assert.rejects(transport.call('/v1/account/data/feedback/exports/'+operationId+'?limit=51',null,{method:'GET',session}),{code:'official_account_request_invalid'});
 await assert.rejects(transport.call('/v1/account/data/feedback/operations/'+operationId,{},{method:'POST',session}),{code:'official_account_request_invalid'});
 await assert.rejects(transport.transfer(contentPath+'?other='+otherId,{},{session}),{code:'official_account_request_invalid'});assert.equal(requests.length,before);
 active=false;await assert.rejects(client.lookup({operationId}),{code:'official_account_changed'});assert.equal(requests.length,before);
 assert.equal(requests.filter(value=>value.path.endsWith('/export')).length,1);assert.deepEqual(JSON.parse(requests.find(value=>value.path.endsWith('/export')).body),{operationId});
});
