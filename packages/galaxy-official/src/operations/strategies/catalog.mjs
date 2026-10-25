import {p13Domains,p13Modes,p13Workflow} from '../../shared/p13-strategies-schema.mjs';

export const p13Catalog=Object.freeze({
 domains:p13Domains.map((key,i)=>({key,label:['共同运营','社区治理','消息运营','发现与使用','运行维护'][i]})),
 modes:p13Modes.map((key,i)=>({key,label:['规则自动','AI自主推进','AI推进、人工参与','人工主导、AI辅助'][i]})),
 templates:[{key:'selected-public-content-visibility',label:'处理已明确选定的公开内容',domain:'governance',workflow:p13Workflow,
  actions:['content.read','content.hide','content.restore'],scope:'existing-explicit-execution',execution:'connected-adapter'},
 {key:'analysis-only',label:'目标与分析方案',domain:null,workflow:null,actions:[],scope:'no-effects',execution:'autonomy-task'},
 {key:'business-action',label:'获准业务处理',domain:null,workflow:null,actions:[],scope:'configured-role-strategy-and-grant',execution:'autonomy-task'}],
 fixedBoundaries:['latest-authorization','explicit-resource-scope','current-source-and-cas','no-human-decision-override',
  'human-only-model-settings','human-approved-restore-plan','human-approved-legacy-file-cleanup',
  'no-private-materials-in-profile-or-recommendations','new-version-for-new-matters','no-replay-of-completed-effects'],
 unavailableActions:['arbitrary-code','unscoped-actions','website-restore','file-purge','model-configuration'],
 rehearsal:{sideEffects:false,scope:'current-consumer-qualification-and-fixed-branches',modelCalls:false},
 ordinaryMaintenance:{scope:'explicit-existing-strategy-and-human-numeric-bounds',actions:['strategies.read','strategies.ordinary.configure','strategies.ordinary.publish'],
  tools:['read-selected-strategy','save-selected-strategy-draft','publish-selected-strategy'],
  conditionFields:['textLength','linkCount','attachmentCount'],changes:['bounded-numeric-values','allowed-leadership-mode','explicit-daily-enable-disable'],
  humanOnly:['common-goals','domain-goals','condition-structure','authorization-bounds','important-human-led-strategy','model-settings']},
});
