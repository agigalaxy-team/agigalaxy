import {agentOsQueryViews} from './operations-agentos-query-schema.mjs';

// One closed permission mapping for both the actual query and its capability
// description. This describes permission only, never service/data readiness.
export const agentOsModuleReadActions=Object.freeze({accounts:'accounts.read','registered-users':'accounts.registered.read','system-settings':'system.settings.read',content:'content.read',cases:'cases.read','chat-reports':'chat-reports.read',feedback:'feedback.read',files:'files.read',resources:'resources.read',analytics:'analytics.read',recommendations:'recommendations.read',search:'search-quality.read',messaging:'notices.read',strategies:'strategies.read',rules:'rules.read',maintenance:'maintenance.read',audit:'audit.read',runs:'audit.read',jobs:'jobs.read',permissions:'permissions.read'});

export function agentOsQueryReadAction(module,{view,kind}={}){
 if(module==='accounts'&&(view==='summary'||kind==='account-summary'))return 'analytics.read';
 if(module==='content'&&(view==='sections'||kind==='section'))return 'sections.read';
 if(module==='content'&&(view==='tags'||kind==='content-tag'))return 'content.tags.read';
 if(module==='maintenance'&&view==='logs')return 'maintenance.logs.read';
 return agentOsModuleReadActions[module];
}

export function agentOsQueryAccess(permissions){
 const allowed=new Set(Array.isArray(permissions)?permissions:[]);
 return {basis:'current-human-ai-query-permission-intersection',dataRead:false,
  allowedViews:Object.fromEntries(Object.entries(agentOsQueryViews).map(([module,views])=>
   [module,views.filter(view=>allowed.has(agentOsQueryReadAction(module,{view})))]).filter(([,views])=>views.length))};
}
