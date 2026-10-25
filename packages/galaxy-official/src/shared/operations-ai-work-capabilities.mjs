import {aiWorkPreparationRegistry,aiQueryPermissions,aiAutonomousPermissions,aiActionProjection} from './operations-ai-action-registry.mjs';

export const aiWorkQueryPermissions=aiQueryPermissions;
export const aiWorkPreparation=aiWorkPreparationRegistry;
export const aiWorkAutonomousPermissions=aiAutonomousPermissions;
export function aiWorkCapabilities(_domain,permissions,options={}){
 const allowed=new Set(permissions);
 return {queryPermissions:aiWorkQueryPermissions.filter(code=>allowed.has(code)),
  preparableKinds:aiWorkPreparation.filter(entry=>allowed.has(entry.read)&&entry.actions.some(code=>allowed.has(code))).map(entry=>entry.kind),
  autonomousPermissions:aiWorkAutonomousPermissions.filter(code=>allowed.has(code)),
  actions:[...allowed].map(permission=>aiActionProjection(permission,{permissions,...options}))};
}
