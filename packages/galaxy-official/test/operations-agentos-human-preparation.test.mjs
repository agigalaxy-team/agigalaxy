import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OperationsAgentOsActionTools} from "../src/operations/agentos/action-tools.mjs";
import {aiWorkCapabilities} from '../src/shared/operations-ai-work-capabilities.mjs';
import {ServiceError} from '../src/shared/service-error.mjs';

test('grant-bound directory results do not decide human preparation; current human/AI/domain permissions and fresh object checks still do',async()=>{
 const id=randomUUID(),caller={kind:'business-operator',operatorId:'synthetic-current-owner',endpoint:'https://synthetic.invalid'};
 let human=['content.read','content.curate'],ai=[...human],listDenied=false,executionDenied=false,denyAll=false,lateRevoke=false,sourceAvailable=true,canCurate=true;
 let listReads=0,sourceReads=0,effects=0;const purposes=[];
 const current=()=>human.filter(code=>ai.includes(code));
 // Explicit current human/AI resolver and source doubles. The actual action
 // tool, preparation parser, shared capability catalog and command builder run.
 const authority={db:{query(){throw Error('unexpected database access');}},endpoint:caller.endpoint,now:()=>2000000000,supported:new Set(['content.read','content.hide','content.restore']),
  async human(input,{domain='governance',purpose='prepare',action='workbench.read'}={}){
   assert.equal(input.operatorId,caller.operatorId);purposes.push(purpose);
   if(denyAll||purpose==='execution'&&executionDenied)throw new ServiceError('operations_permission_denied',403);
   const both=current(),permissions=purpose==='execution'?aiWorkCapabilities(domain,both).autonomousPermissions:both;
   if(action!=='workbench.read'&&!permissions.includes(action))throw new ServiceError('operations_permission_denied',403);
   return{...caller,businessAuthorization:{version:'fresh-current',permissions}};
  },
  async list(){listReads++;if(listDenied)throw new ServiceError('operations_permission_denied',403);if(lateRevoke)ai=['content.read'];return{items:[]};}
 };
 const content={async get(actor,kind,target){sourceReads++;assert.equal(kind,'post');assert.equal(target,id);await authority.human(actor,{action:'content.read'});return{content:{kind,id,version:9,versionId:randomUUID(),title:'当前来源',topic:'learning',originalTopic:'technology',sourceState:sourceAvailable?'available':'unavailable',publishedUntil:2000003600,visibility:{hidden:false,version:6},curation:{revision:3,topic:'learning'},capabilities:{canCurate}},checkedAt:2000000000,readExpiresAt:2000000030};},async curate(){effects++;throw Error('preparation must not execute');}};
 const tools=new OperationsAgentOsActionTools({conversations:{},authority,gateway:{},services:{content}});
 let value=await tools.listAuthorizedWork(caller,'governance');
 assert.deepEqual(value.items,[]);assert.equal(listReads,1);assert.equal(value.basis.complete,true);assert.equal(value.basis.availability,'available');
 assert.deepEqual(value.humanPreparation,{tool:'prepare-operation',availableKinds:['content-curation'],requiresAuthorizedExecution:false,requiresHumanConfirmation:true,objectEligibility:'checked-when-preparing'});
 assert.equal(sourceReads,0,'a permitted kind is not an inspected or eligible object');
 listDenied=true;value=await tools.listAuthorizedWork(caller,'governance');
 assert.equal(value.basis.availability,'not-authorized');assert.equal(value.basis.complete,false);assert.deepEqual(value.humanPreparation.availableKinds,['content-curation']);
 listDenied=false;executionDenied=true;value=await tools.listAuthorizedWork(caller,'governance');
 assert.equal(value.basis.availability,'not-authorized');assert.deepEqual(value.humanPreparation.availableKinds,['content-curation']);executionDenied=false;
 for(const denied of ['human-write','ai-write','human-read','ai-read']){
  human=['content.read','content.curate'];ai=[...human];
  if(denied==='human-write')human=['content.read'];if(denied==='ai-write')ai=['content.read'];if(denied==='human-read')human=['content.curate'];if(denied==='ai-read')ai=['content.curate'];
  assert.deepEqual((await tools.listAuthorizedWork(caller,'governance')).humanPreparation.availableKinds,[],denied);
 }
 human=['content.read','content.curate'];ai=[...human];
 assert.deepEqual((await tools.listAuthorizedWork(caller,'maintenance')).humanPreparation.availableKinds,['content-curation'],'the same current role permissions expose the same preparable kinds across domains');
 lateRevoke=true;assert.deepEqual((await tools.listAuthorizedWork(caller,'governance')).humanPreparation.availableKinds,[],'late role removal is observed after directory read');lateRevoke=false;ai=[...human];
 denyAll=true;await assert.rejects(tools.listAuthorizedWork(caller,'governance'),{code:'operations_permission_denied'});denyAll=false;
 const clear={kind:'content-curation',targetKind:'post',targetId:id,topic:null,reason:'按当前来源清除这次分类覆盖'};
 const proposal=await tools.prepareFor(caller,'governance',clear);
 assert.equal(proposal.command.topic,null);assert.equal(Object.hasOwn(proposal.command,'topic'),true);assert.equal(proposal.command.expectedVersion,9);assert.equal(proposal.command.expectedRevision,3);
 assert.equal(proposal.requiredAction,'content.curate');assert.equal(proposal.decisionSource,'human-required');assert.equal(effects,0);assert.ok(purposes.includes('prepare'));
 assert.equal(Object.hasOwn(proposal.command,'pinned'),false);assert.equal(Object.hasOwn(proposal.command,'featured'),false);assert.equal(Object.hasOwn(proposal.command,'tagIds'),false);
 for(const change of ['write-removed','object-cap-removed','source-unavailable']){
  ai=change==='write-removed'?['content.read']:[...human];canCurate=change!=='object-cap-removed';sourceAvailable=change!=='source-unavailable';
  await assert.rejects(tools.prepareFor(caller,'governance',clear));assert.equal(effects,0);
 }
});
