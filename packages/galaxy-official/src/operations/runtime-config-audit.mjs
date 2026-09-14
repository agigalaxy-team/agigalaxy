import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { governanceConfigSchema } from '../governance-config.mjs';
import { retirementPolicySchema } from '../retirement.mjs';
import { transaction } from '../database.mjs';
import { digest } from '../shared/digest.mjs';
import { governanceConfigurationHash,governanceReviewRecordSchema } from './governance-review.mjs';
import { incidentPolicySchema,assertIncidentTransition } from './incident.mjs';
import { honorRegistrySchema,honorRegistryManifest,storeHonorRuleVersions } from '../infrastructure/honor-rule-registry.mjs';
import { qualificationRegistrySchema,qualificationRegistryManifest,assertQualificationVersions } from '../infrastructure/qualification-policy-registry.mjs';
import { experienceReviewerRegistry } from '../infrastructure/experience-reviewer-registry.mjs';

const canonical=value=>JSON.stringify(normalize(value));
function normalize(value){return value instanceof Date?value.toISOString():Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;}
const hash=value=>digest(canonical(value));
const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const endpointSchema=z.url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;});
const roleFields=['auditReaderIds','auditReviewerIds','builderAssessorIds','moderatorIds'];

// Build from the already loaded values used by this process, never from an
// environment dump or a second read of a possibly changed configuration file.
export function runtimeConfigSnapshot({governance,governanceReview=null,incident,retirement=null,release=null,signingKeyId=null,trustSequence=null,requestQuotaHash,communityQuotaHash,browserPolicyHash,chatConfigurationHash,resourceBudgetHash,searchIndexMode,network,identityConfigurationHash,personalMcpConfigurationHash}){
  const result={version:1,governance:null,retirement:null,release:null,signingKeyId,trustSequence};
  if(requestQuotaHash!==undefined)result.requestQuotaHash=requestQuotaHash;
  if(communityQuotaHash!==undefined)result.communityQuotaHash=communityQuotaHash;
  if(browserPolicyHash!==undefined)result.browserPolicyHash=browserPolicyHash;
  if(chatConfigurationHash!==undefined)result.chatConfigurationHash=chatConfigurationHash;
  if(resourceBudgetHash!==undefined)result.resourceBudgetHash=resourceBudgetHash;
  if(searchIndexMode!==undefined)result.searchIndexMode=searchIndexMode;
  if(network!==undefined)result.network=network;
  if(identityConfigurationHash!==undefined)result.identityConfigurationHash=identityConfigurationHash;
  if(personalMcpConfigurationHash!==undefined)result.personalMcpConfigurationHash=personalMcpConfigurationHash;
  if(incident!==undefined){const p=incident===null?null:incidentPolicySchema.parse(incident);result.incident=p?{id:p.id,revision:p.revision,state:p.state,updatedAt:p.updatedAt,sha256:hash(p)}:null;}
  if(governance){
    const config=governanceConfigSchema.parse(governance);
    result.governance={configurationSha256:governanceConfigurationHash(config),review:governanceReview,roles:Object.fromEntries(roleFields.map(key=>[key,[...new Set(config[key])].sort((a,b)=>a.localeCompare(b))])),
      policyHashes:Object.fromEntries(['honorRules','qualificationPolicies','conformanceSuitePins'].map(key=>[key,hash(config[key])]))};
  }
  if(retirement){const policy=retirementPolicySchema.parse(retirement);result.retirement={id:policy.id,sha256:hash(policy),announcedAt:policy.announcedAt,stopWritesAt:policy.stopWritesAt,takeoutUntil:policy.takeoutUntil,statusUntil:policy.statusUntil};}
  if(release)result.release={id:release.releaseId,configurationVersion:release.configurationVersion,manifestSha256:release.manifestSha256};
  return snapshotSchema.parse(result);
}
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema=z.object({version:z.literal(1),incident:z.object({id:ref,revision:z.number().int().positive(),state:z.enum(['contained','recovery','resolved']),updatedAt:z.number().int().nonnegative(),sha256:sha}).strict().nullable().optional(),requestQuotaHash:sha.optional(),resourceBudgetHash:sha.optional(),identityConfigurationHash:sha.optional(),governance:z.object({configurationSha256:sha.optional(),review:governanceReviewRecordSchema.nullable().optional(),roles:z.object(Object.fromEntries(roleFields.map(key=>[key,z.array(z.string().regex(/^GUID[0-9A-Z]{28}$/)).max(128)]))).strict(),policyHashes:z.object({honorRules:sha,qualificationPolicies:sha,conformanceSuitePins:sha}).strict()}).strict().nullable(),
  retirement:z.object({id:ref,sha256:sha,announcedAt:z.number().int().nonnegative(),stopWritesAt:z.number().int().nonnegative(),takeoutUntil:z.number().int().nonnegative(),statusUntil:z.number().int().nonnegative()}).strict().nullable(),
  searchIndexMode:z.enum(['enabled','disabled','unconfigured']).optional(),communityQuotaHash:sha.optional(),browserPolicyHash:sha.optional(),chatConfigurationHash:sha.nullable().optional(),honorRegistry:honorRegistrySchema.optional(),qualificationRegistry:qualificationRegistrySchema.optional(),personalMcpConfigurationHash:sha.nullable().optional(),
  experienceReviewerRegistry:z.object({version:z.literal(1),reviewers:z.array(z.object({subjectId:z.string().regex(/^GUID[0-9A-Z]{28}$/),definitionHash:sha}).strict()).max(128)}).strict().optional(),
  network:z.object({type:z.enum(['official','hub']),manifestSha256:sha}).strict().optional(),
  release:z.object({id:ref,configurationVersion:ref,manifestSha256:sha}).strict().nullable(),signingKeyId:z.string().min(1).max(200).nullable(),trustSequence:z.number().int().nonnegative().nullable()}).strict();
const inputSchema=z.object({id:z.uuid(),endpoint:endpointSchema,component:z.enum(['api','worker']),operatorRef:ref.default('unattributed-runtime'),snapshot:snapshotSchema}).strict();
function difference(previous,next){
  const changedSections=Object.keys(next).filter(key=>canonical(previous?.[key]??null)!==canonical(next[key]));
  const roles=Object.fromEntries(roleFields.map(key=>{const before=previous?.governance?.roles[key]??[],after=next.governance?.roles[key]??[];return [key,{added:after.filter(id=>!before.includes(id)),removed:before.filter(id=>!after.includes(id))}];}));
  return {changedSections,roles};
}

export async function recordRuntimeConfig(database,input,{now=()=>Math.floor(Date.now()/1000)}={}){
  const {honorRules,qualificationPolicies,experienceReviewers,...raw}=input;
  if(experienceReviewers!==undefined){
    if(raw.component!=='api')throw new Error('Experience reviewers require API runtime');
    const reviewers=governanceConfigSchema.parse({experienceReviewers}).experienceReviewers;
    if(new Set(reviewers.map(r=>r.subjectId)).size!==reviewers.length)throw new Error('Duplicate experience reviewer');
    raw.snapshot={...raw.snapshot,experienceReviewerRegistry:experienceReviewerRegistry(reviewers)};
  }else if(raw.snapshot?.experienceReviewerRegistry)throw new Error('Experience registry observation requires loaded definitions');
  let rules;
  if(honorRules!==undefined){
    rules=governanceConfigSchema.parse({honorRules}).honorRules;
    if(raw.component!=='api'||hash(rules)!==raw.snapshot.governance?.policyHashes.honorRules)throw new Error('Honor rules do not match loaded governance');
    raw.snapshot={...raw.snapshot,honorRegistry:honorRegistryManifest(rules)};
  }else if(raw.snapshot?.honorRegistry)throw new Error('Honor registry observation requires loaded definitions');
  if(qualificationPolicies!==undefined){
    const policies=governanceConfigSchema.parse({qualificationPolicies}).qualificationPolicies;
    if(raw.component!=='api'||hash(policies)!==raw.snapshot.governance?.policyHashes.qualificationPolicies)throw new Error('Qualification policies do not match loaded governance');
    raw.snapshot={...raw.snapshot,qualificationRegistry:qualificationRegistryManifest(policies)};
  }else if(raw.snapshot?.qualificationRegistry)throw new Error('Qualification registry observation requires loaded definitions');
  const command=inputSchema.parse({...raw,id:input.id??randomUUID()}),commandHash=hash(command);
  return transaction(database,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(734912308)');
    const prior=(await db.query('SELECT * FROM runtime_config_events WHERE id=$1',[command.id])).rows[0];
    if(prior){if(prior.command_hash!==commandHash)throw new Error('Runtime configuration operation conflict');return prior;}
    const previous=(await db.query('SELECT * FROM runtime_config_events WHERE endpoint=$1 AND component=$2 ORDER BY sequence DESC LIMIT 1',[command.endpoint,command.component])).rows[0];
    if(previous)verifyRuntimeConfigEvent(previous);
    if(previous?.payload.snapshot.honorRegistry&&!command.snapshot.honorRegistry)throw new Error('Honor registry cannot silently become memory-only');
    if(previous?.payload.snapshot.qualificationRegistry&&!command.snapshot.qualificationRegistry)throw new Error('Qualification registry cannot silently become memory-only');
    if(previous?.payload.snapshot.experienceReviewerRegistry&&!command.snapshot.experienceReviewerRegistry)throw new Error('Experience registry cannot silently become memory-only');
    if(command.snapshot.qualificationRegistry)await assertQualificationVersions(db,command.endpoint,command.snapshot.qualificationRegistry);
    assertIncidentTransition(previous?.payload.snapshot.incident,command.snapshot.incident);
    const priorGovernance=previous?.payload.snapshot.governance,governance=command.snapshot.governance;
    const oldReview=priorGovernance?.review,newReview=governance?.review;
    if(oldReview&&!newReview)throw new Error('Reviewed governance cannot silently become unsigned');
    if(newReview){
      if(newReview.endpoint!==command.endpoint||newReview.configurationSha256!==governance.configurationSha256)throw new Error('Governance review observation mismatch');
      if(oldReview?.changeId===newReview.changeId){
        if(canonical(oldReview)!==canonical(newReview)||priorGovernance.configurationSha256!==governance.configurationSha256)throw new Error('Governance change ID conflict');
      }else if(newReview.revision!==(oldReview?.revision??0)+1||newReview.previousConfigurationSha256!==(priorGovernance?.configurationSha256??null))throw new Error('Governance revision or previous configuration mismatch');
    }
    const observedAt=z.number().int().nonnegative().parse(now());
    const payload={...command,commandHash,observedAt,previousHash:previous?.event_hash??null,configurationHash:hash(command.snapshot),changes:difference(previous?.payload.snapshot,command.snapshot),
      attribution:'runtime-provided-operator-reference',outcome:'loaded-before-serving'};
    const eventHash=hash(payload);
    const row=(await db.query('INSERT INTO runtime_config_events(id,endpoint,component,command_hash,payload,event_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *',
      [command.id,command.endpoint,command.component,commandHash,JSON.stringify(payload),eventHash])).rows[0];
    if(rules)await storeHonorRuleVersions(db,{endpoint:command.endpoint,runtimeEventId:row.id,rules});
    await db.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,audience,scope,idempotency_key)
      VALUES($1,'runtime.config.observe',$2,$2,'loaded-before-serving',$3,$4,'operations/config',$2)`,['operator:'+command.operatorRef,command.id,command.component,command.endpoint]);
    return row;
  });
}
export function verifyRuntimeConfigEvent(row){
  const p=row.payload,parsed=inputSchema.parse({id:p.id,endpoint:p.endpoint,component:p.component,operatorRef:p.operatorRef,snapshot:p.snapshot});
  if(row.id!==p.id||row.endpoint!==p.endpoint||row.component!==p.component||row.command_hash!==hash(parsed)||p.commandHash!==row.command_hash
    ||p.configurationHash!==hash(p.snapshot)||row.event_hash!==hash(p))throw new Error('Runtime configuration event mismatch');
  return row;
}
export async function exportRuntimeConfigPage(database,input){
  return transaction(database,db=>prepareArchivePage(db,input));
}
async function prepareArchivePage(database,{endpoint,component,after=0,limit=100,operatorRef='unattributed-runtime'}){
  ref.parse(operatorRef);
  endpointSchema.parse(endpoint);z.enum(['api','worker']).parse(component);z.number().int().nonnegative().parse(after);z.number().int().min(1).max(1000).parse(limit);
  const rows=(await database.query('SELECT * FROM runtime_config_events WHERE endpoint=$1 AND component=$2 AND sequence>$3 ORDER BY sequence LIMIT $4',[endpoint,component,after,limit+1])).rows;
  const events=rows.slice(0,limit).map(verifyRuntimeConfigEvent);
  const anchor=after?(await database.query('SELECT * FROM runtime_config_events WHERE endpoint=$1 AND component=$2 AND sequence=$3',[endpoint,component,after])).rows[0]:null;
  if(after&&!anchor)throw new Error('Runtime configuration archive cursor unavailable');
  if(anchor)verifyRuntimeConfigEvent(anchor);
  if(events.length&&events[0].payload.previousHash!==(anchor?.event_hash??null))throw new Error('Runtime configuration archive anchor mismatch');
  for(let i=1;i<events.length;i++)if(events[i].payload.previousHash!==events[i-1].event_hash)throw new Error('Runtime configuration chain mismatch');
  const archiveId=randomUUID();
  const page={version:1,archiveId,operatorRef,endpoint,component,after,events,hasMore:rows.length>limit,nextCursor:events.length?Number(events.at(-1).sequence):after,
    previousHash:events[0]?.payload.previousHash??null,lastHash:events.at(-1)?.event_hash??null,independentlySigned:false};
  const sha256=hash(page);
  await database.query(`INSERT INTO audit_events(actor,action,object_id,request_id,outcome,client_id,audience,scope,idempotency_key)
    VALUES($1,'runtime.config.export',$2,$3,'archive-prepared',$4,$5,'operations/config',$3)`,['operator:'+operatorRef,sha256,archiveId,component,endpoint]);
  return {...page,sha256};
}
