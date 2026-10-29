// Synthetic shared-contract codec vectors; legacy domain projections are fixed evidence.
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const legacy=JSON.parse(await readFile(new URL('../../go/internal/testsupport/testdata/chat-codec-legacy.json',import.meta.url),'utf8'));
 if(process.argv[2]==='moderation-codec'){
  const {moderationReportSchema,moderationEventSchema}=await import('../../packages/galaxy-contracts/src/moderation-schema.mjs');const id=randomUUID(),subject='GUID'+'A'.repeat(28),handler='GUID'+'B'.repeat(28),cases=[],add=(input,report)=>{const p=(report?moderationReportSchema:moderationEventSchema).safeParse(input);cases.push({input,report,accepted:p.success,normalized:p.success?p.data:null})};
  for(const n of [1200,1201])add({id,category:'other',summary:'🚀'.repeat(n),caseId:id,caseVersion:3,targetEventId:id},true);
  const common={id,reportId:id,expectedVersion:1,summary:'  Source review\ufeff '};for(const kind of ['pause','resume','appeal'])add({...common,kind},false);add({...common,kind:'supplement'},false);add({...common,kind:'correct',correctsEventId:id,reason:' original '},false);add({...common,kind:'invite-verifier',verifierId:subject,target:{caseId:id,caseVersion:1,targetEventId:id},scope:' original ',expiresAt:2000000100},false);add({...common,kind:'verification-response',invitationId:id,conclusion:'inconclusive'},false);add({...common,kind:'supplement',references:[{kind:'artifact',sha256:'a'.repeat(64)}]},false);add({...common,kind:'supplement',references:[{kind:'artifact',sha256:'A'.repeat(64)}]},false);
  console.log(JSON.stringify({cases,projections:legacy.moderationProjections}));
 }else if(process.argv[2]==='target-codec'){
  const {targetReportSchemaV2,targetModerationSchemaV2}=await import('../../packages/galaxy-contracts/src/target-governance-v2-schema.mjs');const id=randomUUID(),cases=[];const add=(input,report)=>{const p=(report?targetReportSchemaV2:targetModerationSchemaV2).safeParse(input);cases.push({input,report,accepted:p.success,normalized:p.success?p.data:null})};
  for(const n of [1600,1601])add({schemaVersion:2,id,target:{type:'task',id,version:1,rootEventId:id},category:'other',summary:'🚀'.repeat(n)},true);
  const common={schemaVersion:2,id,reportId:id,expectedVersion:1,summary:'  original\ufeff '};for(const kind of ['supplement','appeal','withdraw-report','resume','review'])add({...common,kind},false);
  for(const scopes of [['sending-paused'],['sending-paused','invitations-paused'],['sending-paused','sending-paused']])add({...common,kind:'pause',targetVersion:1,rule:' original ',until:2000000100,scopes},false);
  for(const restriction of [null,{scopes:['discovery-hidden'],until:2000000100},undefined])add({...common,kind:'resolve',verdict:'dismissed',rule:'original',targetVersion:1,...(restriction===undefined?{}:{restriction})},false);
  console.log(JSON.stringify({cases}));
 }else if(process.argv[2]==='recruitment-codec'){
  const {recruitmentEventV2Schema}=await import('../../packages/galaxy-contracts/src/recruitment-schema-v2.mjs');const {digest}=await import('../../packages/galaxy-contracts/src/digest.mjs');const {createCipheriv}=await import('node:crypto');
  const id=randomUUID(),subject='GUID'+'A'.repeat(28),common={operationId:id,recruitmentId:id,projectId:id,expectedRevision:0,kind:'create',expiresAt:2000001000},document={title:'Role',role:'Discuss',summary:'Summary',functions:[' Parse ','🧭'],contactSubjectId:subject},cases=[];
  for(const [field,max]of [['title',120],['role',500],['summary',3000],['conditions',2000]])for(const n of [max,max+1]){const input={...common,document:{...document,[field]:'🚀'.repeat(n)}},p=recruitmentEventV2Schema.safeParse(input);cases.push({input,accepted:p.success,normalized:p.success?p.data:null})}
  const source={functions:['ｐａｒｓｅ','🧭','𐀀'],technologies:['Rust']},candidate={functions:['parse','🧭','\ue000'],technologies:['Go']},left={enabled:true,purposes:['recruitment','conversation'],functions:[]},right={enabled:true,purposes:['recruitment'],functions:[]};
  const refs=[{subjectId:subject,projectId:id,statementId:id},{sourceKind:'project',subjectId:subject,projectId:id,documentEventId:id,policyEventId:id},{sourceKind:'recruitment',subjectId:subject,projectId:id,recruitmentId:id,eventId:id}];
  const key=Buffer.alloc(32,7),iv=Buffer.alloc(12,3),cursor={v:2,queryHash:'f'.repeat(64),viewerId:subject,startAfter:id,expiresAt:2000000900},cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('galaxy-discovery-v2'));const encrypted=Buffer.concat([cipher.update(JSON.stringify(cursor),'utf8'),cipher.final()]),token=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  console.log(JSON.stringify({cases,source,candidate,left,right,match:legacy.recruitmentMatch,refs:refs.map(ref=>({ref,id:digest(JSON.stringify(ref))})),cursor:{key:key.toString('base64url'),token,value:cursor}}));
 }else if(process.argv[2]==='project-codec'){
  const {projectEventV2Schema}=await import('../../packages/galaxy-contracts/src/projects-schema-v2.mjs');

  const id=randomUUID(),common={operationId:id,projectId:id,expectedRevision:0,kind:'create'},cases=[];
  const base={kind:'module',title:'Original document',summary:'summary',functions:['tag']};
  const add=raw=>{const p=projectEventV2Schema.safeParse(JSON.parse(raw));cases.push({raw,accepted:p.success,document:p.success?p.data.document:null,length:p.success?JSON.stringify(p.data.document).length:null});};
  add(JSON.stringify({...common,document:{...base,separator:'\u2028\u2029',escaped:'\\u2028',numeric:1e20}}).replace('100000000000000000000','1e20').replace('"numeric":1e20','"numeric":1e20,"zero":-0'));
  for(const n of [60,61])add(JSON.stringify({...common,document:{...base,['🚀'.repeat(n)]:'extension'}}));
  for(const n of [6900,7000])add(JSON.stringify({...common,document:{...base,extension:'🚀'.repeat(n)}}));
  const tags=['\ue000','🚀',' ＴＡＧ ','tag','\ufeffa','A'];const normalized=legacy.projectNormalized;
  console.log(JSON.stringify({cases,tags,normalized}));
 }else if(process.argv[2]==='schema-astral'){
  const {chatCreateSchema,chatSendSchema,chatEditSchema}=await import('../../packages/galaxy-contracts/src/chat-schema.mjs');
  const {contactEventV2Schema}=await import('../../packages/galaxy-contracts/src/contacts-schema-v2.mjs');
  const {projectEventV2Schema}=await import('../../packages/galaxy-contracts/src/projects-schema-v2.mjs');
  const {summaryContentSchema}=await import('../../packages/galaxy-contracts/src/personal-summary-schema.mjs');
  const cases=[],id=randomUUID(),common={operationId:id,projectId:id,expectedRevision:0};
  const add=(kind,schema,input)=>{const parsed=schema.safeParse(input);cases.push({kind,input,accepted:parsed.success,normalized:parsed.success?parsed.data:null});};
  for(const n of [120,121])add('create',chatCreateSchema,{roomId:id,operationId:id,title:'🚀'.repeat(n)});
  for(const n of [16000,16001]){add('send',chatSendSchema,{clientMessageId:id,text:'🚀'.repeat(n)});add('edit',chatEditSchema,{operationId:id,expectedRevision:1,text:'🚀'.repeat(n)});}
  for(const n of [8000,8001])add('summary',summaryContentSchema,{generator:{kind:'manual'},coverage:{fromSequence:'0',throughSequence:'0',complete:true},fragments:[{id,kind:'personal-note',text:'🚀'.repeat(n),sourceRefs:[]}],keyMessageRefs:[]});
  for(const n of [2000,2001])add('contact',contactEventV2Schema,{operationId:id,contactId:id,expectedRevision:1,kind:'accept',note:'🚀'.repeat(n)});
  for(const n of [120,121])add('project',projectEventV2Schema,{...common,kind:'create',document:{kind:'module',title:'🚀'.repeat(n),summary:'summary',functions:['tag']}});
  console.log(JSON.stringify({cases}));
 }else{throw Error('unknown protocol codec fixture');}
