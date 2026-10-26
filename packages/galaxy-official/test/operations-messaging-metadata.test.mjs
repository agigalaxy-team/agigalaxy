import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {failureRoute} from '../src/adapters/http/failure-audit.mjs';
import {businessAuditMetadata} from "../src/operations/audit/view.mjs";
import {dispatchOperationsMessaging} from '../src/adapters/http/operations-messaging-http.mjs';
import {messagingCreateSchema,messagingParse} from '../src/shared/operations-messaging-schema.mjs';

test('new messaging and SMTP diagnostic routes and general audit stay closed metadata',()=>{
 const id=randomUUID();
 for(const [path,expected]of [
  ['/v1/operations/messaging/plans/'+id+'/activate','/v1/operations/messaging/plans/:id/activate'],
  ['/v1/operations/messaging/plans/'+id+'/history','/v1/operations/messaging/plans/:id/history'],
  ['/v1/operations/messaging/runs/'+id+'/recipients','/v1/operations/messaging/runs/:id/recipients'],
  ['/v1/operations/jobs/messaging-delivery/'+id+'/retry','/v1/operations/jobs/messaging-delivery/:id/retry'],
  ['/v1/announcements/'+id,'/v1/announcements/:id'],
  ['/v1/operations/smtp/tests/delivery','/v1/operations/smtp/tests/delivery'],
 ]){assert.equal(failureRoute('POST',path),'POST '+expected);assert.equal(failureRoute('POST',expected),'POST '+expected);}
 assert.equal(failureRoute('GET','/v1/operations/smtp/PRIVATE_EMAIL@example.invalid'),'http.request');
 const base={id,sequence:1,operator_id:'synthetic-reader',operator_role:'reader',action:'smtp-config-save',created_at:new Date(),
  selection:{expectedVersion:1,changedFields:['host','credentialRef'],host:'PRIVATE_SMTP_HOST',password:'PRIVATE_PASSWORD',credentialRef:'PRIVATE_REF'},result:{version:2,enabled:false,body:'PRIVATE_BODY'}};
 const settings=businessAuditMetadata(base);assert.deepEqual(settings.selection,{expectedVersion:1,changedFields:['host','credentialRef']});assert.deepEqual(settings.result,{version:2,enabled:false});
 const delivery=businessAuditMetadata({...base,action:'notice-delivery',selection:{kind:'email-submission',planId:id,recipientId:id,channel:'email',to:'PRIVATE_EMAIL@example.invalid',body:'PRIVATE_BODY'},result:{submission:'unknown',retryable:false,errorCode:'smtp_submission_unknown',response:'PRIVATE_SMTP_RESPONSE'}});
 assert.equal(delivery.result.submission,'unknown');assert.equal(delivery.result.retryable,false);assert.equal(delivery.result.errorCode,'smtp_submission_unknown');
 const unknown=businessAuditMetadata({...base,action:'smtp-delivery-test',selection:{testId:id,expectedVersion:2},result:{state:'PRIVATE_STATE',code:'PRIVATE_CODE',version:2}});
 assert.deepEqual(unknown.result,{version:2});assert(!JSON.stringify([settings,delivery,unknown]).includes('PRIVATE_'));
});

test('messaging body admits the declared 500-account and 8000-character envelope while still bounding request bytes',async()=>{
 const input={operationId:randomUUID(),config:{channels:['inapp','email'],content:{purpose:'service-update',title:'合成消息',body:'测'.repeat(8000),href:null,expiresAt:'2033-06-01T00:00:00.000Z'},
  audience:{kind:'accounts',accountIds:Array.from({length:500},()=>randomUUID())},senderKey:'notice',schedule:{kind:'immediate'}}};
 const bytes=Buffer.from(JSON.stringify(input));assert(bytes.length>32768);assert(bytes.length<=65536);
 const actor={kind:'business-operator',operatorId:'synthetic-operator',role:'reader',endpoint:'https://example.invalid'};
 const requestFor=buffer=>Object.assign(Readable.from([buffer]),{method:'POST',headers:{'content-type':'application/json'}});let returned;
 const options={operationsMessaging:{create:async(_operator,value)=>messagingParse(messagingCreateSchema,value)},authorizeOperator:async()=>actor,requestId:randomUUID(),url:new URL('https://example.invalid/v1/operations/messaging/plans'),send:(_status,value)=>{returned=value;}};
 assert.equal(await dispatchOperationsMessaging({...options,request:requestFor(bytes)}),true);assert.equal(returned.config.audience.accountIds.length,500);assert.equal(returned.config.content.body.length,8000);
 await assert.rejects(dispatchOperationsMessaging({...options,request:requestFor(Buffer.from(JSON.stringify({...input,padding:'x'.repeat(70000)})))}),{code:'request_too_large',status:413});
});
