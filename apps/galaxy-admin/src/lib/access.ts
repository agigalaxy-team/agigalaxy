import type {Access,PayloadRequest} from 'payload';

export type OperatorUser={id:string;collection:'operators';externalId:string;displayName:string;role:'administrator'|'reader';verifiedOperator:true};
export const operatorSync=Symbol('verified-operator-projection');
export function isOperator(user:unknown):user is OperatorUser{
  if(!user||typeof user!=='object')return false;
  const value=user as Partial<OperatorUser>;return value.collection==='operators'&&value.verifiedOperator===true&&typeof value.externalId==='string'&&['administrator','reader'].includes(value.role??'');
}
export const canRead:Access=({req})=>isOperator(req.user);
export const canEdit:Access=({req})=>isOperator(req.user)&&req.user.role==='administrator';
export const internalOperatorSync=({req}:{req:PayloadRequest})=>isOperator(req.user)&&req.context.operatorProjection===operatorSync;
export const canReadOwnOperator:Access=({req})=>isOperator(req.user)?{externalId:{equals:req.user.externalId}}:false;
