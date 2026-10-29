import {operationsPermissionCatalog} from './operations-permission-catalog.mjs';

// One product action directory. A position's name is context, never an ACL.
// Permission, human decision and connected handler are separate facts.
const queryCodes=['search.read','accounts.read','accounts.registered.read','system.settings.read','analytics.read','content.read','sections.read','content.tags.read','cases.read','chat-reports.read','feedback.read','files.read','resources.read','recommendations.read','search-quality.read','notices.read','strategies.read','rules.read','maintenance.read','maintenance.logs.read','audit.read','jobs.read','permissions.read','ai.roles.read','ai.prompts.read'];
queryCodes.push('autonomy.read');
const definitions=[
 ['job-cancel','maintenance','取消具体运行任务','jobs.read',['jobs.cancel'],'jobActions',['read','command','operation','qualifyWithin'],['ordinary']],
 ['job-retry','maintenance','重试具体失败任务','jobs.read',['jobs.retry'],'jobActions',['read','command','operation','qualifyWithin'],['ordinary','bounded-retry']],
 ['search-retry','discovery','重试具体失败索引代次','search.read',['search.retry'],'jobActions',['read','command','operation','qualifyWithin'],['ordinary','bounded-retry','current-source']],
 ['ai-work-prompt-save','overview','修改获准其他 AI 的岗位工作要求','ai.prompts.read',['ai.prompts.update'],'permissions',['delegatedPrompt','delegatedPromptSave','delegatedManagementOperation'],['explicit-prompt-delegation','other-ai-only','version-cas','role-work-requirements-only']],
 ['ai-role-command','overview','维护获准其他 AI 的专用角色','ai.roles.read',['ai.roles.create','ai.roles.update','ai.roles.assign','ai.roles.revoke'],'permissions',['delegatedDirectory','delegatedRolePreparation','delegatedRoleSave','delegatedManagementOperation'],['delegated-ai-only','version-cas']],
 ['content-visibility','governance','下架或恢复公开内容','content.read',['content.hide','content.restore'],'content',['get','visibility'],['ordinary','current-source','prior-automatic-decision']],
 ['content-curation','governance','调整公开内容分类与编排','content.read',['content.curate'],'content',['get','curate'],['ordinary','current-source','existing-taxonomy','prior-automatic-decision']],
 ['public-content-batch','governance','处理明确选定的一批公开内容','content.read',['content.batch.hide','content.batch.restore'],'content',['get','preview','batch'],['ordinary','explicit-selected-impact-bound','current-source','prior-automatic-decision']],
 ['private-case-message','governance','处理具体私聊案件已选消息','chat-reports.materials.read',['chat-messages.hide','chat-messages.restore','chat-messages.keep'],'chatReports',['operatorGet','operatorMessageVisibility','assertDutyCaseWithin'],['ordinary','triggered-case','purpose-bound-materials','prior-automatic-decision']],
 ['section-classification','governance','调整版块分类','sections.read',['sections.classify'],'community',['section','classify'],['ordinary','current-source','existing-taxonomy','prior-automatic-decision']],
 ['section-visibility','governance','下架或恢复版块','sections.read',['sections.hide','sections.restore'],'community',['section','sectionVisibility'],['ordinary','current-source','prior-automatic-decision']],
 ['resource-visibility','governance','下架或恢复项目与方法','resources.read',['resources.hide','resources.restore'],'resources',['get','visibility'],['ordinary','current-source','prior-automatic-decision']],
 ['account-restriction','governance','限制或解除单账户参与','accounts.read',['accounts.restriction.apply','accounts.restriction.release'],'accounts',['get','restrict','releaseRestriction'],['ordinary','prior-automatic-decision']],
 ['feedback-update','governance','标记使用反馈','feedback.read',['feedback.update'],'feedback',['get','event'],['ordinary','prior-automatic-decision']],
 ['file-scan-retry','maintenance','重新安排文件扫描','files.read',['files.scan.retry'],'files',['get','retry'],['ordinary','current-source']],
 ['file-access','maintenance','停止或恢复单文件访问','files.read',['files.access.stop','files.access.restore'],'fileAccess',['get','change'],['ordinary','current-source','prior-automatic-decision']],
 ['file-cleanup-approve','maintenance','批准具体文件清理计划','files.read',['files.cleanup.approve'],'fileCleanup',['plan','approve'],[],true],
 ['case-resolve','governance','复核公开举报与申诉','cases.read',['cases.resolve'],'community',['report','resolve'],['ordinary','current-source','prior-automatic-decision']],
 ['messaging-state','messaging','发布、暂停或撤回消息计划','notices.read',['notices.publish','notices.withdraw'],'messaging',['get','action'],['ordinary','approved-purpose','approved-audience','verified-facts','prior-automatic-decision']],
 ['message-draft-create','messaging','生成待核实消息草稿','notices.read',['notices.create'],'messaging',['create','get','commandResult','assertDutyDraftWithin','validateConfig'],['draft-only','human-facts-required','publication-not-authorized']],
 ['message-draft-save','messaging','保存待核实消息草稿','notices.read',['notices.update'],'messaging',['save','get','commandResult','assertDutyDraftWithin','validateConfig'],['draft-only','current-source','human-facts-required','publication-not-authorized']],
 ['ordinary-strategy-draft','overview','在已批准边界内调整日常策略','strategies.read',['strategies.ordinary.configure'],'ordinaryStrategies',['read','prepare','command','operation','inspectWithin'],['ordinary','approved-fields','current-source']],
 ['ordinary-strategy-publish','overview','发布已预演的日常策略调整','strategies.read',['strategies.ordinary.publish'],'ordinaryStrategies',['read','prepare','command','operation','inspectWithin'],['ordinary','approved-version','rehearsal-required','current-source']],
 ['strategy-draft','overview','保存完整策略草稿','strategies.read',['strategies.configure'],'strategies',['saveDraft'],['human-confirmation'],true],
 ['strategy-rehearsal','overview','预演已保存的策略草稿','strategies.read',['strategies.read'],'strategies',['rehearsal'],['side-effect-free'],true],
 ['strategy-publish','overview','发布已预演的策略草稿','strategies.read',['strategies.publish'],'strategies',['publish'],['human-confirmation','rehearsal-required'],true],
 ['strategy-control','overview','暂停或恢复策略执行','strategies.read',['strategies.control'],'strategies',['control'],[],true],
 ['strategy-continue','governance','决定已暂停的具体策略事项','strategies.read',['strategies.run'],'strategies',['continue'],[],true],
 ['search-apply','discovery','应用已保存搜索草稿','search-quality.read',['search-quality.publish'],'searchQuality',['overview','command'],['ordinary','prior-automatic-decision']],
 ['search-restore','discovery','恢复曾生效搜索配置','search-quality.read',['search-quality.restore'],'searchQuality',['overview','history','command'],['ordinary','approved-version','prior-automatic-decision']],
 ['rule-publish','overview','发布已保存规则草稿','rules.read',['rules.write'],'rules',['publish'],[],true],
 ['rule-restore','overview','恢复已发布规则版本','rules.read',['rules.write'],'rules',['restore'],[],true],
 ['recommendation-direction','discovery','调整主题推荐方向','recommendations.read',['recommendations.configure'],'recommendations',['savePolicy'],['ordinary','soft-direction-only','prior-automatic-decision']],
];
export const aiWorkPreparationRegistry=Object.freeze(definitions.map(([kind,domain,label,read,actions,service,methods,conditions,humanOnly=false])=>Object.freeze({kind,domain,label,read,actions:Object.freeze(actions),handler:Object.freeze({service,methods:Object.freeze(methods)}),humanOnly,conditions:Object.freeze(conditions)})));
const extra=[
 ['ai.prompts.update','ai.prompts.read','ai-prompt-delegation','permissions',['delegatedPromptSave','delegatedManagementOperation'],['explicit-prompt-delegation','other-ai-only','version-cas','role-work-requirements-only']],
 ['ai.roles.create','ai.roles.read','ai-role-delegation','permissions',['delegatedRoleSave'],['delegated-ai-only']],
 ['ai.roles.update','ai.roles.read','ai-role-delegation','permissions',['delegatedRoleSave'],['delegated-ai-only']],
 ['ai.roles.assign','ai.roles.read','ai-role-delegation','permissions',['delegatedAssignment'],['delegated-ai-only']],
 ['ai.roles.revoke','ai.roles.read','ai-role-delegation','permissions',['delegatedAssignment'],['delegated-ai-only']],
];
const byPermission=new Map();
const implementedAdapters=new Set(['job-cancel','job-retry','search-retry','content-visibility','content-curation','public-content-batch','private-case-message','section-classification','section-visibility','resource-visibility','account-restriction','case-resolve','feedback-update','file-scan-retry','file-access','recommendation-direction','search-apply','search-restore','ordinary-strategy-draft','ordinary-strategy-publish','message-draft-create','message-draft-save','messaging-state','ai-role-delegation','ai-prompt-delegation','strategy-draft','strategy-rehearsal','strategy-publish','strategy-control','strategy-continue','rule-publish','rule-restore','file-cleanup-approve']);
for(const entry of aiWorkPreparationRegistry)for(const permission of entry.actions)if(!byPermission.has(permission))byPermission.set(permission,{kind:entry.kind,read:entry.read,handler:entry.handler,conditions:entry.conditions,humanOnly:entry.humanOnly});
for(const [permission,read,kind,service,methods,conditions] of extra)byPermission.set(permission,{kind,read,handler:{service,methods},conditions,humanOnly:false});
byPermission.set('chat-reports.materials.read',{kind:'private-case-materials',read:'chat-reports.materials.read',handler:{service:'chatReports',methods:['operatorGet','assertDutyCaseWithin']},conditions:['triggered-case','purpose-bound-materials'],humanOnly:false,purposeBoundRead:true});
export const operationsAiActionRegistry=Object.freeze(operationsPermissionCatalog.map(permission=>{
 const definition=byPermission.get(permission.code),query=queryCodes.includes(permission.code);
 return Object.freeze({permission:permission.code,label:permission.label,kind:definition?.kind??null,read:query?permission.code:definition?.read??null,
  query,purposeBoundRead:definition?.purposeBoundRead===true,autonomous:query||!!definition&&!definition.purposeBoundRead&&!definition.humanOnly&&!permission.humanOnly,humanOnly:!query&&(permission.humanOnly||definition?.humanOnly===true),
  handler:definition?.handler??null,conditions:Object.freeze(definition?.conditions??[]),handlerImplemented:query||definition?.purposeBoundRead===true||implementedAdapters.has(definition?.kind)});
}));
const registry=new Map(operationsAiActionRegistry.map(entry=>[entry.permission,entry]));
export const aiActionDefinition=permission=>registry.get(permission)??null;
export const aiQueryPermissions=Object.freeze(queryCodes);
export const aiAutonomousPermissions=Object.freeze(operationsAiActionRegistry.filter(entry=>entry.autonomous).map(entry=>entry.permission));
export function aiActionProjection(permission,{permissions=[],services=null,handlerReady=null,humanConditions=[]}={}){
 const entry=aiActionDefinition(permission),permissionAllowed=!!entry&&permissions.includes(permission),reasons=[];
 const humanRequired=!entry||entry.humanOnly||humanConditions.length>0;
 let ready=entry?.handlerImplemented===true;
 if(ready&&entry.handler&&services!==null)ready=entry.handler.methods.every(method=>typeof services[entry.handler.service]?.[method]==='function');
 if(handlerReady!==null)ready=!!entry&&(entry.query||!!entry.handler)&&handlerReady===true;
 if(!permissionAllowed)reasons.push('permission-missing');if(humanRequired)reasons.push('human-decision-required');if(!ready)reasons.push('handler-not-connected');
 return {permission,permissionAllowed,humanRequired,humanConditions:[...(entry?.humanOnly?['human-only']:[]),...humanConditions],conditions:[...(entry?.conditions??[])],handlerReady:ready,ready:permissionAllowed&&!humanRequired&&ready,reasons};
}
