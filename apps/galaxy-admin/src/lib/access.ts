import type {Access,PayloadRequest} from 'payload';
import {isOperationsPermission,operationsPermissionCatalog} from '../../../../packages/galaxy-contracts/src/operations-permission-catalog.mjs';

export type OperatorBusinessAuthorization={version:string;permissions:string[]};
export type OperatorUser={id:string;collection:'operators';externalId:string;displayName:string;role:'administrator'|'reader';verifiedOperator:true;businessAuthorization?:OperatorBusinessAuthorization};
export const operatorSync=Symbol('verified-operator-projection');
export function isOperator(user:unknown):user is OperatorUser{
  if(!user||typeof user!=='object')return false;
  const value=user as Partial<OperatorUser>;return value.collection==='operators'&&value.verifiedOperator===true&&typeof value.externalId==='string'&&['administrator','reader'].includes(value.role??'');
}
// A display/access projection of the current signed-in session. Business APIs
// separately recheck the live operator and committed PG grants on every action.
export function operatorBusinessAuthorization(user:unknown):OperatorBusinessAuthorization|undefined{
 if(!user||typeof user!=='object'||!('businessAuthorization' in user))return;
 const value=user.businessAuthorization;
 if(!value||typeof value!=='object'||!('version' in value)||typeof value.version!=='string'||!value.version||!('permissions' in value)||!Array.isArray(value.permissions))return;
 return {version:value.version,permissions:value.permissions.filter((code):code is string=>typeof code==='string'&&isOperationsPermission(code))};
}
export function hasOperatorPermission(user:unknown,code:string):boolean{
 return isOperationsPermission(code)&&operatorBusinessAuthorization(user)?.permissions.includes(code)===true;
}
export function hasAnyOperatorPermission(user:unknown,codes:readonly string[]):boolean{return codes.some(code=>hasOperatorPermission(user,code));}
export function operatorPermissionLabel(code:string):string{return operationsPermissionCatalog.find((permission:{code:string;label:string})=>permission.code===code)?.label??'相应业务操作';}
export const canRead=({req}:{req:PayloadRequest}):boolean=>isOperator(req.user)&&hasOperatorPermission(req.user,'cms.read');
export const canEdit=({req}:{req:PayloadRequest}):boolean=>isOperator(req.user)&&hasOperatorPermission(req.user,'cms.edit');
export const internalOperatorSync=({req}:{req:PayloadRequest})=>isOperator(req.user)&&req.context.operatorProjection===operatorSync;
export const canReadOwnOperator:Access=({req})=>isOperator(req.user)?{externalId:{equals:req.user.externalId}}:false;
