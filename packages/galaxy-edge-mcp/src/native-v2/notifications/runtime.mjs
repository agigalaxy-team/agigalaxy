import {randomUUID} from 'node:crypto';
import {inboxIdSchema} from '../../../../galaxy-official/src/shared/notification-inbox-schema.mjs';

const DAY = 86400;
const fields = ['subjectId', 'endpoint', 'bindingId', 'generation'];
const objectTypes = new Set(['capsule', 'qualification-request', 'room', 'task', 'information-watch', 'project', 'target-governance',
  'moderation', 'room-invitation', 'builder', 'worker-pack', 'hub', 'assistance', 'incident', 'context', 'context-accept']);
const sameLease = (a, b) => !!a && !!b && fields.every(key => a[key] === b[key]);
const copyLease = value => value && Object.fromEntries(fields.map(key => [key, value[key]]));
const ownerKey = lease => 'host-notifications:' + JSON.stringify([lease.endpoint, lease.subjectId]);
const safeObject = object => {
  if (!object || !objectTypes.has(object.type) || typeof object.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(object.id)) return null;
  return {type: object.type, id: object.id};
};
const eligible = item => inboxIdSchema.safeParse(item?.id).success && item.interruptiveEligible === true
  && item.quiet === false && item.read === false && item.presented === false;

/** Local explicit opt-in bridge, not a new cloud queue or Agent scheduler.
 * Only original event/claim IDs and display state persist. Source text never
 * enters the OS or journal; every foreground destination rechecks current ACL.
 */
export function createHostNotificationRuntime({inbox, channel, getLease, store, deliveryClientId, onNavigate = null, now = () => Math.floor(Date.now() / 1000)} = {}) {
  if (!inbox || !['query', 'claim', 'presented'].every(method => typeof inbox[method] === 'function')
    || !channel || !['capabilities', 'show', 'withdraw', 'close'].every(method => typeof channel[method] === 'function')
    || typeof getLease !== 'function' || !store || typeof store.get !== 'function' || typeof store.update !== 'function'
    || typeof deliveryClientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(deliveryClientId)
    || onNavigate !== null && typeof onNavigate !== 'function') throw Error('notification_runtime_configuration_invalid');
  let closed = false, enabled = false, selectedLease = null, generation = 0, inFlight = null, disposing;
  const visible = new Map(), operations = new Set();
  const lease = () => copyLease(getLease());
  const validLease = value => {
    if (!value || !/^GUID[0-9A-Z]{28}$/.test(value.subjectId ?? '')
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.bindingId ?? '')
      || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
    try { const url = new URL(value.endpoint); return url.origin === value.endpoint && !url.username && !url.password
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); } catch { return false; }
  };
  const capture = () => { const value = lease(); if (!validLease(value)) throw Error('notification_binding_required'); return value; };
  const bound = original => !closed && sameLease(original, lease());
  const active = (original, epoch) => bound(original) && enabled && generation === epoch && sameLease(selectedLease, original);
  const guard = (original, epoch) => { if (epoch === undefined ? !bound(original) : !active(original, epoch)) throw Error('notification_binding_or_choice_changed'); };
  const track = fn => {
    const operation = Promise.resolve().then(fn); operations.add(operation);
    operation.then(() => operations.delete(operation), () => operations.delete(operation)); return operation;
  };
  const read = original => store.get(ownerKey(original));
  const update = (original, mutate) => store.update(ownerKey(original), old => {
    const state = old ?? {owner: {subjectId: original.subjectId, endpoint: original.endpoint}, prompts: []};
    if (state.owner?.subjectId !== original.subjectId || state.owner?.endpoint !== original.endpoint || !Array.isArray(state.prompts)) throw Error('notification_journal_owner_invalid');
    // Retained body-free attempts prevent an unknown display from replaying.
    state.prompts = state.prompts.filter(prompt => Number.isSafeInteger(prompt.at) && prompt.at > now() - 90 * DAY);
    mutate(state); return state;
  });
  const fallback = (reason, items = []) => ({state: 'foreground-fallback', reason, systemDisplayConfirmed: false,
    humanReadChanged: false, agentCursorChanged: false, automaticRetry: false,
    items: items.map(item => ({notificationId: item.id, object: safeObject(item.object), navigation: '/app/notifications'}))});
  async function withdrawAll() {
    const prompts = [...visible.values()]; visible.clear();
    for (const prompt of prompts) prompt.abort.abort();
    await Promise.all(prompts.map(prompt => channel.withdraw(prompt.promptId)));
  }
  async function currentClaim(original, input, epoch) {
    guard(original, epoch); const value = await inbox.claim(input); guard(original, epoch);
    if (value?.id !== input.id || typeof value.claimed !== 'boolean') throw Error('notification_claim_invalid');
    if (!value.claimed) return null;
    if (value.claimId !== input.claimId || !Number.isFinite(Date.parse(value.leaseUntil)) || Date.parse(value.leaseUntil) <= now() * 1000) throw Error('notification_claim_invalid');
    return {...input, leaseUntil: value.leaseUntil};
  }
  async function acknowledge(original, prompt) {
    // Even after mute/withdrawal, only the previously observed exact display is
    // acknowledged. This readonly receipt does not read a previous event body.
    for (const claim of prompt.claims.filter(value => !value.acknowledged)) {
      guard(original);
      const receipt = await inbox.presented({id: claim.id, deliveryClientId: claim.deliveryClientId, claimId: claim.claimId});
      guard(original);
      if (receipt?.id !== claim.id || typeof receipt.presented !== 'boolean' || receipt.humanReadChanged !== false
        || receipt.acknowledgement !== 'client-reported-display') throw Error('notification_presentation_receipt_invalid');
      if (receipt.presented) {
        await update(original, state => {
          const saved = state.prompts.find(value => value.promptId === prompt.promptId);
          const exact = saved?.claims.find(value => value.id === claim.id && value.claimId === claim.claimId);
          if (exact) exact.acknowledged = true;
        });
        guard(original);
      }
    }
  }
  function check() {
    if (closed) throw Error('notification_runtime_closed');
    if (!enabled || !sameLease(selectedLease, lease())) return Promise.resolve({state: 'disabled', humanReadChanged: false, agentCursorChanged: false});
    if (inFlight) return inFlight;
    const original = copyLease(selectedLease), epoch = generation;
    inFlight = track(async () => {
      try {
        // Recheck any still owned OS prompt on subsequent host events. A mute
        // or loss of source withdraws the generic prompt, never revives content.
        for (const shown of visible.values()) {
          let current = true;
          for (const claim of shown.claims) {
            guard(original, epoch);
            try {
              const value = await inbox.claim({id: claim.id, deliveryClientId: claim.deliveryClientId, claimId: claim.claimId});
              guard(original, epoch);
              // An already acknowledged prompt is presented=true. It is not a
              // second claim; current quiet/source is checked by the service.
              if (value?.id !== claim.id || value.quiet === true || value.presented !== true && value.claimed !== true) current = false;
            } catch (error) { if (!active(original, epoch)) throw error; current = false; }
          }
          if (!current) { shown.abort.abort(); await channel.withdraw(shown.promptId); visible.delete(shown.promptId); guard(original, epoch); }
        }
        const capability = await channel.capabilities(); guard(original, epoch);
        const response = await inbox.query({limit: 20, unreadOnly: true}); guard(original, epoch);
        if (!Array.isArray(response?.items) || response.items.length > 20) throw Error('notification_query_invalid');
        const items = response.items.filter(eligible);
        const saved = await read(original); guard(original, epoch);
        const attempted = new Set((saved?.prompts ?? []).flatMap(prompt => prompt.claims.map(claim => claim.id)));
        const fresh = items.filter(item => !attempted.has(item.id));
        if (!fresh.length) return {state: 'no-new-items', checked: items.length, humanReadChanged: false, agentCursorChanged: false};
        if (capability.available !== true) return fallback(capability.reason ?? 'host_notification_unavailable', fresh);
        const claims = [];
        for (const item of fresh) {
          guard(original, epoch);
          const claim = await currentClaim(original, {id: item.id, deliveryClientId, claimId: randomUUID()}, epoch);
          if (claim) claims.push(claim);
        }
        if (!claims.length) return {state: 'claimed-by-another-or-quiet', humanReadChanged: false, agentCursorChanged: false};
        // Claim again just before OS dispatch. It revalidates current source and
        // preference without caching private text or relying on stale query ACL.
        const currentClaims = [];
        for (const claim of claims) {
          const value = await currentClaim(original, {id: claim.id, deliveryClientId, claimId: claim.claimId}, epoch);
          if (value) currentClaims.push(value);
        }
        if (!currentClaims.length) return {state: 'source-or-preference-changed', humanReadChanged: false, agentCursorChanged: false};
        const prompt = {promptId: randomUUID(), at: now(), claims: currentClaims.map(value => ({...value, acknowledged: false})), state: 'dispatching', displayEvidence: null};
        const journal = await update(original, state => {
          const oldIds = new Set(state.prompts.flatMap(value => value.claims.map(claim => claim.id)));
          prompt.claims = prompt.claims.filter(claim => !oldIds.has(claim.id));
          if (prompt.claims.length) {
            if (state.prompts.length >= 256) throw Error('notification_journal_capacity');
            state.prompts.push(structuredClone(prompt));
          }
        });
        guard(original, epoch);
        if (!prompt.claims.length) return {state: 'original-attempt-retained', humanReadChanged: false, agentCursorChanged: false};
        if (!journal.prompts.some(value => value.promptId === prompt.promptId)) throw Error('notification_journal_invalid');
        // Do not keep private titles, summaries or message text in this object.
        const shown = {...prompt, abort: new AbortController(), owner: original}; visible.set(prompt.promptId, shown);
        const delivery = await channel.show({promptId: prompt.promptId, eventCount: prompt.claims.length},
          {signal: shown.abort.signal, isCurrent: () => active(original, epoch), onClosed: () => { visible.delete(prompt.promptId); }, onClicked: () => track(async () => {
            if (!onNavigate || !active(original, epoch)) return;
            // A system click asks to navigate. It never acknowledges reading.
            // Discard the old query objects and look up only current pointers.
            const currentPage = await inbox.query({limit: 20}); guard(original, epoch);
            if (!Array.isArray(currentPage?.items)) return;
            const originals = new Set(prompt.claims.map(claim => claim.id));
            const currentItems = currentPage.items.filter(item => inboxIdSchema.safeParse(item?.id).success && originals.has(item.id) && item.quiet === false);
            const route = fallback('user-clicked-navigation', currentItems); guard(original, epoch);
            await onNavigate({navigation: '/app/notifications', items: route.items, humanReadChanged: false, agentCursorChanged: false});
          })});
        // Preserve an observed display even if disable ran while the OS event
        // was returning. The original owner's journal is never rekeyed.
        const displayed = delivery?.state === 'shown' && delivery.displayed === true && delivery.evidence === 'BalloonTipShown' && delivery.promptId === prompt.promptId;
        await update(original, state => {
          const record = state.prompts.find(value => value.promptId === prompt.promptId);
          if (record) { record.state = displayed ? 'shown' : delivery?.state === 'unavailable' ? 'unavailable' : 'unknown'; record.displayEvidence = displayed ? 'BalloonTipShown' : null; }
        });
        guard(original);
        // Source/quiet may have changed while the OS was processing the show.
        // Keep the old display receipt, but withdraw and withhold stale routes.
        const stillCurrent = [];
        if (active(original, epoch)) for (const claim of prompt.claims) {
          try {
            const value = await currentClaim(original, {id: claim.id, deliveryClientId, claimId: claim.claimId}, epoch);
            if (value) stillCurrent.push(claim.id);
          } catch { guard(original); }
        }
        if (stillCurrent.length !== prompt.claims.length) {
          if (visible.has(prompt.promptId)) { shown.abort.abort(); await channel.withdraw(prompt.promptId); visible.delete(prompt.promptId); }
          guard(original);
        }
        if (displayed) {
          try { await acknowledge(original, prompt); } catch { guard(original); }
          return {state: stillCurrent.length === prompt.claims.length ? 'system-reported-display' : 'displayed-then-withdrawn', promptId: prompt.promptId,
            notificationIds: prompt.claims.map(value => value.id),
            displayEvidence: 'BalloonTipShown', humanReadChanged: false, agentCursorChanged: false};
        }
        // A Linux Notify reply establishes an owned request, not a displayed
        // notification. Keep its withdrawal handle until onClosed or a current
        // source/quiet check removes it; never acknowledge this as presentation.
        if (delivery?.systemAccepted !== true || delivery.promptId !== prompt.promptId) visible.delete(prompt.promptId);
        return fallback(delivery?.reason ?? 'notification_display_unconfirmed', fresh.filter(item => stillCurrent.includes(item.id)));
      } catch (error) {
        if (!bound(original)) { await withdrawAll(); return {state: 'binding-changed', privateContentWithheld: true, humanReadChanged: false, agentCursorChanged: false}; }
        if (!active(original, epoch)) return {state: 'disabled', humanReadChanged: false, agentCursorChanged: false};
        return fallback(error.message === 'notification_query_invalid' ? 'notification_query_invalid' : 'current_notification_unavailable');
      } finally { inFlight = null; }
    });
    return inFlight;
  }
  return Object.freeze({
    enable(_input = {}, {confirmed = false, expectedLease, isCurrent = () => true} = {}) {
      if (closed) throw Error('notification_runtime_closed');
      if (confirmed !== true) throw Error('notification_explicit_choice_required');
      return track(async () => {
      const original = expectedLease === undefined ? capture() : copyLease(expectedLease);
      if (!validLease(original) || !sameLease(original, lease()) || typeof isCurrent !== 'function' || !isCurrent()) throw Error('notification_binding_or_choice_changed');
      const epoch = ++generation; enabled = false; selectedLease = null;
      const currentIntent = () => { guard(original); if (generation !== epoch || !isCurrent()) throw Error('notification_choice_changed'); };
      await withdrawAll(); currentIntent();
      await update(original, state => { currentIntent(); state.choice = {enabled: true, selectedAt: now(), bindingId: original.bindingId}; });
      currentIntent();
      selectedLease = original; enabled = true;
      return {enabled: true, channel: channel.kind ?? 'windows-notify-icon', humanReadChanged: false, agentCursorChanged: false};
      });
    },
    disable() { return track(async () => {
      const original = selectedLease && copyLease(selectedLease), epoch = ++generation; enabled = false; selectedLease = null;
      await withdrawAll();
      if (original && generation === epoch) await update(original, state => {
        if (generation === epoch) state.choice = {enabled: false, selectedAt: now(), bindingId: original.bindingId};
      });
      return {enabled: enabled && sameLease(selectedLease, lease()), superseded: generation !== epoch,
        humanReadChanged: false, agentCursorChanged: false, systemRecall: 'best-effort'};
    }); },
    check,
    reconcile() { return track(async () => {
      const original = capture(), state = await read(original); guard(original);
      for (const prompt of state?.prompts ?? []) if (prompt.state === 'shown' && prompt.displayEvidence === 'BalloonTipShown') await acknowledge(original, prompt);
      guard(original);
      return {state: 'original-display-receipts-only', systemNotificationStarts: 0, humanReadChanged: false, agentCursorChanged: false};
    }); },
    async status() {
      const original = lease(); if (!validLease(original)) return {enabled: false, prompts: []};
      const saved = await read(original); guard(original);
      return {enabled: enabled && sameLease(original, selectedLease), activationRequiredAfterRestart: true,
        prompts: (saved?.prompts ?? []).map(prompt => ({promptId: prompt.promptId, state: prompt.state, at: prompt.at,
          displayEvidence: prompt.displayEvidence, notificationIds: prompt.claims.map(claim => claim.id),
          presentationAcknowledged: prompt.claims.every(claim => claim.acknowledged === true)})), humanReadChanged: false, agentCursorChanged: false};
    },
    dispose() { return disposing ??= Promise.resolve().then(async () => {
      closed = true; ++generation; enabled = false; await withdrawAll();
      await Promise.allSettled(operations); await channel.close();
    }); },
  });
}
