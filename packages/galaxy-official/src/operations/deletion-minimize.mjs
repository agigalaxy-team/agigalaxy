import { transaction } from "../infrastructure/database.mjs";
import { migrations,assertSupportedSchema } from '../infrastructure/migrations.mjs';
import { digest } from '../shared/digest.mjs';
import { readDeletionEventPayload,retainedPayloadHash } from '../shared/deletion-event-payload.mjs';
import { deletionMinimizationSchema,deletionMinimizationEventSchema } from '../shared/deletion-minimization-schema.mjs';
import { deletionReviewSchema,retainedOperatorPayload } from './deletion-review.mjs';
import { deletionLedgerColumns,validateDeletionLedger } from './deletion-ledger.mjs';
import { lockDeletionTables } from './deletion-execute.mjs';
import { deletionReceipt } from "../privacy/deletion.mjs";

export async function minimizeDeletionReceipt(database,input,{now=()=>Math.floor(Date.now()/1000)}={}){
  const command=deletionMinimizationSchema.parse(input),commandHash=digest(JSON.stringify(command));
  return transaction(database,async db=>{
    assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);await lockDeletionTables(db);
    const row=(await db.query('SELECT * FROM deletion_requests WHERE id=$1',[command.requestId])).rows[0];
    if(!row||JSON.parse(row.payload_text).endpoint!==command.endpoint)throw new Error('Minimization target mismatch');
    const prior=(await db.query('SELECT * FROM deletion_events WHERE id=$1',[command.id])).rows[0];
    if(prior){const payload=readDeletionEventPayload(prior);if(prior.kind!=='minimize'||prior.request_id!==row.id||payload.commandHash!==commandHash)throw new Error('Minimization ID conflict');return {...deletionReceipt(row,command.endpoint),minimization:payload};}
    if(row.revision!==command.expectedRevision||!['cancelled','rejected','primary-erased'].includes(row.state))throw new Error('Minimization request is not terminal or changed');
    if(row.execution_result&&Object.values(row.execution_result.remainingCounts).some(count=>count!==0))throw new Error('Retained data must be resolved before minimization');
    const tables={};
    for(const [name,fields] of Object.entries(deletionLedgerColumns))tables[name]=JSON.parse(JSON.stringify((await db.query(
      `SELECT ${fields.join(',')} FROM ${name} WHERE ${name==='deletion_requests'?'id':'request_id'}=$1 ORDER BY ${name==='deletion_events'?'revision':'id'}`,[row.id])).rows));
    await validateDeletionLedger({version:1,schema:migrations.at(-1).version,endpoint:command.endpoint,capturedAt:now(),tables});
    let until=command.policy.notBefore;
    for(const event of tables.deletion_events)if(event.kind==='approve'){
      const plan=deletionReviewSchema.parse(readDeletionEventPayload(event)).plan;until=Math.max(until,plan.audit.until,plan.backups.until);
    }
    const at=now();if(!Number.isSafeInteger(at)||at<until)throw new Error('Receipt minimization is not due');
    let eventsMinimized=0,executionResultsCompacted=0,payloadBytesRemoved=0,lastExecution=row.execution_result;
    for(const event of tables.deletion_events){
      if(event.actor_kind!=='operator'||event.kind==='minimize'||event.payload_minimized)continue;
      const retained=retainedOperatorPayload(event);
      if(event.kind==='execute'){
        executionResultsCompacted++;
        await db.query('UPDATE deletion_executions SET result=$2::jsonb WHERE id=$1',[event.id,JSON.stringify(retained)]);
        if(row.execution_result?.id===event.id)lastExecution=retained;
      }
      await db.query("UPDATE deletion_events SET payload_text='',payload_minimized=true,retained_payload=$2::jsonb,retained_hash=$3 WHERE id=$1",[event.id,JSON.stringify(retained),retainedPayloadHash(retained)]);
      eventsMinimized++;payloadBytesRemoved+=Buffer.byteLength(event.payload_text);
    }
    const payload=deletionMinimizationEventSchema.parse({...command,policy:{id:command.policy.id,version:command.policy.version,notBefore:command.policy.notBefore,basisHash:digest(command.policy.basis)},
      commandHash,at,eventsMinimized,executionResultsCompacted,payloadBytesRemoved});
    const text=JSON.stringify(payload);
    const updated=(await db.query('UPDATE deletion_requests SET revision=revision+1,execution_result=$2::jsonb,minimized_at=$3,updated_at=$3 WHERE id=$1 RETURNING *',
      [row.id,JSON.stringify(lastExecution),new Date(at*1000).toISOString()])).rows[0];
    await db.query("INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash) VALUES($1,$2,$3,'operator',$4,'minimize',$5,$6)",
      [command.id,row.id,updated.revision,command.operatorRef,text,digest(text)]);
    return {...deletionReceipt(updated,command.endpoint),minimization:payload};
  });
}
