import assert from 'node:assert/strict';
import test from 'node:test';
import {smtpConfiguration,smtpDraft,smtpMerge,smtpMergeValue} from '../src/lib/smtp-view-model.ts';

test('SMTP merges independent changes, requires actual conflict choices and keeps approved connection bindings intact without interpreting missing or masked credentials',()=>{
 const credentials=[{ref:'approved-a',label:'已批准连接甲',host:'relay-a.invalid',port:587,tls:'starttls',available:true,purposes:['notice']},{ref:'approved-b',label:'已批准连接乙',host:'relay-b.invalid',port:465,tls:'implicit',available:true,purposes:['notice']}];
 const base=smtpDraft({enabled:false,host:'relay-a.invalid',port:587,tls:'starttls',credentialRef:'approved-a',connectionTimeoutMs:1000,greetingTimeoutMs:2000,socketTimeoutMs:3000,maxConnections:2,rateLimit:8,rateWindowSeconds:60,dkimSelector:null});
 const mine={...base,connectionTimeoutMs:'1400',rateLimit:'9'},current={...base,socketTimeoutMs:'5000',rateLimit:'12'};
 const first=smtpMerge(base,mine,current,{},credentials);assert.equal(first.unresolved,1);assert.deepEqual(first.conflicts.map(row=>row.key),['rateLimit']);
 const chosen=smtpMerge(base,mine,current,{rateLimit:'mine'},credentials);assert.equal(chosen.unresolved,0);assert.equal(chosen.draft.connectionTimeoutMs,'1400');assert.equal(chosen.draft.socketTimeoutMs,'5000');assert.equal(chosen.draft.rateLimit,'9');assert.equal(chosen.draft.enabled,false);
 assert.deepEqual(smtpConfiguration(chosen.draft).value,{enabled:false,host:'relay-a.invalid',port:587,tls:'starttls',credentialRef:'approved-a',connectionTimeoutMs:1400,greetingTimeoutMs:2000,socketTimeoutMs:5000,maxConnections:2,rateLimit:9,rateWindowSeconds:60,dkimSelector:null});
 const localConnection={...base,host:'relay-b.invalid',port:'465',tls:'implicit',credentialRef:'approved-b'},remoteConnection={...base,port:'2525'};
 const connection=smtpMerge(base,localConnection,remoteConnection,{connection:'mine'},credentials);assert.deepEqual(connection.conflicts.map(row=>row.key),['connection']);assert.deepEqual([connection.draft.host,connection.draft.port,connection.draft.tls,connection.draft.credentialRef],['relay-b.invalid','465','implicit','approved-b']);
 const label=smtpMergeValue(connection.conflicts[0].mine,credentials);assert.ok(label.includes('已批准连接乙'));assert.ok(!label.includes('approved-b'));
 for(const credentialRef of [undefined,'********','unknown-reference'])assert.equal(smtpMerge(base,mine,{...current,credentialRef},{},credentials).draft,null);
 assert.equal(smtpMerge(base,{...base,port:'0587',host:'RELAY-A.INVALID'},current,{},credentials).unresolved,0);
 assert.equal(base.rateLimit,'8');assert.equal(mine.rateLimit,'9');assert.equal(current.rateLimit,'12');
});
