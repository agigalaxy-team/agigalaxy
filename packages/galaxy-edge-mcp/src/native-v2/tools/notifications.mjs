import * as z from 'zod/v4';
import {randomUUID} from 'node:crypto';
import {createHostNotificationRuntime} from '../notifications/runtime.mjs';
import {createConfiguredNotificationChannel} from '../notifications/config.mjs';

// A live native process may check the existing inbox after an explicit choice.
// Restart never restores that choice, and this loop has no model interface.
export function registerNativeNotificationTools(register, runtime, {
 configuration, createChannel = () => createConfiguredNotificationChannel(configuration),
 setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 60000,
} = {}) {
 if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) throw Error('notification_poll_interval_invalid');
 const activationSession=randomUUID();
 let current, creating, timer, closed = false, polling = false, closing, choiceEpoch = 0, reviewRevision = 0, permissionRevision = 0;
 const permissionRequests=new Set();
 const lease = () => { const s = runtime.api.snapshot(); return s ? {subjectId: s.subjectId, endpoint: runtime.api.endpoint, bindingId: s.bindingId, generation: s.generation} : null; };
 async function instance() {
  if (closed) throw Error('notification_runtime_closed');
  if (current) return current;
  return creating ??= (async () => {
   const before = JSON.stringify(lease());
   if (before === 'null') throw Error('notification_binding_required');
   const saved = await runtime.store.update('native-notification-delivery-client', old => old ?? {id: randomUUID()});
   if (closed || before !== JSON.stringify(lease())) throw Error('notification_binding_changed');
   current = createHostNotificationRuntime({
    inbox: {query: input => runtime.api.call('/v2/notifications/query', input),
     claim: input => runtime.api.call('/v2/notifications/presentation/claim', input),
     presented: input => runtime.api.call('/v2/notifications/presentation/ack', input)},
    channel: createChannel(), getLease: lease, store: runtime.store, deliveryClientId: saved.id,
    now: runtime.now, onNavigate: () => runtime.navigation.open({object: {kind: 'notifications'}}),
   });
   return current;
  })().finally(() => { creating = null; });
 }
 const stopTimer = () => { polling = false; if (timer) clearTimer(timer); timer = null; };
 function schedule() {
  if (!polling || closed || timer) return;
  timer = setTimer(async () => {
   timer = null;
   try {
    const state = await current.status();
    if (!state.enabled) { stopTimer(); await current.disable(); return; }
    await current.check();
   } catch { stopTimer(); await current?.disable().catch(() => {}); }
   schedule();
  }, intervalMs);
  timer?.unref?.();
 }
 const stopPermission=entry=>{entry.abort.abort();return entry.closing??=Promise.resolve().then(()=>entry.channel.close());};
 async function stopPermissions(){await Promise.all([...permissionRequests].map(stopPermission));}
 async function disable() { ++choiceEpoch; ++reviewRevision; ++permissionRevision; stopTimer(); await stopPermissions(); return current ? current.disable() : {enabled: false, humanReadChanged: false, agentCursorChanged: false}; }
 const empty = z.strictObject({});
 register('galaxy_host_notifications_status', empty, 'Read local host reminder state. Starts no OS helper, timer or model. Restart requires a new explicit enable choice.',
  async () => current ? current.status() : {enabled: false, activationRequiredAfterRestart: true, prompts: [], humanReadChanged: false, agentCursorChanged: false});
 register('galaxy_host_notifications_permission', empty, 'After a separate explicit choice, ask the configured macOS helper for OS alert permission if it has never been decided. Does not enable reminders, show a notification, poll the inbox, or change Galaxy read state. Denied permission stays denied.', async () => {
  if(closed)throw Error('notification_runtime_closed');
  const originalLease=JSON.stringify(lease());if(originalLease==='null')throw Error('notification_binding_required');
  const epoch=choiceEpoch,revision=++permissionRevision,channel=createChannel(),entry={channel,abort:new AbortController(),closing:null};
  const isCurrent=()=>!closed&&epoch===choiceEpoch&&revision===permissionRevision&&originalLease===JSON.stringify(lease());
  permissionRequests.add(entry);
  try{
   if(typeof channel.requestPermission!=='function')return{available:false,reason:'notification_permission_request_unsupported',reminderPreferenceChanged:false,systemDisplayConfirmed:false,humanReadChanged:false,agentCursorChanged:false,modelCalls:0};
   const result=await channel.requestPermission({isCurrent,signal:entry.abort.signal});
   if(!isCurrent())throw Error('notification_binding_or_choice_changed');
   return{...result,reminderPreferenceChanged:false,systemDisplayConfirmed:false,humanReadChanged:false,agentCursorChanged:false,modelCalls:0};
  }finally{try{await stopPermission(entry);}finally{permissionRequests.delete(entry);}}
 },{write:true,needsChoice:true,singleUseChoice:true,getReviewScope:()=>activationSession+':permission:'+permissionRevision});
 register('galaxy_host_notifications_enable', empty, 'Enable generic system reminders in this running native process after an explicit choice. Check the current inbox every 60 seconds; send no private source text to the OS and never mark human read.', async () => {
  const epoch = ++choiceEpoch, originalLease = JSON.stringify(lease()), source = await instance();
  const superseded = () => ({enabled: false, superseded: true, humanReadChanged: false, agentCursorChanged: false, modelCalls: 0});
  if (closed || epoch !== choiceEpoch || originalLease !== JSON.stringify(lease())) return superseded();
  const result = await source.enable({}, {confirmed: true, expectedLease: JSON.parse(originalLease),
   isCurrent: () => !closed && epoch === choiceEpoch && originalLease === JSON.stringify(lease())});
  if (closed || epoch !== choiceEpoch || originalLease !== JSON.stringify(lease())) return superseded();
  polling = true; schedule(); return {...result, checkIntervalSeconds: intervalMs / 1000, modelCalls: 0};
 }, {write: true, needsChoice: true, getReviewScope: () => activationSession+':'+reviewRevision});
 register('galaxy_host_notifications_disable', empty, 'Stop host reminder checks and withdraw owned prompts. Remote business events and human read remain unchanged.', disable, {write: true});
 register('galaxy_host_notifications_check', empty, 'Check reminders only while already enabled. Unavailable or unconfirmed system delivery leaves the foreground inbox available; no model call.',
  async () => current ? current.check() : {state: 'disabled', humanReadChanged: false, agentCursorChanged: false}, {write: true});
 register('galaxy_host_notifications_reconcile', empty, 'Acknowledge only original locally observed display receipts, including after disabling. Never show again or mark a human as having read.',
  async () => (await instance()).reconcile(), {write: true});
 return {disable, close() { closed = true; ++choiceEpoch; ++reviewRevision; ++permissionRevision; stopTimer(); return closing ??= Promise.resolve().then(async () => {
  await stopPermissions(); await creating?.catch(() => {}); await current?.dispose();
 }); }};
}
