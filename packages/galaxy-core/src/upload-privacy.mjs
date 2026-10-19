import {assertNoWorkCredentials} from './local-data-redaction.mjs';

// Local upload selection only. Online account discovery/public visibility is
// configured independently and is never inferred from these settings.
export const DEFAULT_UPLOAD_PRIVACY_LEVEL = 'history-overview';
export const UPLOAD_PRIVACY_LEVELS = Object.freeze([
  Object.freeze({id: 'local-only', number: 1, title: '仅本地', titleEn: 'Local only', dataTypes: Object.freeze([]), description: '不允许上传本地工作资料。'}),
  Object.freeze({id: 'history-overview', number: 2, title: '履历概况', titleEn: 'History overview', dataTypes: Object.freeze(['history-metadata', 'environment-versions']), description: '只允许所选工作类型、角色、时间、结果状态及来源标识和主要模型工具版本；不含任务正文、过程摘要、项目客户名或路径。'}),
  Object.freeze({id: 'work-content', number: 3, title: '选定工作内容', titleEn: 'Selected work content', dataTypes: Object.freeze(['history-metadata', 'environment-versions', 'work-summary', 'work-content', 'work-artifact']), description: '另允许所选工作的具体说明、过程摘要和选定材料，不包含完整会话。'}),
  Object.freeze({id: 'conversation-archive', number: 4, title: '完整会话可选', titleEn: 'Optional conversation archive', dataTypes: Object.freeze(['history-metadata', 'environment-versions', 'work-summary', 'work-content', 'work-artifact']), description: '完整会话仍默认排除；另行启用并选定会话后才允许该范围，凭据始终排除。'}),
]);

const levelById = new Map(UPLOAD_PRIVACY_LEVELS.map(level => [level.id, level]));
const fail = code => { throw Object.assign(new Error(code), {code}); };

export function defaultUploadPrivacy() {
  return {version: 1, revision: 0, level: DEFAULT_UPLOAD_PRIVACY_LEVEL, includeFullConversations: false, sessionIds: []};
}

export function listUploadPrivacyLevels() {
  return UPLOAD_PRIVACY_LEVELS.map(level => ({...level, dataTypes: [...level.dataTypes], defaultSelected: level.id === DEFAULT_UPLOAD_PRIVACY_LEVEL}));
}

export function normalizeUploadPrivacy(value) {
  if (!value || !levelById.has(value.level)) return defaultUploadPrivacy();
  const sessionIds = Array.isArray(value.sessionIds)
    ? [...new Set(value.sessionIds.filter(id => typeof id === 'string' && id.trim() && id.length <= 512).map(id => id.trim()))].slice(0, 500)
    : [];
  const includeFullConversations = value.level === 'conversation-archive' && value.includeFullConversations === true && sessionIds.length > 0;
  return {version: 1, revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    level: value.level, includeFullConversations, sessionIds: includeFullConversations ? sessionIds : [],
    ...(typeof value.updatedAt === 'string' ? {updatedAt: value.updatedAt} : {})};
}

/** Validate an explicit local selection; never enlarges a partial selection. */
export function selectUploadPrivacy(current, input, updatedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('upload_privacy_input_invalid');
  const old = normalizeUploadPrivacy(current);
  const level = input.level ?? old.level;
  if (!levelById.has(level)) fail('upload_privacy_level_invalid');
  if (input.includeFullConversations !== undefined && typeof input.includeFullConversations !== 'boolean') fail('upload_privacy_input_invalid');
  if (input.sessionIds !== undefined && (!Array.isArray(input.sessionIds) || input.sessionIds.length > 500 || input.sessionIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512))) fail('upload_privacy_session_scope_invalid');
  const include = input.includeFullConversations ?? (level === old.level && old.includeFullConversations);
  const sessionIds = input.sessionIds === undefined ? old.sessionIds : [...new Set(input.sessionIds.map(id => id.trim()))];
  if (include && level !== 'conversation-archive') {
    // Lowering a level disables the separate archive choice. Asking to enable
    // it on a lower level is an invalid explicit request.
    if (input.includeFullConversations === true) fail('upload_privacy_conversation_level_required');
  }
  const enabled = level === 'conversation-archive' && include;
  if (enabled && sessionIds.length === 0) fail('upload_privacy_session_scope_required');
  if(old.level===level&&old.includeFullConversations===enabled&&JSON.stringify([...old.sessionIds].sort())===JSON.stringify([...(enabled?sessionIds:[])].sort()))return old;
  return {version: 1, revision: old.revision + 1, level, includeFullConversations: enabled,
    sessionIds: enabled ? sessionIds : [], ...(updatedAt ? {updatedAt} : {})};
}

export function allowedUploadDataTypes(value) {
  const settings = normalizeUploadPrivacy(value);
  return [...levelById.get(settings.level).dataTypes, ...(settings.includeFullConversations ? ['full-conversation'] : [])];
}

/** Sender must also have a current selected destination and exact data scope.
 * This function only answers whether the local data-type selection permits it.
 */
export function allowsUploadDataType(value, dataType, {sessionId} = {}) {
  const settings = normalizeUploadPrivacy(value);
  if (dataType === 'full-conversation') return settings.includeFullConversations && typeof sessionId === 'string' && settings.sessionIds.includes(sessionId);
  return levelById.get(settings.level).dataTypes.includes(dataType);
}

const workTypes=new Set(['unknown','development','research','writing','design','operations','analysis','learning','other']);
const workRoles=new Set(['unknown','owner','participant','contributor','reviewer','observer']);
const outcomes=new Set(['unknown','reported-success','reported-failure','partial','cancelled']);
const technicalId=value=>typeof value==='string'&&!/^[a-z]:\//i.test(value)&&/^[a-zA-Z0-9][a-zA-Z0-9_.:+-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.:+-]*)?$/.test(value)&&value.length<=128;
const hostIds=new Set(['opencode','codex','claude-code','claude','gemini-cli','cursor','vscode','windsurf','openclaw','mcp','host','unknown']);
function environmentVersions(environment) {
  const facts={};
  for(const key of ['host','hostVersion','platform','architecture','runtime','runtimeVersion','selectedModel','actualModel'])
    if(technicalId(environment.facts?.[key]))facts[key]=environment.facts[key];
  if(Array.isArray(environment.facts?.tools))facts.tools=environment.facts.tools.filter(value=>technicalId(value)&&!value.includes('/')).slice(0,256);
  return {id:environment.id,version:environment.version,observedAt:environment.observedAt,facts};
}

/** Field projection from the actual local work shape, before authorization or
 * signing. Raw observations cannot ride inside a level-2 summary envelope. */
export function projectWorkHistoryForUpload(value, record) {
  const settings = normalizeUploadPrivacy(value);
  const work = record?.work;
  if (!work) fail('local_work_upload_source_required');
  if (settings.level === 'local-only') return {data:null,omittedDataTypes:['history-metadata','environment-versions','work-summary','work-content'],uploadStarted:false};
  const result = {workId:work.workId,galaxyId:work.galaxyId,source:{host:hostIds.has(work.host)?work.host:'unknown',
    ...(/^[a-zA-Z0-9_-]{1,256}$/.test(work.sessionId??'')?{sessionId:work.sessionId}:{})},uploadLevel:settings.level,
    workType:workTypes.has(work.workType)?work.workType:'unknown',role:workRoles.has(work.role)?work.role:'unknown',
    startedAt:work.startedAt,updatedAt:work.updatedAt,resultStatus:outcomes.has(work.outcome)?work.outcome:'unknown',
    resultSource:work.sourceKind==='user-model'?'user-model':'host-observations'};
  const omittedDataTypes = [];
  if (allowsUploadDataType(settings,'work-summary')) {
    result.summary = {title:work.title??'',summary:work.summary??'',outcome:work.outcome,summaryRevision:work.summaryRevision,
      sourceKind:work.summary&&work.sourceKind==='user-model'?'user-model':'host-observations',updatedAt:work.updatedAt};
  } else if(work.summary||work.title)omittedDataTypes.push('work-summary');
  if (allowsUploadDataType(settings,'environment-versions')) result.environments = (record.environments ?? []).map(environmentVersions);
  else omittedDataTypes.push('environment-versions');
  if (allowsUploadDataType(settings,'work-content')) result.observations = record.observations ?? [];
  else if (record.observations?.length) omittedDataTypes.push('work-content');
  assertNoWorkCredentials(result);
  return {data:result,omittedDataTypes,uploadStarted:false};
}

export function projectConversationForUpload(value, archive) {
  const sessionId = archive?.session?.archiveSessionId;
  if (!allowsUploadDataType(value,'full-conversation',{sessionId})) fail('upload_privacy_conversation_scope_not_allowed');
  assertNoWorkCredentials(archive.messages);
  return {data:{galaxyId:archive.galaxyId,session:archive.session,messages:archive.messages,
    nextAfter:archive.nextAfter,coverage:archive.coverage,...(archive.selectedCoverage?{selectedCoverage:archive.selectedCoverage}:{}),completeConversation:archive.completeConversation},uploadStarted:false};
}

/** For an already reviewed/signed payload, reject instead of silently rewriting
 * bytes. Ordinary account actions/publication aren't classified as local data.
 */
export function assertNativeUploadAllowed(value, path, input, {dataTypes = [],sessionId} = {}) {
  const required = [...dataTypes];
  let payload = input;
  if (typeof input?.payloadJson === 'string') {
    try {payload = JSON.parse(input.payloadJson);} catch {fail('local_upload_payload_invalid');}
  }
  if (path === '/v2/context/grants' && payload?.materials?.length) {required.push('work-content');assertNoWorkCredentials(payload.materials);}
  if (path === '/v2/personal-summaries/put' && input?.content) {
    required.push('work-summary');
    assertNoWorkCredentials(input.content);
    if (input.content.fragments?.some(fragment => fragment.kind === 'personal-note')) required.push('work-content');
  }
  if (/^\/v2\/cases\/(?:events|[^/]+\/events)$/.test(path)) required.push('work-summary');
  // A local-context attachment is typed at its source. It is not inferred from
  // prose, and unknown/missing types can never masquerade as a summary.
  if (input?.localContext !== undefined && !Array.isArray(input.localContext)) fail('local_upload_data_type_required');
  for (const item of input?.localContext ?? []) {
    if (!item || !['history-metadata','environment-versions','work-summary','work-content','work-artifact','full-conversation'].includes(item.dataType)) fail('local_upload_data_type_required');
    assertNoWorkCredentials(item);
    if (!allowsUploadDataType(value,item.dataType,{sessionId:item.sessionId})) fail('local_upload_type_not_allowed');
  }
  for (const type of new Set(required)) if (!allowsUploadDataType(value,type,{sessionId})) fail('local_upload_type_not_allowed');
  if(dataTypes.length)assertNoWorkCredentials(payload);
  return input;
}
