import {z} from 'zod';
import {operationsForumDecisionSchema,operationsSectionClassificationSchema,operationsVisibilitySchema} from './operations-business-schema.mjs';
import {operationsContentVisibilitySchema,operationsContentCurationSchema,operationsContentBatchSchema,operationsTagCreateSchema,operationsTagUpdateSchema} from './operations-forum-content-schema.mjs';

const id=z.uuid(),uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const report=new RegExp('^/v1/operations/community/reports/('+uuid+')/resolve$','i');
const section=new RegExp('^/v1/operations/community/sections/('+uuid+')/(classification|visibility)$','i');
const content=new RegExp('^/v1/operations/community/content/(post|reply)/('+uuid+')/(curation|visibility)$','i');
const tag=new RegExp('^/v1/operations/community/tags(?:/('+uuid+'))?$','i');
const resource=new RegExp('^/v1/operations/resources/(projects|methods)/('+uuid+')/visibility$','i');
function parse(schema,value){const result=schema.safeParse(value);if(!result.success)throw Error('Invalid original governance intent');return result.data;}
export function canonicalReceiptInput(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalReceiptInput).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonicalReceiptInput(value[key])).join(',')+'}';
 throw Error('Invalid original governance intent');
}
export async function receiptTextHash(value){
 const bytes=new TextEncoder().encode(value),hash=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function governanceReceiptHash(action,selection,hash=receiptTextHash){return hash(canonicalReceiptInput({action,selection}));}

// Normalize using the same formal write schemas. No body, reason or selection
// is sent to the recovery GET; only its exact original fingerprint is compared.
export async function governanceReceiptIntent(path,body,hash=receiptTextHash){
 let action,selection,receiptPath,readPermission;
 const r=report.exec(path),s=section.exec(path),c=content.exec(path),t=tag.exec(path),v=resource.exec(path);
 if(r){
  const x=parse(operationsForumDecisionSchema,body),{summary,...metadata}=x;
  action='community-report-resolve';selection={id:r[1],...metadata,summaryDigest:await hash(summary),resourceId:r[1]};
  receiptPath='/v1/operations/community/reports/'+r[1]+'/operations/'+x.operationId;readPermission='cases.read';
 }else if(s){
  const x=parse(s[2]==='classification'?operationsSectionClassificationSchema:operationsVisibilitySchema,body);
  action=s[2]==='classification'?'community-section-classify':'community-section-visibility';selection={id:s[1],...x,resourceId:s[1]};
  receiptPath='/v1/operations/community/sections/'+s[1]+'/operations/'+x.operationId;readPermission='sections.read';
 }else if(c){
  const x=parse(c[3]==='curation'?operationsContentCurationSchema:operationsContentVisibilitySchema,body),{reason,...metadata}=x;
  action='community-content-'+c[3];selection={...(c[3]==='curation'?{kind:c[1]}:{targetKind:c[1]}),id:c[2],...metadata,reasonDigest:await hash(reason),resourceId:c[2]};
  receiptPath='/v1/operations/community/content/'+c[1]+'/'+c[2]+'/operations/'+x.operationId;readPermission='content.read';
 }else if(path==='/v1/operations/community/content/visibility/batch'){
  const x=parse(operationsContentBatchSchema,body),{reason,...metadata}=x;
  action='community-content-batch-visibility';selection={...metadata,reasonDigest:await hash(reason)};
  receiptPath='/v1/operations/community/content/operations/'+x.operationId;readPermission='content.read';
 }else if(t){
  const x=parse(t[1]?operationsTagUpdateSchema:operationsTagCreateSchema,body);
  action=t[1]?'community-tag-update':'community-tag-create';
  selection={...(t[1]?{id:t[1]}:{}),operationId:x.operationId,expectedVersion:x.expectedVersion??null,nameDigest:x.name?await hash(x.name):null,enabled:x.enabled??null,...(t[1]?{resourceId:t[1]}:{})};
  receiptPath='/v1/operations/community/tags/operations/'+x.operationId;readPermission='content.tags.read';
 }else if(v){
  const x=parse(operationsVisibilitySchema,body);
  action='resource-visibility';selection={kind:v[1],id:v[2],command:x,operationId:x.operationId,resourceId:v[2]};
  receiptPath='/v1/operations/resources/'+v[1]+'/'+v[2]+'/operations/'+x.operationId;readPermission='resources.read';
 }else throw Error('Invalid original governance path');
 parse(id,body?.operationId);
 return {action,selection,receiptPath,readPermission,operationId:body.operationId,intentHash:await governanceReceiptHash(action,selection,hash)};
}

