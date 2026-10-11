import * as z from 'zod/v4';
import { postPublicJson, fetchAssistanceJson, validatePublicUrl } from './public-fetch.mjs';
import { taskRequestV2Schema, taskReceiptV2Schema, taskQueryV2Schema, taskEnvelopeV2Schema, participationProposalV2Schema, participationEventV2Schema } from './shared/task-schema-v2.mjs';
import { contextGrantV2Schema, contextEventV2Schema, contextReceiptV2Schema } from './shared/context-v2-schema.mjs';
import { caseEventV2Schema, caseTaskLinkSchema, caseEventReceiptSchema, caseTaskLinkReceiptSchema } from './shared/cases-schema.mjs';
import { caseTaskLinkPayloadHash, legacyCaseTaskLinkPayloadHash } from './shared/case-operation-hash.mjs';
import {taskCreationSubmissionSchema,taskMaterialPrepareSchema,taskMaterialPrepareResultSchema,taskMaterialDescriptorSchema,hasTaskMaterials,taskMaterialBodyIssue,taskMaterialLimits} from './shared/task-material-v1-schema.mjs';
import {sha256Hex} from './shared/web-primitives.mjs';

// Existing signed Consent is the payload authorization, not an input boolean.
// A transport/session lease is checked both before and after every request.
export function createTaskClientV2({ endpoint, sessions, send = postPublicJson, read = fetchAssistanceJson }) {
  if (validatePublicUrl(endpoint).origin !== endpoint || !sessions) throw new Error('Invalid Task client configuration.');
  async function invoke(path, body, { signal, method = 'POST', scope = 'assistance',validate=null } = {}) {
    signal?.throwIfAborted();
    const auth = await sessions.readAuthorization(endpoint);
    if (!auth?.scopes.includes(scope)) throw new Error('Task authorization required.');
    const check = async () => {
      signal?.throwIfAborted();
      if (!sessions.matchesAuthorization(auth) || !await sessions.isAuthorizationCurrent(auth)) throw new Error('Task authorization changed.');
      signal?.throwIfAborted();
    };
    try {
      await check();
      const options = { credential: auth.credential, signal, maxBytes: 1048576 };
      const result = method === 'GET' ? await read(endpoint + path, options) : await send(endpoint + path, { ...options, bodyJson: JSON.stringify(body) });
      await check();if(validate)await validate(result,check);await check(); return result;
    } catch (error) { if (error.code === 'GALAXY_REMOTE_REJECTED') sessions.invalidateAuthorization(auth, 'remote-rejected'); throw error; }
  }
  function task(result, id) {
    if (result?.taskId !== id || !Number.isInteger(result.version) || result.version < 1 || result.paymentExecuted !== false
      || result.contextAccessGranted !== false
      || !(result.schemaVersion === 2 && result.roomMembershipGranted === false
        || result.schemaVersion === 1 && result.compatibility?.source === 'legacy-v1' && result.compatibility.v2Writes === false)) throw new Error('Invalid Task response.');
    return result;
  }
  async function createTask(submission, options) {
    taskCreationSubmissionSchema.parse(submission);
    const request = taskRequestV2Schema.parse(JSON.parse(submission.payloadJson));
    if(hasTaskMaterials(request)!==Object.hasOwn(submission,'signedIntent')||hasTaskMaterials(request)&&taskMaterialBodyIssue(request,submission.materialBodies))throw new Error('Invalid Task material submission.');
    if(new TextEncoder().encode(JSON.stringify(submission)).length>(hasTaskMaterials(request)?taskMaterialLimits.envelopeBytes:taskMaterialLimits.legacyEnvelopeBytes))throw new Error('Task request byte limit exceeded.');
    const result = await invoke('/v2/tasks', submission, options);
    if (result?.taskId !== request.taskId || result.eventId !== request.operationId || result.version !== 1) throw new Error('Unknown Task creation outcome; query original receipt.');
    return result;
  }
  async function getTask(id, options) { z.uuid().parse(id); return task(await invoke(`/v2/tasks/${id}`, null, { ...options, method: 'GET' }), id); }
  async function prepareTaskMaterials(input,options={}){
    const request=taskMaterialPrepareSchema.parse(input);
    return invoke('/v2/task-materials/prepare',request,{...options,validate:async(result,check)=>{
      const value=taskMaterialPrepareResultSchema.parse(result);
      if(value.source.endpoint!==endpoint||value.source.postId!==request.source.postId||value.source.versionId!==request.source.versionId||value.descriptors.length!==request.selections.length||value.materialBodies.length!==request.selections.length)throw new Error('Invalid Task material preview.');
      for(let i=0;i<request.selections.length;i++){
        const selection=request.selections[i],descriptor=value.descriptors[i],body=value.materialBodies[i];
        if(descriptor.materialId!==selection.materialId||body.materialId!==selection.materialId||descriptor.expiresAt!==request.expiresAt||descriptor.source.field!==selection.field||descriptor.source.start!==selection.start||descriptor.source.end!==selection.end
          ||descriptor.source.endpoint!==endpoint||descriptor.source.postId!==request.source.postId||descriptor.source.versionId!==request.source.versionId||descriptor.source.permissionId!==value.source.permissionId||descriptor.source.payloadHash!==value.source.payloadHash||selection.text!==undefined&&body.text!==selection.text)throw new Error('Invalid Task material preview.');
        await check();const textHash=await sha256Hex(body.text);await check();if(textHash!==descriptor.textHash)throw new Error('Invalid Task material body.');
      }
    }});
  }
  async function taskMaterialStatus(taskId,options){
    z.uuid().parse(taskId);
    return invoke(`/v2/tasks/${taskId}/materials/status`,null,{...options,method:'GET',validate:async result=>{
      if(result?.taskId!==taskId||!Number.isInteger(result.checkedAt)||!Array.isArray(result.items)||result.items.length>8)throw new Error('Invalid Task material status.');
      for(const item of result.items){taskMaterialDescriptorSchema.parse(item.descriptor);if(item.materialId!==item.descriptor.materialId||!['available','unavailable'].includes(item.status)||typeof item.permanent!=='boolean'||!Array.isArray(item.reasons)||Object.hasOwn(item,'text'))throw new Error('Invalid Task material status.');}
    }});
  }
  async function taskReceipt(input, options) {
    const query = taskReceiptV2Schema.parse(input), result = await invoke('/v2/tasks/receipt', query, options);
    if (!result || Object.entries(query).some(([key, value]) => result[key] !== value) || !['absent', 'acknowledged', 'conflict'].includes(result.state)
      || result.state === 'acknowledged' && (!Number.isInteger(result.version) || result.version < 1)) throw new Error('Invalid Task receipt.');
    return result;
  }
  async function queryTasks(input = {}, options) {
    const query = taskQueryV2Schema.parse(input), result = await invoke('/v2/tasks/query', query, options);
    if (!result || !Array.isArray(result.items) || result.items.length > query.limit || result.coverage !== 'visible-page-only'
      || !(result.nextAfter === null || z.uuid().safeParse(result.nextAfter).success)) throw new Error('Invalid Task page.');
    result.items.forEach(item => task(item, z.uuid().parse(item.taskId))); return result;
  }
  async function submit(path, submission, schema, taskId, participationId, options) {
    z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) }).parse(submission);
    const payload = schema.parse(JSON.parse(submission.payloadJson)), eventId = payload.event?.eventId ?? payload.eventId;
    const result = await invoke(path, submission, options);
    if (result?.taskId !== taskId || result.eventId !== eventId || !Number.isInteger(result.version) || result.version < 1
      || participationId && result.participationId !== participationId) throw new Error('Unknown Task event outcome; query original receipt.');
    return result;
  }
  const submitTaskEvent = (taskId, submission, options) => submit(`/v2/tasks/${z.uuid().parse(taskId)}/events`, submission, taskEnvelopeV2Schema, taskId, null, options);
  const proposeParticipation = (taskId, submission, options) => submit(`/v2/tasks/${z.uuid().parse(taskId)}/participations`, submission, participationProposalV2Schema,
    taskId, participationProposalV2Schema.parse(JSON.parse(submission.payloadJson)).participationId, options);
  const submitParticipationEvent = (taskId, participationId, submission, options) => submit(`/v2/participations/${z.uuid().parse(participationId)}/events`, submission,
    participationEventV2Schema, z.uuid().parse(taskId), participationId, options);
  async function getContext(grantId, options) {
    const result = await invoke(`/v2/context/${z.uuid().parse(grantId)}/metadata`, null, { ...options, scope: 'context', method: 'GET' });
    if (result?.metadata?.grantId !== grantId || result.contextAccessGranted !== false || !Array.isArray(result.materials)
      || result.materials.some(item => Object.hasOwn(item, 'content'))) throw new Error('Invalid Context metadata.');
    return result;
  }
  async function contextReceipt(input, options) {
    const query = contextReceiptV2Schema.parse(input), result = await invoke('/v2/context/receipt', query, { ...options, scope: 'context' });
    if (!result || Object.entries(query).some(([key, value]) => result[key] !== value) || !['absent', 'acknowledged', 'conflict'].includes(result.state)) throw new Error('Invalid Context receipt.');
    return result;
  }
  async function contextSubmit(submission, grant, options) {
    z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(40000) }).parse(submission);
    const payload = (grant ? contextGrantV2Schema : contextEventV2Schema).parse(JSON.parse(submission.payloadJson));
    const grantId = grant ? payload.id : payload.grantId;
    const result = await invoke(grant ? '/v2/context/grants' : `/v2/context/${grantId}/events`, submission, { ...options, scope: 'context' });
    if (result?.grantId !== grantId || result.eventId !== payload.id
      || !['recorded-awaiting-recipient-acceptance','accepted','declined','revoked','acknowledged'].includes(result.state)) throw new Error('Unknown Context outcome; query original receipt.');
    return result;
  }
  async function caseReceipt(input, options) {
    const query = caseEventReceiptSchema.parse(input);
    const result = await invoke('/v2/cases/events/receipt', query, { ...options, scope: 'case-teaser' });
    return validateFactReceipt(query, result, false);
  }
  async function taskCaseLinkReceipt(input, options) {
    const query = caseTaskLinkReceiptSchema.parse(input), { taskId, ...body } = query;
    const result = await invoke(`/v2/tasks/${taskId}/case-link/receipt`, body, { ...options, scope: 'case-teaser' });
    return validateFactReceipt(query, result, true);
  }
  function validateFactReceipt(query, result, link) {
    const allowed = new Set([...Object.keys(query), 'state', 'checkedAt', 'authority', 'currentAccessGranted',
      ...(link ? ['caseId', 'caseVersion', 'taskVersion', 'taskCaseLinkVersion'] : ['caseVersion', 'verification', 'acceptance', 'resolution'])]);
    if (!result || Object.keys(result).some(key => !allowed.has(key))
      || Object.entries(query).some(([key, value]) => result[key] !== value)
      || !['absent', 'acknowledged', 'conflict'].includes(result.state)
      || result.authority !== 'accepted-operation-only' || result.currentAccessGranted !== false
      || !z.iso.datetime().safeParse(result.checkedAt).success
      || result.state === 'acknowledged' && (!Number.isInteger(result.caseVersion) || result.caseVersion < 1
        || link && (!z.uuid().safeParse(result.caseId).success || !Number.isInteger(result.taskVersion) || result.taskVersion < 1 || result.taskCaseLinkVersion !== 1)
        || !link && (result.verification !== 'not-provided' || result.acceptance !== 'not-provided' || result.resolution !== 'separate'))) throw new Error('Invalid Case receipt.');
    return result;
  }
  async function submitCaseFact(submission, options) {
    z.strictObject({ consentId: z.uuid(), payloadJson: z.string().min(1).max(24000) }).parse(submission);
    const event = caseEventV2Schema.parse(JSON.parse(submission.payloadJson));
    const result = await invoke('/v2/cases/events', submission, { ...options, scope: 'case-teaser' });
    if (result?.caseId !== event.caseId || result.eventId !== event.eventId || !Number.isInteger(result.caseVersion) || result.caseVersion < 1)
      throw new Error('Unknown Case event outcome; query original receipt.');
    return result;
  }
  async function createTaskCaseLink(input, options) {
    const command = caseTaskLinkSchema.parse(input);
    const root = caseEventV2Schema.parse(JSON.parse(command.case.payloadJson));
    const result = await invoke(`/v2/tasks/${command.taskId}/case`, command, { ...options, scope: 'case-teaser' });
    if (result?.operationId !== command.operationId || result.taskId !== command.taskId || result.caseId !== root.caseId
      || ![caseTaskLinkPayloadHash(command), legacyCaseTaskLinkPayloadHash(command)].includes(result.payloadHash))
      throw new Error('Unknown Task Case link outcome; query original receipt.');
    return result;
  }
  return { createTask, getTask, taskReceipt, queryTasks,prepareTaskMaterials,taskMaterialStatus,submitTaskEvent, proposeParticipation, submitParticipationEvent,
    getContext, contextReceipt, caseReceipt, taskCaseLinkReceipt, submitCaseFact, createTaskCaseLink,
    createContextGrant: (submission, options) => contextSubmit(submission, true, options),
    submitContextEvent: (submission, options) => contextSubmit(submission, false, options) };
}
