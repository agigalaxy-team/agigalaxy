import { compactVerify, importSPKI } from 'jose';
import { z } from 'zod';
import { transaction } from '../database.mjs';
import { assertSupportedSchema } from '../infrastructure/migrations.mjs';
import { deletionIntentSchema } from '../shared/deletion-schema.mjs';
import { deletionReviewSchema } from './deletion-review.mjs';
import { digest } from '../shared/digest.mjs';
import { readDeletionEventPayload } from '../shared/deletion-event-payload.mjs';
import { productV2DeletionTargets, controlHistoryTables, lifecycleManagedTables, chatDelegatedTables } from '../infrastructure/lifecycle-registry-v2.mjs';
import { prepareProductV2Deletion, minimizeRetainedProductContent } from './lifecycle-product-v2.mjs';

export const deletionExecutionSchema = z.object({ version:z.literal(1),id:z.uuid(),requestId:z.uuid(),approvalId:z.uuid(),
  endpoint:z.url(),expectedRevision:z.number().int().positive(),executorRef:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/) }).strict();
const ownsBinding = 't.binding_id IN (SELECT id FROM bindings WHERE subject_id=$1)';
const ownsEvidence = 't.evidence_id IN (SELECT id FROM evidence_submissions WHERE subject_id=$1)';
export const deletionTargets = {
  ...productV2DeletionTargets,
  external_identity_links:'t.subject_id=$1',
  builder_probes:'t.request_id IN (SELECT id FROM builder_events WHERE subject_id=$1)',
  search_documents:'t.subject_id=$1',
  profile_statements:'t.subject_id=$1',
  incident_notices:'t.subject_id=$1',
  subjects:'t.id=$1',binding_challenges:'t.subject_id=$1',bindings:'t.subject_id=$1',access_credentials:ownsBinding,session_challenges:ownsBinding,
  consents:'t.subject_id=$1',cases:'t.subject_id=$1',case_events:'t.subject_id=$1',evidence_submissions:'t.subject_id=$1',
  verification_attempts:ownsEvidence,proofs:'t.subject_id=$1',jobs:"t.payload->>'evidenceId' IN (SELECT id::text FROM evidence_submissions WHERE subject_id=$1) OR t.payload->>'ciRequestId' IN (SELECT id::text FROM ci_requests_v2 WHERE subject_id=$1) OR t.kind IN ('search-index','builder-probe') AND t.payload->>'subjectId'=$1",
  assistance_requests:'t.requester_id=$1',assistance_events:'t.subject_id=$1',context_grants:'t.subject_id=$1',context_acceptances:'t.subject_id=$1',
  notification_preferences:'t.subject_id=$1',notification_reads:'t.subject_id=$1',moderation_reports:'t.reporter_id=$1',moderation_events:'t.subject_id=$1',
  capsules:'t.subject_id=$1',capsule_events:'t.subject_id=$1',capsule_uses:'t.subject_id=$1',builders:'t.owner_id=$1',builder_events:'t.subject_id=$1',
  audit_events:'t.actor=$1 OR t.binding_id IN (SELECT id FROM bindings WHERE subject_id=$1)',audit_access_grants:'t.reviewer_id=$1',audit_reads:'t.actor_id=$1',
  data_exports:'t.subject_id=$1',data_export_reads:'t.subject_id=$1',
};
const auditTables = new Set(['audit_events','audit_access_grants','audit_reads','data_export_reads']);
// Issuer policy history is shared operator data. Retained membership references
// are counted in the receipt, rather than silently deleting another issuer's rule.
// The directory counter contains one global ordering number, no subject data.
// Each subject's individual read markers remain ordinary owned deletion targets.
const excluded = ['schema_migrations','search_index_control','chat_directory_clock','recovery_state','deletion_requests','deletion_events','deletion_executions','deletion_replays','runtime_config_events','honor_rule_versions', ...lifecycleManagedTables];
const quote = value => { if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error('Unsupported database identifier');return `"${value}"`; };
const counts = values => Object.fromEntries(Object.keys(deletionTargets).map(name=>[name,values[name]??0]));
const sum = values => Object.values(values).reduce((total,value)=>total+value,0);
const affected = result => { const value=result.rowCount??result.affectedRows;if(!Number.isSafeInteger(value)||value<0)throw new Error('Missing affected-row count');return value; };

export async function lockDeletionTables(db) {
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
  const mandatory = [...Object.keys(deletionTargets), ...excluded], known = new Set([...mandatory, ...chatDelegatedTables]);
  if(tables.some(table=>!known.has(table)) || mandatory.some(table=>!tables.includes(table)))throw new Error('Deletion inventory does not cover this database schema');
  // Maintenance transaction: writers/readers are drained by table locks. A lock
  // timeout/deadlock aborts the whole operation, so the same operation ID is safe.
  await db.query(`LOCK TABLE ${tables.map(name=>'public.'+quote(name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
  const primary = (await db.query(`SELECT r.relname AS name,a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type,k.ord
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num
    WHERE c.contype='p' AND n.nspname='public' ORDER BY r.relname,k.ord`)).rows;
  const keys = {};
  for(const key of primary){if(!Object.hasOwn(deletionTargets,key.name))continue;if(!['uuid','text','bigint','integer','date'].includes(key.type))throw new Error('Unsupported deletion primary key');(keys[key.name]??=[]).push(key);}
  const references = (await db.query(`SELECT target.relname AS target,source.relname AS source,ns.nspname AS source_schema,c.confdeltype AS action,
    sa.attname AS source_column,ta.attname AS target_column,c.oid::text AS constraint_id,k.ord
    FROM pg_constraint c JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace nt ON nt.oid=target.relnamespace
    JOIN pg_class source ON source.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=source.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(src,dst,ord)
    JOIN pg_attribute sa ON sa.attrelid=source.oid AND sa.attnum=k.src JOIN pg_attribute ta ON ta.attrelid=target.oid AND ta.attnum=k.dst
    WHERE c.contype='f' AND nt.nspname='public' ORDER BY c.oid,k.ord`)).rows;
  const constraints=new Map();
  for(const ref of references){if(ref.source_schema!=='public')throw new Error('External schema reference needs its own deletion plan');
    if(!constraints.has(ref.constraint_id))constraints.set(ref.constraint_id,{...ref,columns:[]});constraints.get(ref.constraint_id).columns.push(ref);}
  return {keys,constraints:[...constraints.values()]};
}

async function revoke(db,subjectId,now) {
  const result={},at=new Date(now*1000).toISOString();
  for(const [table,where] of Object.entries({bindings:'subject_id=$1',access_credentials:'binding_id IN (SELECT id FROM bindings WHERE subject_id=$1)',
    consents:'subject_id=$1',proofs:'subject_id=$1',context_grants:'subject_id=$1',audit_access_grants:'reviewer_id=$1',data_exports:'subject_id=$1',external_identity_links:'subject_id=$1'}))
    result[table]=affected(await db.query(`UPDATE ${quote(table)} SET revoked_at=$2 WHERE ${where} AND revoked_at IS NULL`,[subjectId,at]));
  await db.query("UPDATE evidence_submissions SET state='revoked' WHERE subject_id=$1",[subjectId]);
  for(const [table,where] of Object.entries({binding_challenges:'subject_id=$1',session_challenges:'binding_id IN (SELECT id FROM bindings WHERE subject_id=$1)'}))
    await db.query(`UPDATE ${quote(table)} SET expires_at=LEAST(expires_at,$2::timestamptz) WHERE ${where}`,[subjectId,at]);
  return result;
}

export async function executeDeletion(database,input,{now=()=>Math.floor(Date.now()/1000)}={}) {
  return transaction(database,db=>executeDeletionInTransaction(db,input,{now}));
}

// Internal maintenance composition; the caller owns the transaction and locks.
export async function executeDeletionInTransaction(db,input,{now=()=>Math.floor(Date.now()/1000),inventory,recoveryContext}={}) {
  const command=deletionExecutionSchema.parse(input),commandHash=digest(JSON.stringify(command));
    assertSupportedSchema((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows);
    const {keys,constraints}=inventory??await lockDeletionTables(db);
    const prior=(await db.query('SELECT command_hash,result FROM deletion_executions WHERE id=$1',[command.id])).rows[0];
    if(prior){if(prior.command_hash!==commandHash)throw new Error('Deletion execution ID conflict');return prior.result;}
    const request=(await db.query('SELECT * FROM deletion_requests WHERE id=$1 FOR UPDATE',[command.requestId])).rows[0];
    if(!request||request.revision!==command.expectedRevision||!['approved','partial','primary-erased'].includes(request.state))throw new Error('Deletion execution target changed');
    const approved=(await db.query("SELECT * FROM deletion_events WHERE id=$1 AND request_id=$2 AND kind='approve' AND actor_kind='operator'",[command.approvalId,request.id])).rows[0];
    if(!approved)throw new Error('Deletion approval unavailable');
    const review=deletionReviewSchema.parse(readDeletionEventPayload(approved)),plan=review.plan;
    if(review.endpoint!==command.endpoint||review.requestId!==request.id||!plan)throw new Error('Deletion approval mismatch');
    const verified=await compactVerify(request.signature,await importSPKI(request.requester_public_key,'Ed25519'),{algorithms:['Ed25519']});
    const intent=deletionIntentSchema.parse(JSON.parse(request.payload_text));
    if(verified.protectedHeader.typ!=='galaxy-deletion-intent+jws'||Object.keys(verified.protectedHeader).sort().join(',')!=='alg,typ'
      ||Buffer.from(verified.payload).toString('utf8')!==request.payload_text||digest(request.payload_text)!==request.payload_hash
      ||intent.action!=='request'||intent.id!==request.id||intent.subjectId!==request.subject_id||intent.endpoint!==command.endpoint)throw new Error('Deletion request evidence mismatch');
    const at=now();if(!Number.isSafeInteger(at)||at<plan.primary.notBefore)throw new Error('Deletion execution not due');
    await db.query("SELECT set_config('galaxy.deletion_subject',$1,true)",[request.subject_id]);
    const revoked=await revoke(db,request.subject_id,at);
    const productV2=await prepareProductV2Deletion(db,{subjectId:request.subject_id,requestId:request.id,at,retainedUntil:Math.max(at,plan.audit.until)});
    await db.query('CREATE TEMP TABLE galaxy_deletion_candidates(table_name text NOT NULL,key_data jsonb NOT NULL) ON COMMIT DROP');
    const selected={},removed=counts({}),joins={};
    for(const [table,where] of Object.entries(deletionTargets)){
      if(!keys[table]?.length)throw new Error('Deletion primary key missing');
      const object=`jsonb_build_object(${keys[table].map(key=>`'${key.column}',t.${quote(key.column)}`).join(',')})`;
      selected[table]=affected(await db.query(`INSERT INTO galaxy_deletion_candidates SELECT $2,${object} FROM ${quote(table)} t WHERE ${where}`,[request.subject_id,table]));
      joins[table]=keys[table].map(key=>`t.${quote(key.column)}=(c.key_data->>'${key.column}')::${key.type}`).join(' AND ');
    }
    // Delete only candidate leaves. Never use CASCADE to remove another author.
    // SET NULL is the existing export-read link and retains the audit record.
    let passes=0,changed;
    do{changed=0;passes++;
      for(const table of Object.keys(deletionTargets)){
        if(auditTables.has(table)&&at<plan.audit.until)continue;
        if(controlHistoryTables.has(table)&&at<plan.audit.until)continue;
        const blockers=constraints.filter(ref=>ref.target===table&&ref.action!=='n').map(ref=>
          `NOT EXISTS(SELECT 1 FROM ${quote(ref.source)} r WHERE ${ref.columns.map(column=>`r.${quote(column.source_column)}=t.${quote(column.target_column)}`).join(' AND ')})`);
        // Worker audit rows have a logical binding reference rather than an FK.
        // Keep that ownership link until the retained audit can be removed.
        if(table==='bindings')blockers.push('NOT EXISTS(SELECT 1 FROM audit_events r WHERE r.binding_id=t.id)');
        // Erasing a control head while any subject-bearing data survives would
        // allow legacy Genesis fallback. Keep the complete public verification
        // chain until all non-control references can be removed in this tx.
        if(controlHistoryTables.has(table))for(const ref of constraints.filter(ref=>ref.target==='subjects'&&!controlHistoryTables.has(ref.source)))
          blockers.push(`NOT EXISTS(SELECT 1 FROM ${quote(ref.source)} r WHERE ${ref.columns.map(column=>`r.${quote(column.source_column)}=t.subject_id`).join(' AND ')})`);
        const result=await db.query(`DELETE FROM ${quote(table)} t USING galaxy_deletion_candidates c WHERE c.table_name=$1 AND ${joins[table]}
          ${blockers.length?'AND '+blockers.join(' AND '):''}`,[table]);
        const deleted=affected(result);removed[table]+=deleted;changed+=deleted;
      }
    }while(changed&&passes<256);
    productV2.retainedBodiesMinimized=await minimizeRetainedProductContent(db,{subjectId:request.subject_id,requestId:request.id,at,retainedUntil:Math.max(at,plan.audit.until)});
    const remaining=counts(Object.fromEntries(Object.keys(selected).map(name=>[name,selected[name]-removed[name]])));
    // A restored copy starts its own deletion counts. Source-history counts are
    // preserved in imported events, not added again to this database's totals.
    const cumulative=counts(recoveryContext&&request.execution_result?.recoveryContext?.recoveryId!==recoveryContext.recoveryId
      ?{}:request.execution_result?.totalDeletedCounts??{});
    for(const name of Object.keys(cumulative))cumulative[name]+=removed[name];
    const primaryRemaining=Object.fromEntries(Object.entries(remaining).filter(([name])=>!auditTables.has(name)));
    const retainedAudit=Object.fromEntries(Object.entries(remaining).filter(([name])=>auditTables.has(name)));
    const honorRuleVersions=Number((await db.query("SELECT count(*) FROM honor_rule_versions WHERE endpoint=$1 AND definition->'members' ? $2",[command.endpoint,request.subject_id])).rows[0].count);
    const result={version:1,id:command.id,requestId:request.id,subjectId:request.subject_id,endpoint:command.endpoint,
      approvalId:command.approvalId,executedAt:new Date(at*1000).toISOString(),revision:request.revision+1,
      state:sum(primaryRemaining)?'partial':'primary-erased',physicalDeletionPerformed:sum(cumulative)>0,
      primary:{state:sum(primaryRemaining)?'references-remain':'erased',remaining:primaryRemaining},
      audit:{state:sum(retainedAudit)?at<plan.audit.until?'retained-until-policy':'references-remain':'erased',until:plan.audit.until,remaining:retainedAudit},
      backups:{state:'deletion-and-expiry-unverified',until:plan.backups.until},externalCopies:{state:'outside-service-control'},
      receiptLedger:{state:'retained-pending-minimization',cleanupImplemented:true},
      productV2:{...productV2,controlHistory:'retained-while-audit-or-independent-subject-references-exist',
        contentErasureReceipts:{state:'minimal-metadata-only',until:Math.max(at,plan.audit.until),cleanupImplemented:true}},
      delegatedStores:{chat:{state:'separate-transport-erasure-required',primaryReferenceDeletionIsBodyDeletion:false}},
      operatorPolicies:{state:honorRuleVersions?'retained-honor-membership-references':'no-honor-membership-references',honorRuleVersions,cleanupImplemented:false},
      selectedCounts:selected,deletedCounts:removed,totalDeletedCounts:cumulative,remainingCounts:remaining,revoked,passes,
      serviceWideDeletionComplete:false,storageMediaErasureVerified:false,restoredSnapshotDeletionReplay:Boolean(recoveryContext),
      ...(recoveryContext?{recoveryContext}: {})};
    await db.query('UPDATE deletion_requests SET state=$2,revision=$3,execution_result=$4::jsonb,updated_at=$5 WHERE id=$1',
      [request.id,result.state,result.revision,JSON.stringify(result),result.executedAt]);
    await db.query(`INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash)
      VALUES($1,$2,$3,'operator',$4,'execute',$5,$6)`,[command.id,request.id,result.revision,command.executorRef,JSON.stringify(result),digest(JSON.stringify(result))]);
    await db.query('INSERT INTO deletion_executions(id,request_id,subject_id,command_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)',
      [command.id,request.id,request.subject_id,commandHash,JSON.stringify(result)]);
    await db.query('DROP TABLE galaxy_deletion_candidates');
    return result;
}
