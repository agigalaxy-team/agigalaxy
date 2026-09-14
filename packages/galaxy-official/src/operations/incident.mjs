import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import * as z from 'zod/v4';
import { ServiceError } from '../shared/service-error.mjs';
import { serviceAccessV2 } from './service-access-v2.mjs';

const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const incidentPolicySchema=z.strictObject({
  version:z.literal(1),id:ref,revision:z.number().int().positive(),
  endpoint:z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;}),
  state:z.enum(['contained','recovery','resolved']),updatedAt:z.number().int().nonnegative(),
  publicMessage:z.string().trim().min(1).max(1200),
  recovery:z.strictObject({checkedAt:z.number().int().nonnegative(),evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/)}).nullable().default(null),
}).refine(value=>value.state!=='resolved'||value.recovery!==null&&value.recovery.checkedAt<=value.updatedAt);

const publicReads=new Set(['/v1/service-status','/v1/policy','/.well-known/galaxy-signing-keys.json','/v1/signing-keys/status']);
const responsePosts=new Set(['/v1/identity/query','/v1/identity/cancel','/v1/identity/revoke','/v1/session-challenges','/v1/sessions','/v1/bindings/query','/v1/data-exports/revoke','/v1/audit/grants/revoke',
  '/v2/chat/attachments/revoke',
  '/v1/notifications/query','/v1/notifications/read','/v1/notifications/preferences/read','/v1/notifications/preferences/save',
  '/v1/deletion-requests/config','/v1/deletion-requests/submit','/v1/deletion-requests/status']);
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const revoke=new RegExp(`^/v1/(?:bindings|consents|proofs|context-grants)/${uuid}/revoke$`);

// Explicit startup configuration: no timer silently restores access and no
// public endpoint changes incident state. The normal handlers still authorize
// every permitted session, revocation and deletion operation.
export function createIncidentController(input=null,{endpoint,now=()=>Math.floor(Date.now()/1000)}={}){
  const policy=input===null?null:incidentPolicySchema.parse(input);
  if(policy&&(policy.endpoint!==endpoint||policy.updatedAt>now()))throw new Error('Incident endpoint or time mismatch');
  const canProcessEvidence=()=>!policy||policy.state==='resolved';
  const snapshot=()=>({version:1,id:policy?.id??null,revision:policy?.revision??null,state:policy?.state??'normal',
    updatedAt:policy?.updatedAt??null,publicMessage:policy?.publicMessage??null,
    businessWritesAccepted:canProcessEvidence(),sharingAccepted:canProcessEvidence(),
    notificationDelivery:'public-status-pull',checkedAt:now()});
  return Object.freeze({snapshot,canProcessEvidence,policy:()=>policy?structuredClone(policy):null,
    async assertBindingSubject(db,subjectId){
      if(!canProcessEvidence()&&!(await db.query('SELECT 1 FROM subjects WHERE id=$1',[subjectId])).rows.length)
        throw new ServiceError('service_enrollment_stopped',503);
    },
    assertRoute(method,path){
      const access=serviceAccessV2(method,path);
      if(access==='control'||access==='stop')return;
      if(canProcessEvidence()||method==='GET'&&publicReads.has(path)||method==='POST'&&(responsePosts.has(path)||revoke.test(path)))return;
      throw new ServiceError('service_incident_contained',503);
    }});
}

export async function loadIncidentController(path,options){
  if(!path)return createIncidentController(null,options);
  if(!isAbsolute(path))throw new Error('Incident file must be absolute');
  const info=await stat(path);
  if(!info.isFile()||info.size>16384)throw new Error('Invalid incident file');
  return createIncidentController(JSON.parse(await readFile(path,'utf8')),options);
}

// Reuse the append-only runtime configuration history, separately for API and
// Worker. Clearing a flag is not a recovery record; old snapshots stay valid.
export function assertIncidentTransition(previous,next){
  if(!previous){if(next?.state==='resolved')throw new Error('Incident recovery history missing');return;}
  if(!next){if(previous.state!=='resolved')throw new Error('Active incident cannot be removed');return;}
  if(previous.id!==next.id){if(previous.state!=='resolved'||next.state==='resolved')throw new Error('Active incident cannot be replaced');return;}
  if(next.revision===previous.revision&&next.sha256===previous.sha256)return;
  if(next.revision!==previous.revision+1||next.updatedAt<previous.updatedAt)throw new Error('Incident revision conflict');
}
