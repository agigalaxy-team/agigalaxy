import { randomUUID } from 'node:crypto';
import { compactVerify, importSPKI } from 'jose';
import { z } from 'zod';
import { transaction } from "../infrastructure/database.mjs";
import { migrations, assertSupportedSchema } from '../infrastructure/migrations.mjs';
import { deletionIntentSchema } from '../shared/deletion-schema.mjs';
import { deletionReviewSchema,retainedOperatorPayload } from './deletion-review.mjs';
import { lockDeletionTables, executeDeletionInTransaction } from './deletion-execute.mjs';
import { digest } from '../shared/digest.mjs';
import { readDeletionEventPayload } from '../shared/deletion-event-payload.mjs';
import { deletionMinimizationEventSchema } from '../shared/deletion-minimization-schema.mjs';
import { verifyIdentityControlChain } from '../verification/identity-control.mjs';

const limit=20*1024*1024;
export const deletionLedgerColumns={
  deletion_requests:['id','subject_id','binding_id','requester_public_key','payload_text','payload_hash','signature','state','revision','created_at','updated_at','execution_result','minimized_at'],
  deletion_events:['id','request_id','revision','actor_kind','actor_ref','kind','payload_text','payload_hash','signature','created_at','payload_minimized','retained_payload','retained_hash','signer_public_key','signer_control_chain'],
  deletion_executions:['id','request_id','subject_id','command_hash','result','created_at'],
};
const columns=deletionLedgerColumns;
const jsonColumns=new Set(['execution_result','result','retained_payload','signer_control_chain']);
const normalized=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]))):value;
const equal=(a,b)=>JSON.stringify(canonical(normalized(a)))===JSON.stringify(canonical(normalized(b)));
const endpointSchema=z.url().refine(value=>value.startsWith('https://')&&new URL(value).origin===value);
const ledgerSchema=z.object({version:z.literal(1),schema:z.number().int(),endpoint:endpointSchema,capturedAt:z.number().int().nonnegative(),
  tables:z.object(Object.fromEntries(Object.keys(columns).map(name=>[name,z.array(z.record(z.string(),z.unknown())).max(100000)]))).strict()}).strict();
export const deletionReplaySchema=z.object({version:z.literal(1),id:z.uuid(),recoveryId:z.uuid(),endpoint:endpointSchema,ledgerSha256:z.string().regex(/^[a-f0-9]{64}$/),
  capturedNotBefore:z.number().int().nonnegative(),executorRef:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)}).strict();

// Separate from the ordinary database backup. Keep this exact bounded artifact
// and its digest in an independently protected operator-selected location.
export async function captureDeletionLedger(database,{endpoint,now=()=>Math.floor(Date.now()/1000)}){
  endpointSchema.parse(endpoint);
  return transaction(database,async db=>{
    // Freeze ledger writers before assigning the cutoff. A repeatable-read
    // snapshot followed by a later timestamp would falsely cover unseen writes.
    await db.query('LOCK TABLE deletion_events,deletion_executions,deletion_requests,schema_migrations IN SHARE MODE');
    assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    let total=0;const tables={};
    for(const [name,fields] of Object.entries(columns)){
      const size=(await db.query(`SELECT count(*) AS count,COALESCE(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM ${name} t`)).rows[0];
      total+=Number(size.bytes);if(total>limit/2||Number(size.count)>100000)throw new Error('Deletion ledger exceeds capture limit');
      tables[name]=normalized((await db.query(`SELECT ${fields.join(',')} FROM ${name} ORDER BY id`)).rows);
    }
    const ledger={version:1,schema:migrations.at(-1).version,endpoint,capturedAt:now(),tables};
    await validateDeletionLedger(ledger);
    const payloadJson=JSON.stringify(ledger);if(Buffer.byteLength(payloadJson)>limit)throw new Error('Deletion ledger exceeds capture limit');
    return {payloadJson,sha256:digest(payloadJson),capturedAt:ledger.capturedAt,bytes:Buffer.byteLength(payloadJson),requests:tables.deletion_requests.length};
  });
}

async function verifyIntent(row,key,endpoint,subjectId){
  const verified=await compactVerify(row.signature,key,{algorithms:['Ed25519']});
  if(verified.protectedHeader.typ!=='galaxy-deletion-intent+jws'||Object.keys(verified.protectedHeader).sort().join(',')!=='alg,typ'
    ||Buffer.from(verified.payload).toString('utf8')!==row.payload_text||digest(row.payload_text)!==row.payload_hash)throw new Error('Deletion ledger signature mismatch');
  const intent=deletionIntentSchema.parse(JSON.parse(row.payload_text));
  if(intent.subjectId!==subjectId||intent.endpoint!==endpoint||intent.id!==row.id)throw new Error('Deletion ledger identity mismatch');return intent;
}

export async function validateDeletionLedger(input){
  const ledger=ledgerSchema.parse(input);
  if(ledger.schema!==migrations.at(-1).version)throw new Error('Deletion ledger schema mismatch');
  for(const [name,rows] of Object.entries(ledger.tables)){
    const ids=new Set();
    for(const row of rows){
      if(!z.uuid().safeParse(row.id).success||ids.has(row.id)||!equal(Object.keys(row).sort(),[...columns[name]].sort((a,b)=>a.localeCompare(b))))throw new Error('Deletion ledger row shape mismatch');ids.add(row.id);
    }
  }
  const events=new Map(),executions=new Map(ledger.tables.deletion_executions.map(row=>[row.id,row]));
  for(const event of ledger.tables.deletion_events){const list=events.get(event.request_id)??[];list.push(event);events.set(event.request_id,list);}
  let executionCount=0;
  for(const request of ledger.tables.deletion_requests){
    const key=await importSPKI(request.requester_public_key,'Ed25519');
    const original=await verifyIntent(request,key,ledger.endpoint,request.subject_id);
    if(original.action!=='request'||original.bindingId!==request.binding_id)throw new Error('Deletion ledger request mismatch');
    const history=events.get(request.id)??[];history.sort((a,b)=>a.revision-b.revision);events.delete(request.id);
    let state=null,lastExecution=null;const approvals=new Set();
    for(let index=0;index<history.length;index++){
      const event=history[index];if(event.revision!==index+1)throw new Error('Deletion ledger history gap');
      const payload=readDeletionEventPayload(event);
      if(event.actor_kind==='subject'){
        let signingKey=key;
        if(event.signer_control_chain){
          const control=await verifyIdentityControlChain(event.signer_control_chain);
          if(control.subjectId!==request.subject_id||!control.devices.some(device=>device.publicKey===event.signer_public_key
            &&(device.scopes.includes('*')||device.scopes.includes('data-delete'))))throw new Error('Deletion ledger controller mismatch');
          signingKey=await importSPKI(event.signer_public_key,'Ed25519');
        }else if(event.signer_public_key&&event.signer_public_key!==request.requester_public_key)throw new Error('Deletion ledger control chain required');
        const intent=await verifyIntent(event,signingKey,ledger.endpoint,request.subject_id);
        if(event.actor_ref!==request.subject_id||intent.action!==event.kind)throw new Error('Deletion ledger actor mismatch');
        if(event.kind==='request'){
          if(index!==0||event.id!==request.id||event.signature!==request.signature||event.payload_text!==request.payload_text)throw new Error('Deletion ledger original mismatch');state='requested';
        }else{
          if(!['requested','review-needed','approved'].includes(state)||intent.requestId!==request.id||intent.expectedRevision!==index)throw new Error('Deletion ledger cancellation mismatch');state='cancelled';
        }
      }else if(event.actor_kind==='operator'&&event.signature===null){
        if(event.kind==='minimize'){
          const minimized=deletionMinimizationEventSchema.parse(payload);
          if(!['cancelled','rejected','primary-erased'].includes(state)||minimized.id!==event.id||minimized.requestId!==request.id||minimized.endpoint!==ledger.endpoint
            ||minimized.expectedRevision!==index||minimized.operatorRef!==event.actor_ref)throw new Error('Deletion minimization event mismatch');
        }else if(event.kind==='execute'){
          const execution=executions.get(event.id);
          if(!['approved','partial','primary-erased'].includes(state)||!execution||execution.request_id!==request.id||execution.subject_id!==request.subject_id
            ||!equal(execution.result,payload)||!approvals.has(payload.approvalId)||payload.id!==event.id||payload.requestId!==request.id||payload.subjectId!==request.subject_id
            ||payload.endpoint!==ledger.endpoint||payload.revision!==event.revision||!['partial','primary-erased'].includes(payload.state)||!/^[a-f0-9]{64}$/.test(execution.command_hash)
            ||event.payload_minimized&&payload.originalResultSha256!==event.payload_hash)throw new Error('Deletion ledger execution mismatch');
          state=payload.state;lastExecution=payload;executionCount++;
        }else{
          const review=deletionReviewSchema.parse(payload);
          if(!['requested','review-needed'].includes(state)||review.id!==event.id||review.requestId!==request.id||review.endpoint!==ledger.endpoint||review.expectedRevision!==index
            ||review.reviewerRef!==event.actor_ref||review.decision!==event.kind)throw new Error('Deletion ledger review mismatch');
          state={'needs-information':'review-needed',approve:'approved',reject:'rejected'}[review.decision];if(state==='approved')approvals.add(event.id);
        }
      }else throw new Error('Deletion ledger actor mismatch');
    }
    if(!history.length||request.revision!==history.length||request.state!==state||!equal(request.execution_result,lastExecution))throw new Error('Deletion ledger current state mismatch');
  }
  if(events.size||executionCount!==executions.size)throw new Error('Deletion ledger contains unlinked records');
  return ledger;
}

export async function replayDeletionLedger(database,payloadJson,input,{now=()=>Math.floor(Date.now()/1000)}={}){
  const command=deletionReplaySchema.parse(input),commandHash=digest(JSON.stringify(command));
  if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson)>limit||digest(payloadJson)!==command.ledgerSha256)throw new Error('Deletion ledger digest mismatch');
  const ledger=await validateDeletionLedger(JSON.parse(payloadJson));
  if(ledger.endpoint!==command.endpoint||ledger.capturedAt<command.capturedNotBefore||ledger.capturedAt>now())throw new Error('Deletion ledger cutoff or endpoint mismatch');
  return transaction(database,async db=>{
    assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    const inventory=await lockDeletionTables(db);
    const recovery=(await db.query('SELECT * FROM recovery_state WHERE singleton=true')).rows[0];
    if(recovery?.status!=='quarantined'||recovery.recovery_id!==command.recoveryId)throw new Error('Exact quarantined recovery required');
    const prior=(await db.query('SELECT * FROM deletion_replays WHERE recovery_id=$1 OR id=$2',[command.recoveryId,command.id])).rows;
    if(prior.length){if(prior.length!==1||prior[0].id!==command.id||prior[0].command_hash!==commandHash)throw new Error('Recovery already replayed; use its original command or a fresh restore');return prior[0].result;}
    // The source must include every record present in the older backup. Mutable
    // request state is reconstructed only from its complete validated history.
    const existing={},sourceEvents=new Map(ledger.tables.deletion_events.map(row=>[row.id,row]));
    for(const [name,fields] of Object.entries(columns)){
      const source=new Map(ledger.tables[name].map(row=>[row.id,row]));
      const rows=normalized((await db.query(`SELECT ${fields.join(',')} FROM ${name}`)).rows);existing[name]=new Set(rows.map(row=>row.id));
      for(const row of rows){const later=source.get(row.id);
        let immutable=name==='deletion_requests'?fields.filter(field=>!['state','revision','updated_at','execution_result','minimized_at'].includes(field)):fields;
        if(name==='deletion_events'&&later?.payload_minimized){
          immutable=fields.filter(field=>!['payload_text','payload_minimized','retained_payload','retained_hash'].includes(field));
          if(!equal(row.payload_minimized?row.retained_payload:retainedOperatorPayload(row),later.retained_payload))throw new Error('Minimized event diverges from backup');
        }
        if(name==='deletion_executions'&&sourceEvents.get(row.id)?.payload_minimized){
          immutable=fields.filter(field=>field!=='result');
          if(later?.result?.originalResultSha256!==sourceEvents.get(row.id).payload_hash)throw new Error('Compacted execution hash mismatch');
        }
        if(!later||immutable.some(field=>!equal(row[field],later[field]))||name==='deletion_requests'&&row.revision>later.revision)throw new Error('Source deletion ledger is incomplete or diverges from backup');
      }
    }
    // Existing active requests may now be cancelled and followed by another one;
    // update those states before inserting newly active requests.
    for(const row of ledger.tables.deletion_requests)if(existing.deletion_requests.has(row.id))await db.query(
      'UPDATE deletion_requests SET state=$2,revision=$3,updated_at=$4,execution_result=$5::jsonb,minimized_at=$6 WHERE id=$1',[row.id,row.state,row.revision,row.updated_at,JSON.stringify(row.execution_result),row.minimized_at]);
    for(const row of ledger.tables.deletion_events)if(existing.deletion_events.has(row.id)&&row.payload_minimized)await db.query(
      "UPDATE deletion_events SET payload_text='',payload_minimized=true,retained_payload=$2::jsonb,retained_hash=$3 WHERE id=$1",[row.id,JSON.stringify(row.retained_payload),row.retained_hash]);
    for(const row of ledger.tables.deletion_executions)if(existing.deletion_executions.has(row.id)&&sourceEvents.get(row.id)?.payload_minimized)await db.query(
      'UPDATE deletion_executions SET result=$2::jsonb WHERE id=$1',[row.id,JSON.stringify(row.result)]);
    for(const [name,fields] of Object.entries(columns))for(const row of ledger.tables[name])if(!existing[name].has(row.id))await db.query(
      `INSERT INTO ${name}(${fields.join(',')}) VALUES(${fields.map((field,i)=>'$'+(i+1)+(jsonColumns.has(field)?'::jsonb':'')).join(',')})`,fields.map(field=>jsonColumns.has(field)&&row[field]!==null?JSON.stringify(row[field]):row[field]));
    const results=[],targets=ledger.tables.deletion_requests.filter(request=>request.execution_result);
    // A later owner's replay may release a reference that blocked an earlier
    // one. Iterate to a fixed point; retained or cyclic references remain counted.
    for(let pass=0;pass<=targets.length;pass++){
    let removed=0;
    for(const request of targets){
      // Approval alone is never interpreted as an executed deletion.
      if(!request.execution_result)continue;
      const current=(await db.query('SELECT state,revision FROM deletion_requests WHERE id=$1',[request.id])).rows[0];
      if(pass>0&&current.state!=='partial')continue;
      const result=await executeDeletionInTransaction(db,{version:1,id:randomUUID(),requestId:request.id,approvalId:request.execution_result.approvalId,
        endpoint:command.endpoint,expectedRevision:current.revision,executorRef:command.executorRef},
        {now,inventory,recoveryContext:{recoveryId:command.recoveryId,ledgerSha256:command.ledgerSha256,sourceCapturedAt:ledger.capturedAt}});
      results.push({requestId:request.id,executionId:result.id,state:result.state,deletedCounts:result.deletedCounts,remainingCounts:result.remainingCounts});
      removed+=Object.values(result.deletedCounts).reduce((sum,n)=>sum+n,0);
    }
    if(!removed)break;
    }
    const result={version:1,id:command.id,recoveryId:command.recoveryId,endpoint:command.endpoint,ledgerSha256:command.ledgerSha256,sourceCapturedAt:ledger.capturedAt,
      replayedAt:now(),requestsImported:ledger.tables.deletion_requests.length,requestsReplayed:targets.length,executionsReplayed:results.length,results,quarantined:true,publicActivationReady:false,
      sourceFreshness:'at-explicit-capture-cutoff-only',serviceWideDeletionComplete:false};
    await db.query('INSERT INTO deletion_replays(id,recovery_id,source_digest,command_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',[command.id,command.recoveryId,command.ledgerSha256,commandHash,JSON.stringify(result)]);
    return result;
  });
}
