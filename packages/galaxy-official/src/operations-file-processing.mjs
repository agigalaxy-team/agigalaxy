import {operationsIso,operationsFail} from './operations-content-visibility.mjs';

// A position in a processing lifecycle, not a download token or object key.
export function fileProcessingVersion(row){return JSON.stringify([row.state,row.scan_attempts,operationsIso(row.lease_until),row.lease_id??null,row.purge_pending,operationsIso(row.revoked_at),operationsIso(row.purged_at),operationsIso(row.expires_at??row.prepare_expires_at),row.operations_retry_revision??0]);}
export function fileRetryState(row,now){
 const expired=Date.parse(row.expires_at??row.prepare_expires_at)<=now*1000,activeLease=!!row.lease_id&&!!row.lease_until&&Date.parse(row.lease_until)>now*1000;
 const scan=!row.purged_at&&!row.revoked_at&&!expired&&!row.purge_pending&&['scan-pending','scanning'].includes(row.state)&&!activeLease;
 const cleanup=!row.purged_at&&row.purge_pending&&!activeLease;
 return {scan,cleanup,activeLease};
}
export async function retryFileProcessingWithin(db,{table,row,input,now,authorUnavailable=false}){
 if(!['chat_attachments','forum_attachments_v1'].includes(table))throw new TypeError('Unknown attachment table');
 if(fileProcessingVersion(row)!==input.expectedVersion)operationsFail('operations_file_changed');
 const allowed=fileRetryState(row,now);
 if(!allowed[input.kind]||input.kind==='scan'&&authorUnavailable)operationsFail('operations_file_retry_unavailable');
 // Reschedule one eligible record. The existing worker still owns storage,
 // scanning, current-source checks and final cleanup; no operator can mark a
 // file clean, extend its lifetime or restore revoked/erased content.
 return (await db.query(`UPDATE ${table} SET lease_id=NULL,lease_until=NULL,last_error=NULL,operations_retry_revision=operations_retry_revision+1 WHERE id=$1 RETURNING *`,[row.id])).rows[0];
}
