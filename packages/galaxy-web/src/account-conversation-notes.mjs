const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const copy = value => structuredClone(value);

/**
 * Private room annotations owned by an actual signed-in account. The caller
 * supplies the account session lease and its isolated local store; this never
 * creates an identity, copies a message body, or enables cloud synchronization.
 * @param {{endpoint:string,captureLease:()=>{assertCurrent:()=>void},get:(key:string)=>Promise<unknown>,update:(key:string,change:(current:unknown)=>unknown)=>Promise<unknown>}} authority
 * @param {{accountId:string,roomId:string}} owner
 */
export function createAccountConversationNotes(authority, {accountId, roomId}) {
  if (!uuid.test(accountId) || !uuid.test(roomId)) throw Error('conversation_notes_unavailable');
  const endpoint = new URL(authority.endpoint).origin;
  const key = 'account-conversation-notes:v1:' + JSON.stringify([endpoint, accountId, roomId]);
  const initial = () => ({version: 1, endpoint, accountId, roomId, note: '', noteRevision: 0, references: [], draft: null});
  function checked(raw) {
    if (raw == null) return initial();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1
      || raw.endpoint !== endpoint || raw.accountId !== accountId || raw.roomId !== roomId
      || typeof raw.note !== 'string' || raw.note.length > 8000 || !Number.isSafeInteger(raw.noteRevision) || raw.noteRevision < 0
      || !Array.isArray(raw.references) || raw.references.length > 100
      || raw.references.some(ref => !uuid.test(ref?.messageId) || !Number.isSafeInteger(ref?.revision) || ref.revision < 1)
      || raw.draft !== null && (!raw.draft || typeof raw.draft.text !== 'string' || raw.draft.text.length > 8000
        || !uuid.test(raw.draft.id) || !Number.isSafeInteger(raw.draft.baseRevision) || raw.draft.baseRevision < 0)) {
      throw Error('conversation_notes_unavailable');
    }
    return copy(raw);
  }
  async function read() {
    const lease = authority.captureLease(); lease.assertCurrent();
    const value = checked(await authority.get(key)); lease.assertCurrent(); return value;
  }
  async function update(change) {
    const lease = authority.captureLease(); lease.assertCurrent();
    const result = await authority.update(key, raw => {lease.assertCurrent(); return change(checked(raw));});
    lease.assertCurrent(); return checked(result);
  }
  return Object.freeze({
    key, read,
    async setSaved(reference, saved) {
      if (!uuid.test(reference?.messageId) || !Number.isSafeInteger(reference?.revision) || reference.revision < 1 || typeof saved !== 'boolean') throw Error('conversation_notes_unavailable');
      return update(value => {
        const refs = value.references.filter(ref => ref.messageId !== reference.messageId);
        if (saved) refs.push({messageId: reference.messageId, revision: reference.revision});
        if (refs.length > 100) throw Error('conversation_notes_limit');
        return {...value, references: refs};
      });
    },
    async saveDraft({text, baseRevision, expectedDraftId}) {
      if (typeof text !== 'string' || text.length > 8000 || !Number.isSafeInteger(baseRevision) || baseRevision < 0) throw Error('conversation_notes_unavailable');
      return update(value => {
        if ((value.draft?.id ?? null) !== expectedDraftId) {
          if (value.draft?.text === text && value.draft?.baseRevision === baseRevision) return value;
          throw Error('conversation_notes_conflict');
        }
        return {...value, draft: {id: crypto.randomUUID(), text, baseRevision}};
      });
    },
    async saveNote({text, expectedRevision, expectedDraftId}) {
      if (typeof text !== 'string' || text.length > 8000) throw Error('conversation_notes_unavailable');
      return update(value => {
        if (value.noteRevision !== expectedRevision || (value.draft?.id ?? null) !== expectedDraftId) throw Error('conversation_notes_conflict');
        return {...value, note: text, noteRevision: value.noteRevision + 1, draft: null};
      });
    },
  });
}
