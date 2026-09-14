import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { withLocalRead, withLocalWrite } from '../../galaxy-core/src/storage/write-lock.mjs';
import { localPaths, readJson, writeJson } from '../../galaxy-core/src/storage/files.mjs';
import { verifyGalaxyGenesis } from '../../galaxy-core/src/galaxy-guid.mjs';
import { assistanceRequestSchema, assistanceEnvelopeSchema } from './shared/assistance-schema.mjs';
import { assistanceEventDraftSchema, assistanceDraftSource, checkEventDraftTarget, eventDraftFields, eventFromDraft } from './shared/assistance-event-draft.mjs';
import { consentSchema } from './shared/consents-schema.mjs';
import { validatePublicUrl } from './public-fetch.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const valuesSchema = z.object(Object.fromEntries(['caseId','title','problem','attempts','scope','capabilityId','hours','viewers','amount','minimum','maximum','unit']
  .map(key => [key, z.string().max(1200).optional()]))).strict();
const draftContent = z.object({
  values: valuesSchema, step: z.enum(['details','visibility','viewers','budget','budget-fields','qualification','review']), index: z.number().int().min(0).max(6),
  visibility: z.enum(['Private','Public']).nullable(), mode: z.enum(['open','fixed','range','quote']).nullable(),
  qualification: z.object({policyId:z.string().min(1).max(80),policyVersion:z.string().min(1).max(32)}).strict().nullable(),
}).strict();
const contentSchema = value => value?.eventKind ? assistanceEventDraftSchema : draftContent;
const parsePayload = text => {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16000) throw new Error('Invalid local Assistance payload.');
  const raw = JSON.parse(text);
  return (raw.assistanceId ? assistanceEnvelopeSchema : assistanceRequestSchema).parse(raw);
};

// One identity/endpoint-scoped store for unfinished forms and exact submitted bytes.
// It contains selected request text and Consent declarations, never session credentials.
export function createLocalAssistanceStore({dataDirectory, endpoint, assertOpen = () => true}) {
  if (validatePublicUrl(endpoint).origin !== endpoint) throw new Error('Canonical Assistance endpoint required.');
  const key = (subjectId, id) => hash(JSON.stringify([endpoint, subjectId, id]));
  async function load(directory, subjectId) {
    const paths = localPaths(directory), identity = await readJson(paths.identity, null), state = await readJson(paths.state, null);
    if (await readJson(paths.initializationJournal, null) || await readJson(paths.resetJournal, null)) throw new Error('Local recovery required.');
    if (!assertOpen() || !identity || subjectId && identity.id !== subjectId || !verifyGalaxyGenesis(identity.id, identity.genesisProof) || !state?.integration)
      throw new Error('Local Assistance identity unavailable.');
    state.assistanceDrafts ??= {}; state.assistanceOperations ??= {};
    return {paths, identity, state};
  }
  async function write(paths, state) {
    const local = [state.assistanceDrafts, state.assistanceOperations];
    if (local.some(rows => Object.keys(rows).length > 100) || Buffer.byteLength(JSON.stringify(local)) > 2097152
      || Buffer.byteLength(JSON.stringify(state, null, 2)) > 4194304) throw new Error('Local Assistance storage full; remove completed local records.');
    if (!assertOpen()) throw new Error('Local host closed.');
    await writeJson(paths.state, state);
  }
  function draft(row, subjectId) {
    if (row?.version !== 1 || row.endpoint !== endpoint || row.subjectId !== subjectId || !z.uuid().safeParse(row.id).success
      || !Number.isInteger(row.revision) || row.revision < 1 || !['editing','prepared'].includes(row.status)) throw new Error('Invalid Assistance draft.');
    contentSchema(row.content).parse(row.content); return row;
  }
  function operation(row, subjectId) {
    if (row?.version !== 1 || row.endpoint !== endpoint || row.subjectId !== subjectId) throw new Error('Assistance journal identity mismatch.');
    const payload = parsePayload(row.payloadJson), eventId = payload.event?.id ?? payload.id;
    if (row.eventId !== eventId || row.assistanceId !== (payload.assistanceId ?? payload.id) || row.payloadHash !== hash(row.payloadJson)
      || !Array.isArray(row.intents) || !row.intents.length || row.intents.length > 16
      || !['prepared','submitting','unknown','conflict','acknowledged'].includes(row.status)) throw new Error('Invalid Assistance journal.');
    for (const raw of row.intents) {
      const intent = consentSchema.parse(raw);
      if (intent.subjectId !== subjectId || intent.endpoint !== endpoint || intent.recipient !== endpoint || intent.objectId !== eventId
        || intent.action !== 'assistance.publish' || intent.payloadHash !== row.payloadHash
        || JSON.stringify(intent.fields) !== JSON.stringify(Object.keys(payload))) throw new Error('Assistance journal Consent mismatch.');
    }
    return row;
  }
  async function createDraft() { return withLocalWrite(dataDirectory, async directory => {
    const {paths, state, identity} = await load(directory), id = randomUUID(), at = new Date().toISOString();
    const row = {version:1, id, endpoint, subjectId:identity.id, revision:1, status:'editing', createdAt:at, updatedAt:at,
      content:{values:{hours:'24'},step:'details',index:0,visibility:null,mode:null,qualification:null}};
    state.assistanceDrafts[key(identity.id,id)] = row; await write(paths,state); return row;
  }); }
  async function getDraft(id) { z.uuid().parse(id); return withLocalRead(dataDirectory, async directory => {
    const {state,identity} = await load(directory), row = state.assistanceDrafts[key(identity.id,id)];
    if (!row) throw new Error('Local Assistance draft unavailable.'); return draft(row,identity.id);
  }); }
  async function createEventDraft({record,eventKind,target={}}) {
    const content=assistanceEventDraftSchema.parse({eventKind,source:assistanceDraftSource(record),target,values:{},
      step:eventDraftFields[eventKind]?.length?'fields':'review',index:0,mode:null});
    checkEventDraftTarget(content,record);
    return withLocalWrite(dataDirectory,async directory=>{
      const {paths,state,identity}=await load(directory),id=randomUUID(),at=new Date().toISOString();
      const row={version:1,id,endpoint,subjectId:identity.id,revision:1,status:'editing',createdAt:at,updatedAt:at,content};
      state.assistanceDrafts[key(identity.id,id)]=row;await write(paths,state);return row;
    });
  }
  async function rebaseDraft({id,expectedRevision,record}) {return withLocalWrite(dataDirectory,async directory=>{
    const {paths,state,identity}=await load(directory),row=draft(state.assistanceDrafts[key(identity.id,id)],identity.id);
    if(!row.content.eventKind||row.status!=='editing'||row.revision!==expectedRevision)throw new Error('Assistance draft changed; reopen it.');
    checkEventDraftTarget(row.content,record);
    const source=assistanceDraftSource(record);
    if(source.version<row.content.source.version)throw new Error('Collaboration version cannot move backwards.');
    row.content={...row.content,source};row.revision++;row.updatedAt=new Date().toISOString();await write(paths,state);return row;
  });}
  async function saveDraft({id, expectedRevision, content}) { z.uuid().parse(id); const parsed = contentSchema(content).parse(content);
    return withLocalWrite(dataDirectory, async directory => {
      const {paths,state,identity} = await load(directory), row = draft(state.assistanceDrafts[key(identity.id,id)],identity.id);
      if (row.status !== 'editing' || row.revision !== expectedRevision) throw new Error('Assistance draft changed; reopen it.');
      if(row.content.eventKind!==parsed.eventKind || parsed.eventKind && (JSON.stringify(row.content.source)!==JSON.stringify(parsed.source)
        || JSON.stringify(row.content.target)!==JSON.stringify(parsed.target)))throw new Error('Draft target and version require explicit refresh.');
      row.content = parsed; row.revision++; row.updatedAt = new Date().toISOString(); await write(paths,state); return row;
    });
  }
  async function listDrafts() { return withLocalRead(dataDirectory, async directory => {
    const {state,identity} = await load(directory);
    return {localOnly:true, endpoint, subjectId:identity.id, items:Object.values(state.assistanceDrafts)
      .filter(row => row.endpoint === endpoint && row.subjectId === identity.id).map(row => {
        draft(row,identity.id); return {id:row.id, title:row.content.eventKind ? row.content.eventKind+' · '+row.content.source.title : row.content.values.title ?? '',
          status:row.status,updatedAt:row.updatedAt,...(row.content.eventKind?{eventKind:row.content.eventKind,assistanceId:row.content.source.assistanceId}:{})};
      })};
  }); }
  async function forgetDraft(id) { return withLocalWrite(dataDirectory, async directory => {
    const {paths,state,identity} = await load(directory), row = draft(state.assistanceDrafts[key(identity.id,id)],identity.id);
    if (row.status !== 'editing') throw new Error('Use the saved operation to reconcile or remove this draft.');
    delete state.assistanceDrafts[key(identity.id,id)]; await write(paths,state); return {id,localOnly:true};
  }); }
  async function save({subjectId,payloadJson,intent,draftId,draftRevision}) { return withLocalWrite(dataDirectory, async directory => {
    const {paths,state} = await load(directory,subjectId), payload = parsePayload(payloadJson), eventId = payload.event?.id ?? payload.id, id = key(subjectId,eventId);
    const previous = state.assistanceOperations[id];
    if (previous) {
      operation(previous,subjectId);
      if (previous.payloadJson !== payloadJson) throw new Error('Assistance event payload already frozen.');
      if (previous.status === 'acknowledged') return previous;
    }
    if (draftId) {
      const row = draft(state.assistanceDrafts[key(subjectId,draftId)],subjectId);
      if (row.status !== 'editing' || row.revision !== draftRevision || (row.content.eventKind
        ? payload.assistanceId!==row.content.source.assistanceId || JSON.stringify(payload.event)!==JSON.stringify(eventFromDraft(row))
        : payload.event || payload.id!==draftId)) throw new Error('Assistance draft changed; reopen it.');
      row.status = 'prepared'; row.revision++; row.updatedAt = new Date().toISOString();
    }
    const intents = previous?.intents ?? [];
    if (intents.some(item => item.id === intent.id && JSON.stringify(item) !== JSON.stringify(intent))) throw new Error('Assistance Consent already frozen.');
    const row = operation({version:1,endpoint,subjectId,eventId,assistanceId:payload.assistanceId ?? payload.id,
      payloadJson,payloadHash:hash(payloadJson),draftId:previous?.draftId ?? draftId ?? null,
      intents:intents.some(item => item.id === intent.id) ? intents : [...intents,intent],
      status:previous?.status ?? 'prepared',createdAt:previous?.createdAt ?? new Date().toISOString(),updatedAt:new Date().toISOString()},subjectId);
    state.assistanceOperations[id] = row; await write(paths,state); return row;
  }); }
  async function get(eventId) { return withLocalRead(dataDirectory, async directory => {
    const {state,identity} = await load(directory), row = state.assistanceOperations[key(identity.id,eventId)];
    return row ? operation(row,identity.id) : null;
  }); }
  async function list() { return withLocalRead(dataDirectory, async directory => {
    const {state,identity} = await load(directory);
    return {localOnly:true,endpoint,subjectId:identity.id,items:Object.values(state.assistanceOperations)
      .filter(row => row.endpoint === endpoint && row.subjectId === identity.id).map(row => {
        operation(row,identity.id); const payload = JSON.parse(row.payloadJson);
        return {eventId:row.eventId,assistanceId:row.assistanceId,kind:payload.event?.kind ?? 'request',title:payload.title ?? '',status:row.status,updatedAt:row.updatedAt};
      })};
  }); }
  async function mark(eventId,subjectId,status,receipt) { return withLocalWrite(dataDirectory, async directory => {
    const {paths,state} = await load(directory,subjectId), row = operation(state.assistanceOperations[key(subjectId,eventId)],subjectId);
    if (row.status === 'acknowledged') return row;
    if (!['submitting','unknown','conflict','acknowledged'].includes(status)) throw new Error('Invalid Assistance outcome.');
    if (status === 'acknowledged') {
      const payload = JSON.parse(row.payloadJson);
      if (receipt?.assistanceId !== row.assistanceId || receipt.eventId !== eventId || receipt.payloadHash !== row.payloadHash
        || receipt.version !== (payload.event ? payload.event.expectedVersion + 1 : 1) || !row.intents.some(intent => intent.id === receipt.consentId))
        throw new Error('Assistance receipt does not match frozen event.');
      row.receipt = {assistanceId:row.assistanceId,eventId,version:receipt.version,consentId:receipt.consentId,payloadHash:row.payloadHash};
    }
    row.status = status; row.updatedAt = new Date().toISOString(); await write(paths,state); return row;
  }); }
  async function forget(eventId) { return withLocalWrite(dataDirectory, async directory => {
    const {paths,state,identity} = await load(directory), id = key(identity.id,eventId), row = operation(state.assistanceOperations[id],identity.id);
    if (!['prepared','acknowledged'].includes(row.status)) throw new Error('Reconcile an uncertain Assistance outcome before removing its local record.');
    delete state.assistanceOperations[id];
    if (row.draftId) delete state.assistanceDrafts[key(identity.id,row.draftId)];
    await write(paths,state); return {eventId,remoteDeleted:false};
  }); }
  return Object.freeze({createDraft,createEventDraft,rebaseDraft,getDraft,saveDraft,listDrafts,forgetDraft,save,get,list,mark,forget});
}
