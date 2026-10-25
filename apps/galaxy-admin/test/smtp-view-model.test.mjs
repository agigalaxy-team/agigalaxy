import assert from 'node:assert/strict';
import test from 'node:test';
import {selectSmtpCredential,smtpCode,smtpConfiguration,smtpConfigurationChanged,smtpDraft,smtpHref,smtpLocation,smtpPageChange,smtpPageQuery,smtpState} from '../src/lib/smtp-view-model.ts';

const empty={enabled:false,host:null,port:null,tls:null,credentialRef:null,connectionTimeoutMs:null,greetingTimeoutMs:null,socketTimeoutMs:null,maxConnections:null,rateLimit:null,rateWindowSeconds:null,dkimSelector:null};

test('unconfigured SMTP remains disabled with unknown parameters and a reordered server object does not dirty the draft',()=>{
 const draft=smtpDraft(empty);
 assert.equal(draft.port,'');assert.equal(draft.maxConnections,'');assert.equal(draft.rateWindowSeconds,'');
 assert.deepEqual(smtpConfiguration(draft),{value:empty,error:''});
 assert.equal(smtpConfigurationChanged(draft,Object.fromEntries(Object.entries(empty).reverse())),false);
 assert.equal(smtpConfiguration({...draft,enabled:true}).value,null);
 for(const [key,value]of [['port','465.5'],['maxConnections','0'],['rateWindowSeconds','86401'],['socketTimeoutMs','3e5']]){
  assert.equal(smtpConfiguration({...draft,[key]:value}).value,null,key+' must be an explicit allowed integer');
 }
});

test('choosing a usable credential carries only its approved connection binding and preserves independently entered limits',()=>{
 const draft={...smtpDraft(empty),host:'old.invalid',port:'123',maxConnections:'2',rateLimit:'9',rateWindowSeconds:'47'};
 const credentials=[{ref:'ops-mail',label:'Approved relay',host:'mail.example.invalid',port:587,tls:'starttls',purposes:['notice'],available:true},{ref:'offline-mail',label:'Unavailable',host:'other.invalid',port:465,tls:'implicit',purposes:['team'],available:false}];
 const next=selectSmtpCredential(draft,'ops-mail',credentials);
 assert.deepEqual([next.credentialRef,next.host,next.port,next.tls],['ops-mail','mail.example.invalid','587','starttls']);
 assert.deepEqual([next.maxConnections,next.rateLimit,next.rateWindowSeconds],['2','9','47']);
 assert.equal(selectSmtpCredential(draft,'offline-mail',credentials).credentialRef,'');
 assert.equal(selectSmtpCredential(draft,'arbitrary-env-secret',credentials).credentialRef,'');
 assert.equal(smtpConfiguration({...next,host:'MAIL.EXAMPLE.INVALID'}).value.host,'mail.example.invalid');
 assert.equal(smtpConfiguration({...next,host:'https://mail.example.invalid'}).value,null);
});

test('SMTP tabs keep independent real cursor trails while API pages receive no UI, secret or unsupported query fields',()=>{
 const location=smtpLocation({tab:'queue',queueAfter:'42',queueTrail:'start,91',testsAfter:'17',testsTrail:'start',historyAfter:'8',credential:'secret-ref',host:'x',id:'opaque'});
 const next={...location,...smtpPageChange(location,'queue','12')};
 assert.equal(next.testsAfter,'17');assert.equal(next.historyAfter,'8');
 assert.deepEqual(smtpPageChange(next,'queue'),{queueAfter:'42',queueTrail:['start','91']});
 const restored=smtpLocation(Object.fromEntries(new URL(smtpHref(next,{tab:'configuration'}),'https://admin.invalid').searchParams));
 assert.equal(restored.tab,'configuration');assert.equal(restored.queueAfter,'12');assert.equal(restored.testsAfter,'17');
 const query=new URLSearchParams(smtpPageQuery(next.queueAfter));
 assert.deepEqual([...query.keys()].sort(),['after','limit']);assert.equal(query.get('after'),'12');
 const rejected=smtpLocation({tab:['queue','domains'],queueAfter:'9223372036854775808',testsAfter:'1&limit=999',historyAfter:'-1',queueTrail:'start,bad,2'});
 assert.equal(rejected.tab,'configuration');assert.equal(rejected.queueAfter,'');assert.equal(rejected.testsAfter,'');assert.equal(rejected.historyAfter,'');assert.deepEqual(rejected.queueTrail,['start','2']);
 assert.equal(smtpState('submitted'),'已提交SMTP');assert.equal(smtpState('unapproved-private-state'),'未记录');
 assert.equal(smtpCode('unapproved-private-response'),'需要核对当前发信记录。');
});
