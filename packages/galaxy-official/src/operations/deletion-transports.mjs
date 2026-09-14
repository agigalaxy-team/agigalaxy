import { executeDeletion } from './deletion-execute.mjs';

// Separate transactions are intentional. Only a successfully authorized DB
// execution reaches transport erasure; external failure cannot roll back an
// external side effect. The adapter persists purge_pending and safely retries.
export async function executeDeletionWithTransports(database, command, { chat = null, attachments = chat?.attachments, now, limit = 100 } = {}) {
  const execution = await executeDeletion(database, command, now ? { now } : {});
  let transport;
  if (!chat?.eraseSubject) transport = { state: 'adapter-unavailable', complete: false };
  else {
    try {
      const result = await chat.eraseSubject(execution.subjectId, { limit });
      transport = { state: result.complete === true ? 'adapter-scope-complete' : 'pending-external-erasure', ...result };
    } catch {
      // Do not leak transport connection details or lose the primary receipt.
      transport = { state: 'pending-external-erasure', complete: false, retrySameCommand: true };
    }
  }
  let files={state:'adapter-unavailable',complete:false};
  if(attachments?.eraseSubject)try {files=await attachments.eraseSubject(execution.subjectId);}
  catch {files={state:'pending-external-erasure',complete:false,retrySameCommand:true};}
  return { execution, transport: { chat: transport, attachments:files },
    consistency: 'database-receipt-and-current-transport-status; transport-pending-state-owned-by-chat',
    serviceWideDeletionComplete: false, backupsStarted: false };
}
