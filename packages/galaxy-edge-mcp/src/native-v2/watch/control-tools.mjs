import * as z from 'zod/v4';
import {createNativeWatchHandoff} from './handoff.mjs';
import {watchControlRegisterSchema,watchControlTakeoverSchema,watchControlStopSchema,watchControlQuerySchema,watchControlReadSchema} from '../../../../galaxy-official/src/shared/watch-control-v2-schema.mjs';
// register is the native server's real elicitation/local-review wrapper. No
// model-provided confirmed flag is accepted in any public tool input.
export function registerNativeWatchControlTools(register,runtime){
 const instances=new Map();async function handoff(){const id=(await runtime.status()).identity;if(!id)throw Error('native_identity_required');
  if(!instances.has(id))instances.set(id,createNativeWatchHandoff({store:runtime.store,api:runtime.api,subjectId:id,now:runtime.now}));return instances.get(id);}
 register('galaxy_watch_control_enable',watchControlRegisterSchema,
  'Explicitly opt one existing local watch into private cross-device control metadata. Select its exact purpose, room/task, expiry and existing grant; this exact grant is shortened to the selected watch deadline. No messages, model context or credentials are uploaded. Preserve operationId after missing ACK.',
  async x=>(await handoff()).enable(x,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_watch_control_takeover',watchControlTakeoverSchema,
  'On this current authorized device, explicitly take over the exact observed version of your registered watch. Keeps the same watch ID and server-acknowledged cursor, atomically revokes only the old grant, and runs no cloud Agent. Previous external process stop remains unconfirmed.',
  async x=>(await handoff()).takeover(x,{confirmed:true}),{write:true,needsChoice:true});
 register('galaxy_watch_control_query',watchControlQuerySchema,
  'List only your explicitly registered private watch controls. Local-only watches and private summaries are separate; permission does not prove a live host.',async x=>(await handoff()).query(x));
 register('galaxy_watch_control_read',watchControlReadSchema,
  'Read the current control version, active device reference and acknowledged Agent cursor for one of your watches. No room message body or human-read claim.',async x=>(await handoff()).get(x.watchId));
 register('galaxy_watch_control_stop',watchControlStopSchema,
  'Stop and revoke only the exact watch revision/grant named. A stale old-device request cannot stop its new controller. External process cancellation remains the actual host responsibility.',async x=>(await handoff()).stop(x),{write:true});
 register('galaxy_watch_control_pending',z.strictObject({}),
  'Read this device’s pending exact control operations; no new authorization or model work.',async()=>(await handoff()).pending());
 register('galaxy_watch_control_reconcile',z.strictObject({operationId:z.uuid(),retry:z.boolean().default(false)}),
  'Reconcile an already selected exact operation after unknown delivery. Retry only the persisted original request if the server receipt is absent; never create a new watch, grant or scope.',
  async({operationId,retry})=>(await handoff()).reconcile(operationId,{retry}),{write:true});
}
