import { ServiceError } from '../../../shared/service-error.mjs';
import { workbenchPrepareSchemas } from "../action-catalog.mjs";

export const fail = (code, status = 409) => {
  throw new ServiceError(code, status);
};
export const parse = (schema, value) => {
  const result = schema?.safeParse(value);
  if (!result?.success) fail('invalid_operations_agentos_action', 400);
  return result.data;
};
export const label = (value, fallback) =>
  typeof value === 'string' && value.trim()
    ? value
        .replace(/[\p{Cc}]/gu, ' ')
        .trim()
        .slice(0, 180)
    : fallback;
export const categoryNames = {
  technology: '科技',
  arts: '艺术',
  learning: '学习',
  life: '生活',
  galaxy: '银河',
  unclassified: '未分类',
};
export const stateNames = {
  pending: '待处理',
  processing: '处理中',
  closed: '已关闭',
};
export const recommendationDirectionNames = {
  increase: '增加',
  keep: '保持',
  decrease: '减少',
};
export const moduleNames = {
  account: '账户',
  community: '社区',
  chat: '聊天',
  work: '协作',
  discovery: '发现',
  other: '其他',
};
export const cap = (value) => {
  if (value !== true) fail('operations_agentos_operation_unavailable');
};
export const pick = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
export const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
export const restrictionTime = (value) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
export const safeReceipt = (value) => ({
  operationId:
    typeof value?.operationId === 'string' ? value.operationId : null,
  publishedVersion: count(value?.publishedVersion),
  version: count(
    value?.version ?? value?.content?.version ?? value?.plan?.version,
  ),
  revision: count(
    value?.revision ??
      value?.visibility?.version ??
      value?.content?.visibility?.version ??
      value?.plan?.revision,
  ),
  hidden:
    typeof (value?.visibility?.hidden ?? value?.content?.visibility?.hidden) ===
    'boolean'
      ? (value.visibility?.hidden ?? value.content.visibility.hidden)
      : null,
  state: [
    'scheduled',
    'active',
    'paused',
    'stopped',
    'draft',
    'resolved',
    'prepared',
    'running',
    'awaiting-human',
    'completed',
    'blocked',
    'no-action',
    'unknown',
    'active-for-new-matters',
  ].includes(value?.state ?? value?.plan?.state ?? value?.run?.state)
    ? (value.state ?? value.plan?.state ?? value.run?.state)
    : null,
  phase: [
    'prepared',
    'submitting',
    'task-pending',
    'applied',
    'failed',
    'result-unknown',
  ].includes(value?.phase)
    ? value.phase
    : null,
  replayed: value?.replayed === true,
});
export const requestSchema = (value) => workbenchPrepareSchemas[value?.kind];
// This is the permission required by the prepared command, independently of
// the catalog read permission used while assembling its review card.
export function requiredActionFor(x) {
  switch (x.kind) {
    case 'job-cancel':
      return 'jobs.cancel';
    case 'job-retry':
      return 'jobs.retry';
    case 'search-retry':
      return 'search.retry';
    case 'ai-work-prompt-save':
      return 'ai.prompts.update';
    case 'ai-role-command':
      return (
        'ai.roles.' +
        (x.command.kind === 'role-create'
          ? 'create'
          : x.command.kind === 'role-update'
            ? 'update'
            : x.command.enabled
              ? 'assign'
              : 'revoke')
      );
    case 'public-content-batch':
      return 'content.batch.' + x.action;
    case 'private-case-message':
      return 'chat-messages.' + x.action;
    case 'ordinary-strategy-draft':
      return 'strategies.ordinary.configure';
    case 'ordinary-strategy-publish':
      return 'strategies.ordinary.publish';
    case 'recommendation-direction':
      return 'recommendations.configure';
    case 'content-visibility':
      return 'content.' + x.action;
    case 'content-curation':
      return 'content.curate';
    case 'section-classification':
      return 'sections.classify';
    case 'section-visibility':
      return 'sections.' + x.action;
    case 'resource-visibility':
      return 'resources.' + x.action;
    case 'account-restriction':
      return 'accounts.restriction.' + x.action;
    case 'feedback-update':
      return 'feedback.update';
    case 'file-scan-retry':
      return 'files.scan.retry';
    case 'file-access':
      return 'files.access.' + x.action;
    case 'file-cleanup-approve':
      return 'files.cleanup.approve';
    case 'case-resolve':
      return 'cases.resolve';
    case 'message-draft-create':
      return 'notices.create';
    case 'message-draft-save':
      return 'notices.update';
    case 'messaging-state':
      return ['activate', 'resume'].includes(x.action)
        ? 'notices.publish'
        : 'notices.withdraw';
    case 'strategy-control':
      return 'strategies.control';
    case 'strategy-continue':
      return 'strategies.run';
    case 'rule-publish':
    case 'rule-restore':
      return 'rules.write';
    case 'search-apply':
      return 'search-quality.publish';
    default:
      return 'search-quality.restore';
  }
}
export const humanDraftConfig = (config) => ({
  ...config,
  automation: { kind: 'human-required', factsConfirmed: false },
});
export const unknownFeedbackResult = (operationId) => ({
  operationId,
  state: 'unknown',
  summary: '本次反馈处理结果尚未核实，系统会继续查询原结果。',
  receipt: null,
});
export const unknownRecommendationResult = (operationId) => ({
  operationId,
  state: 'unknown',
  summary: '推荐方向保存结果暂未核实，正在查询原结果。',
  receipt: null,
});
export const recommendationPolicyInput = (input) =>
  pick(input, [
    'operationId',
    'expectedVersion',
    'enabled',
    'themeKey',
    'direction',
    'controls',
    'reason',
  ]);
