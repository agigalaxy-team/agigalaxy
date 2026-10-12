import {randomUUID} from 'node:crypto';

// Explicit synthetic source corpus, created through the caller's normal
// signed APIs. It supplies readable material, never successful bookmark ACKs.
export async function seedReadingBookmarkSources({subjectId,submit,now,count=1}){
  const caseId=randomUUID(),root={schemaVersion:2,kind:'case-created',eventId:caseId,caseId,expectedVersion:0,actorId:subjectId,
    localRef:randomUUID(),title:'[本地合成] 目录阅读标本',summary:'这份事实仅是隔离阅读样本，不是实际用户工作或运行认证。',
    source:{kind:'local',reference:randomUUID()},synthetic:true};
  await submit('/v2/cases/events',root,'case.teaser.publish');
  const attempt={schemaVersion:2,kind:'attempt-start',eventId:randomUUID(),caseId,expectedVersion:1,actorId:subjectId,
    role:'implementation',strategy:'比较两段明确合成的阅读说明。',inputScopeSummary:'仅合成材料',permissionScope:['selected-context'],environment:{name:'Synthetic text corpus',version:'1'}};
  await submit('/v2/cases/events',attempt,'case.teaser.publish');
  const result={schemaVersion:2,kind:'result-recorded',eventId:randomUUID(),caseId,expectedVersion:2,actorId:subjectId,
    origin:{kind:'attempt',id:attempt.eventId,version:1},scopeVersion:1,deliverableRefs:[],reportedOutcome:'succeeded',
    summary:'[本地合成] 标本报告达到本地说明目的。不是已运行工具或独立能力验证。',limitations:'此判断属于明示合成数据，仅用于阅读流程。'};
  await submit('/v2/cases/events',result,'case.teaser.publish');
  const capsules=[],projects=[];
  for(let index=0;index<count;index++){
    const capsule={schemaVersion:2,id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,
      publicationClass:'formal-source-success',synthetic:true,title:`[本地合成] 阅读对照方法 ${index+1}`,problemPattern:`阅读说明中的边界和步骤 ${index+1}`,
      environment:{name:'Synthetic text corpus',version:'1'},solutionStrategy:'先读原段落，再按同一范围对照说明；保留不同解释。',
      tools:[],skills:[],mcpRefs:[],verificationMethod:'对照这份明确合成的结果说明。',limitations:['仅隔离阅读样本，未验证真实模型或外部工具。'],
      capabilityId:'reading-review',applicableScope:'合成文字说明的阅读与对照',license:'MIT',contributors:[],
      sourceResolution:{caseId,resultId:result.eventId,resultVersion:1,proofIds:[],verificationRefs:[]},sourceRefs:[],permissionRefs:[],attributionRefs:[],externalReferences:[],redactionConfirmed:true};
    const capsuleWrite=await submit('/v2/capsules/events',capsule,'capsule.publish');
    capsules.push({reference:{kind:'capsule',capsuleId:capsule.capsuleId,versionId:capsule.id},title:capsule.title,...capsuleWrite});
    const project={operationId:randomUUID(),projectId:randomUUID(),expectedRevision:0,kind:'create',document:{kind:'project',
      title:`[本地合成] 说明对照项目 ${index+1}`,summary:`作者提供的合成介绍 ${index+1}，不表示已实际部署或通过运行检查。`,
      functions:[index%2?'文本对照':'资料整理'],technologies:['Markdown'],participantKind:'tool',discoverable:true}};
    const projectWrite=await submit('/v2/projects',project,'project.write');
    projects.push({reference:{kind:'project',projectId:project.projectId},title:project.document.title,...projectWrite});
  }
  return{synthetic:true,createdAt:now,sourceCase:caseId,sourceResult:result.eventId,capsules,projects,
    boundary:'Actual signed source publications. Reported success is synthetic corpus data, not runtime, model or independent verification.'};
}
