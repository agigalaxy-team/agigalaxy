import {operationsIso,operationsFail} from '../../operations-content-visibility.mjs';

// A position in a processing lifecycle, not a download token or object key.
export function fileProcessingVersion(row){const error=typeof row.last_error==='string'&&/^attachment_[a-z0-9_]{1,70}$/.test(row.last_error)?row.last_error:row.last_error?'unrecognized-processing-error':null;
 return JSON.stringify([row.state,row.scan_attempts,operationsIso(row.lease_until),row.lease_id??null,row.purge_pending,operationsIso(row.revoked_at),operationsIso(row.purged_at),operationsIso(row.expires_at??row.prepare_expires_at),row.operations_retry_revision??0,error]);}
// The legacy cleanup transaction has no durable attempt or delete-ACK ledger.
// Its one cleanup-specific error proves an attempt was not confirmed, not that
// the object still exists. Other upload/scan errors are never deletion failures.
export function fileProcessingFacts(row,now){
 const cutoff=Date.parse(row.expires_at??row.prepare_expires_at),expired=Number.isFinite(cutoff)&&cutoff<=now*1000,
  removed=!!row.purged_at,activeLease=!!row.lease_id&&!!row.lease_until&&Date.parse(row.lease_until)>now*1000,
  cleanupUnknown=!removed&&!!row.purge_pending&&row.last_error==='attachment_cleanup_failed',
  needsCleanup=!removed&&(!!row.purge_pending||!!row.revoked_at||expired),
  scanFailed=!removed&&['scan-pending','scanning'].includes(row.state)&&row.scan_attempts>0&&!!row.last_error&&row.last_error!=='attachment_cleanup_failed';
 let scanState='unavailable';
 if(['clean','blocked'].includes(row.scan_result?.state))scanState=row.scan_result.state;
 else if(!removed&&row.state==='scanning'&&activeLease)scanState='running';
 else if(scanFailed)scanState='failed';
 else if(!removed&&['scan-pending','scanning'].includes(row.state))scanState='pending';
 else if(!removed&&['prepared','uploading'].includes(row.state))scanState='not-started';
 const checked=row.scan_result?.checkedAt;
 return{expired,removed,activeLease,needsCleanup,cleanupUnknown,scanFailed,
  state:removed?'erased':row.revoked_at?'revoked':expired?'expired':row.state,
  scan:{state:scanState,checkedAt:typeof checked==='number'&&Number.isFinite(checked)&&checked>0?new Date(checked*1000).toISOString():null},
  cleanup:{state:removed?'removed':cleanupUnknown?'result-unknown':needsCleanup?'pending':'not-requested',
   executionObserved:false,failureObserved:null,objectRemoved:removed,physicalBlocksReleased:null,
   authorization:'legacy-plan-required',retryBlockedReason:removed?null:'plan-authorization-required'}};
}
export function fileRetryState(row,now){
 const expired=Date.parse(row.expires_at??row.prepare_expires_at)<=now*1000,activeLease=!!row.lease_id&&!!row.lease_until&&Date.parse(row.lease_until)>now*1000;
 const scan=!row.purged_at&&!row.revoked_at&&!expired&&!row.purge_pending&&['scan-pending','scanning'].includes(row.state)&&!activeLease;
 // purge_pending is eligibility metadata, not the confirmed concrete cleanup
 // plan required for legacy files. New relay policy is not configured here.
 const cleanup=false;
 return {scan,cleanup,activeLease};
}
export async function retryFileProcessingWithin(db,{table,row,input,now,authorUnavailable=false}){
 if(!['chat_attachments','forum_attachments_v1'].includes(table))throw new TypeError('Unknown attachment table');
 if(fileProcessingVersion(row)!==input.expectedVersion)operationsFail('operations_file_changed');
 if(input.kind==='cleanup')operationsFail('operations_file_cleanup_authorization_required');
 const allowed=fileRetryState(row,now);
 if(!allowed[input.kind]||input.kind==='scan'&&authorUnavailable)operationsFail('operations_file_retry_unavailable');
 // Reschedule one eligible record. The existing worker still owns storage,
 // scanning, current-source checks and final cleanup; no operator can mark a
 // file clean, extend its lifetime or restore revoked/erased content.
 return (await db.query(`UPDATE ${table} SET lease_id=NULL,lease_until=NULL,last_error=NULL,operations_retry_revision=operations_retry_revision+1 WHERE id=$1 RETURNING *`,[row.id])).rows[0];
}
