import { randomUUID } from 'node:crypto';
import { component, xml } from '@xmpp/component';
import { ServiceError } from '../shared/service-error.mjs';

const NS = 'urn:galaxy:rooms:1', MUC = 'http://jabber.org/protocol/muc', MAM = 'urn:xmpp:mam:2';
const RSM = 'http://jabber.org/protocol/rsm', SID = 'urn:xmpp:sid:0';
const allowedErrors = new Set(['chat_access_denied', 'invalid_chat_request', 'chat_room_conflict', 'chat_room_unavailable',
  'chat_room_not_found', 'chat_room_limit', 'chat_member_limit', 'chat_revision_conflict', 'chat_decision_unavailable']);

export class ProsodyChatTransport {
  constructor({ service, domain, roomsDomain, password, timeoutMs = 5000 }) {
    const url = new URL(service);
    // XEP-0114 shares namespace authority. Only same-host, non-public transport.
    if (url.protocol !== 'xmpp:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.pathname || url.search || url.hash || !/^[a-z0-9.-]+$/.test(domain) || !/^[a-z0-9.-]+$/.test(roomsDomain)
      || domain === roomsDomain || typeof password !== 'string' || password.length < 32) throw new Error('Invalid private chat configuration');
    this.domain = domain; this.roomsDomain = roomsDomain; this.timeoutMs = timeoutMs;
    this.entity = component({ service, domain, password });
    this.waiters = new Set(); this.online = false;
    this.entity.on('error', () => { /* SDK errors may contain transport data; never log them. */ });
    this.entity.on('online', () => { this.online = true; });
    this.entity.on('offline', () => {
      this.online = false;
      for (const waiter of this.waiters) waiter.reject(new ServiceError('chat_transport_unavailable', 503));
    });
    this.entity.on('stanza', stanza => {
      for (const waiter of this.waiters) waiter.accept(stanza);
    });
  }
  async start() { try { await this.entity.start(); } catch { await this.entity.stop(); throw new ServiceError('chat_transport_unavailable', 503); } }
  async stop() { await this.entity.stop(); }
  address(actor) {
    if (!/^GUID[0-9A-Z]{28}$/.test(actor.subjectId) || !/^[0-9a-f-]{36}$/.test(actor.bindingId)) throw new ServiceError('chat_access_denied', 403);
    return `${actor.subjectId.toLowerCase()}@${this.domain}/${actor.bindingId}`;
  }
  room(id) { return `${id}@${this.roomsDomain}`; }
  exchange(outgoing, accept) {
    if (!this.online) return Promise.reject(new ServiceError('chat_transport_unavailable', 503));
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.waiters.delete(waiter); if (error) reject(error); else resolve(value);
      };
      const waiter = { reject: error => finish(error), accept: stanza => {
        try { const result = accept(stanza); if (result !== undefined) finish(null, result); } catch (error) { finish(error); }
      } };
      this.waiters.add(waiter);
      const timer = setTimeout(() => finish(new ServiceError('chat_delivery_unknown', 504)), this.timeoutMs);
      this.entity.send(outgoing).catch(() => finish(new ServiceError('chat_transport_unavailable', 503)));
    });
  }
  iq(actor, target, child, onStanza = () => {}) {
    const id = randomUUID(), from = this.address(actor);
    return this.exchange(xml('iq', { type: 'set', id, from, to: target }, child), stanza => {
      if (stanza.attrs.to !== from || stanza.attrs.from !== target) return;
      onStanza(stanza);
      if (stanza.name !== 'iq' || stanza.attrs.id !== id) return;
      if (stanza.attrs.type === 'error') throw new ServiceError('chat_protocol_rejected', 409);
      if (stanza.attrs.type === 'result') return stanza;
    });
  }
  async command(actor, input) {
    const stanza = await this.iq(actor, this.roomsDomain, xml('command', { xmlns: NS }, JSON.stringify(input)));
    let value;
    try { value = JSON.parse(stanza.getChildText('result', NS)); } catch { throw new ServiceError('chat_protocol_invalid', 502); }
    if (value.error) {
      const code = allowedErrors.has(value.error) ? value.error : 'chat_protocol_invalid';
      throw new ServiceError(code, code === 'chat_access_denied' ? 403 : code === 'chat_room_not_found' ? 404 : 409);
    }
    return value;
  }
  async attach(actor, roomId) {
    const from = this.address(actor), to = `${this.room(roomId)}/${actor.subjectId.toLowerCase()}`;
    return this.exchange(xml('presence', { from, to }, xml('x', { xmlns: MUC }, xml('history', { maxstanzas: '0' }))), stanza => {
      if (stanza.name !== 'presence' || stanza.attrs.to !== from || stanza.attrs.from !== to) return;
      if (stanza.attrs.type === 'error') throw new ServiceError('chat_join_rejected', 403);
      const x = stanza.getChild('x', MUC + '#user');
      if (!stanza.attrs.type && x?.getChildren('status').some(status => status.attrs.code === '110')) return { attached: true };
    });
  }
  async send(actor, { roomId, text }) {
    await this.attach(actor, roomId);
    const from = this.address(actor), target = this.room(roomId), id = randomUUID();
    return this.exchange(xml('message', { from, to: target, type: 'groupchat', id }, xml('body', {}, text), xml('origin-id', { xmlns: SID, id })), stanza => {
      if (stanza.name !== 'message' || stanza.attrs.to !== from || stanza.attrs.id !== id) return;
      if (stanza.attrs.type === 'error' && stanza.attrs.from === target) throw new ServiceError('chat_message_rejected', 409);
      if (stanza.attrs.type !== 'groupchat' || stanza.attrs.from !== `${target}/${actor.subjectId.toLowerCase()}`) return;
      const archived = stanza.getChildren('stanza-id', SID).find(value => value.attrs.by === target)?.attrs.id;
      if (!archived) throw new ServiceError('chat_archive_unconfirmed', 503);
      return { messageId: id, archiveId: archived, acceptedByRoom: true, readByOthers: false };
    });
  }
  async messages(actor, { roomId, limit, after }) {
    const target = this.room(roomId), queryId = randomUUID(), items = [];
    const rsm = xml('set', { xmlns: RSM }, xml('max', {}, String(limit)), after ? xml('after', {}, after) : xml('before'));
    const reply = await this.iq(actor, target, xml('query', { xmlns: MAM, queryid: queryId }, rsm), stanza => {
      const result = stanza.getChild('result', MAM);
      if (stanza.name !== 'message' || result?.attrs.queryid !== queryId || items.length >= limit) return;
      const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
      const message = forwarded?.getChild('message', 'jabber:client');
      const text = message?.getChildText('body');
      const sender = message?.attrs.from?.slice(target.length + 1);
      if (!message?.attrs.from?.startsWith(target + '/') || !/^guid[0-9a-z]{28}$/.test(sender) || typeof text !== 'string') return;
      items.push({ archiveId: result.attrs.id, messageId: message.attrs.id ?? null, subjectId: sender.toUpperCase(),
        text, sentAt: forwarded.getChild('delay', 'urn:xmpp:delay')?.attrs.stamp ?? null });
    });
    const fin = reply.getChild('fin', MAM);
    if (!fin) throw new ServiceError('chat_protocol_invalid', 502);
    return { items, last: fin.getChild('set', RSM)?.getChildText('last') ?? null,
      complete: fin.attrs.complete === 'true' || fin.attrs.complete === '1', source: 'prosody-mam' };
  }
}
