import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

// Execute the real access functions and collection policy. Only Payload's error
// constructor is substituted; this is not a CMS/database or upload integration.
const compiled=await build({stdin:{contents:`export * from '../src/lib/access.ts';export * from '../src/lib/cms-access.ts';export {Media} from '../src/collections/Media.ts';`,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'payload-error-only',setup(builder){builder.onResolve({filter:/^payload$/},()=>({path:'error',namespace:'payload-error'}));builder.onLoad({filter:/.*/,namespace:'payload-error'},()=>({contents:'export class APIError extends Error {constructor(message,status){super(message);this.status=status;}}',loader:'js'}));}}]});
const policy=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const operator=(role,permissions)=>({id:'cms-projection',externalId:'verified-upstream-id',collection:'operators',displayName:'合成管理身份',role,verifiedOperator:true,...(permissions===undefined?{}:{businessAuthorization:{version:'committed-version-7',permissions}})});
const request=user=>({user,context:{},query:{}});

test('Payload access consumes live business grants without expanding the upstream login role',()=>{
 const legacy=request(operator('administrator'));
 assert.equal(policy.canRead({req:legacy}),false);assert.equal(policy.canEdit({req:legacy}),false);
 const writer=request(operator('reader',['cms.read','cms.edit']));
 assert.equal(policy.isOperator(writer.user),true);assert.equal(policy.canRead({req:writer}),true);assert.equal(policy.canEdit({req:writer}),true);
 assert.equal(writer.user.role,'reader');assert.equal(policy.hasOperatorPermission(writer.user,'cms.publish'),false);
 assert.equal(policy.hasOperatorPermission({businessAuthorization:{version:'',permissions:['cms.edit']}},'cms.edit'),false);
 assert.equal(policy.hasOperatorPermission(writer.user,'arbitrary.expression'),false);
 assert.equal(policy.canReadOwnOperator({req:writer}).externalId.equals,'verified-upstream-id');
 assert.deepEqual(policy.Media.access.read({req:request(null)}),{published:{equals:true}});
 assert.deepEqual(policy.Media.access.read({req:request(operator('reader',[]))}),{published:{equals:true}});
 assert.equal(policy.Media.access.read({req:writer}),true);
});

test('CMS drafts and live publication have separate rights, including media replacement before file side effects',async()=>{
 const writer=request(operator('reader',['cms.read','cms.edit']));
 assert.deepEqual(policy.enforceCmsPublication({req:writer,data:{title:'新草稿'}}),{title:'新草稿',_status:'draft'});
 assert.throws(()=>policy.enforceCmsPublication({req:writer,data:{title:'直接改线上'},originalDoc:{_status:'published'}}),error=>error.status===403);
 assert.throws(()=>policy.enforceCmsPublication({req:writer,data:{_status:'published'},originalDoc:{_status:'draft'}}),error=>error.status===403);
 assert.throws(()=>policy.enforceCmsPublication({req:writer,data:{_status:'draft'},originalDoc:{_status:'published'}}),error=>error.status===403);
 assert.equal(policy.enforceCmsPublication({req:{...writer,query:{draft:'true'}},data:{_status:'draft',title:'保留线上另存草稿'},originalDoc:{_status:'published'}})._status,'draft');
 assert.deepEqual(policy.Media.access.update({req:writer}),{published:{not_equals:true}});
 const publisher=request(operator('reader',['cms.read','cms.edit','cms.publish']));
 assert.equal(policy.Media.access.update({req:publisher}),true);
 assert.equal(policy.enforceCmsPublication({req:publisher,data:{_status:'published'},originalDoc:{_status:'draft'}})._status,'published');
 assert.equal(policy.enforceCmsPublication({req:publisher,data:{_status:'draft'},originalDoc:{_status:'published'}})._status,'draft');
 const publishedLookup=async()=>({_status:'published'});
 await assert.rejects(policy.enforcePublishedPageDeletion({req:{...writer,payload:{findByID:publishedLookup}},id:'existing-page'}),error=>error.status===403);
 await policy.enforcePublishedPageDeletion({req:{...publisher,payload:{findByID:publishedLookup}},id:'existing-page'});
});
