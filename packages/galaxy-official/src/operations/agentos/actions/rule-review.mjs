import { isDeepStrictEqual } from 'node:util';
import { p14ControlsSchema } from '../../../shared/p14-rules-schema.mjs';
import { operationsPolicySchemas } from '../../../shared/operations-product-schema.mjs';
import { fail, parse } from './support.mjs';

export const ruleNames = {
  'resource-budget': '资源额度',
  'community-quota': '参与额度',
  'forum-quota': '论坛额度',
  'business-controls': '业务规则与名单',
};
const numericRuleLabels = {
  maxPayloadBytesPerSubject: ['单主体数据存储上限', '字节'],
  maxQueuedJobsPerSubject: ['单主体排队任务上限', '项'],
  maxActiveExportsPerSubject: ['单主体有效导出上限', '项'],
  maxActiveJobsGlobal: ['全服务并行任务', '项'],
  maxActiveJobsPerSubject: ['单主体并行任务', '项'],
  promotionDays: ['转为普通账户所需时间', '天'],
  invitationCooldownDays: ['邀请冷却时间', '天'],
  maxPermissionSeconds: ['内容授权最长时间', '秒'],
  maxGovernanceHideSeconds: ['治理隐藏最长时间', '秒'],
  dailyUsageDays: ['用量记录保留时间', '天'],
  auditDays: ['社区审计保留时间', '天'],
  accountForumMaxBytes: ['单账户社区数据上限', '字节'],
  maxTitleCodePoints: ['标题上限', '字'],
  maxBodyCodePoints: ['帖子上限', '字'],
  maxReplyCodePoints: ['回复上限', '字'],
  maxReportCodePoints: ['举报说明上限', '字'],
  maxLinks: ['链接数量上限', '个'],
  maxLinkCodePoints: ['单链接长度上限', '字'],
  maxPayloadBytes: ['单次内容上限', '字节'],
  maxAppeals: ['每案申诉上限', '次'],
  maxReportEvents: ['每案处理记录上限', '条'],
};
const quotaRuleLabels = {
  task: '任务',
  comment: '评论',
  invitation: '邀请',
  post: '发帖',
  version: '帖子修订',
  reply: '回复',
  report: '举报',
};
export async function ruleDifference(
  key,
  before,
  after,
  catalog,
  accountLabel,
) {
  const schema =
      key === 'business-controls'
        ? p14ControlsSchema
        : operationsPolicySchemas[key],
    old = parse(schema, before),
    next = parse(schema, after),
    lines = [];
  const add = (line) => {
    lines.push(line);
    if (
      line.length > 5000 ||
      lines.length > 80 ||
      lines.reduce((n, x) => n + x.length, 0) > 20000
    )
      fail('operations_agentos_rule_review_required');
  };
  const show = (value) =>
      Number.isSafeInteger(value)
        ? value.toLocaleString('zh-CN')
        : String(value),
    enabled = (value) => (value ? '启用' : '停用');
  if (key !== 'business-controls') {
    for (const field of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (isDeepStrictEqual(old[field], next[field])) continue;
      if (field === 'new' || field === 'normal') {
        for (const category of Object.keys(next[field]))
          if (old[field][category] !== next[field][category])
            add(
              (field === 'new' ? '新账户' : '普通账户') +
                '每日' +
                quotaRuleLabels[category] +
                '额度：' +
                show(old[field][category]) +
                ' 次改为 ' +
                show(next[field][category]) +
                ' 次',
            );
      } else {
        const descriptor = numericRuleLabels[field];
        if (!descriptor) fail('operations_agentos_rule_review_required');
        add(
          descriptor[0] +
            '：' +
            show(old[field]) +
            ' ' +
            descriptor[1] +
            '改为 ' +
            show(next[field]) +
            ' ' +
            descriptor[1],
        );
      }
    }
    return lines;
  }
  const named = (items, key, value) =>
    items?.find((item) => item[key] === value)?.label ?? null;
  for (const [feature, value] of Object.entries(next.features))
    if (old.features[feature] !== value) {
      const name = named(catalog.features, 'key', feature);
      if (!name) fail('operations_agentos_rule_review_required');
      add(
        '功能「' +
          name +
          '」：' +
          enabled(old.features[feature]) +
          '改为' +
          enabled(value),
      );
    }
  const changedLists = new Set(),
    listDescription = (item) =>
      (item.kind === 'domain' ? '域名名单' : '词条名单') +
      '「' +
      item.name +
      '」（' +
      enabled(item.enabled) +
      '）；条目：' +
      (item.entries.length
        ? item.entries.map((value) => '「' + value + '」').join('、')
        : '无');
  for (const id of new Set([
    ...old.lists.map((x) => x.id),
    ...next.lists.map((x) => x.id),
  ])) {
    const a = old.lists.find((x) => x.id === id),
      b = next.lists.find((x) => x.id === id);
    if (isDeepStrictEqual(a, b)) continue;
    changedLists.add(id);
    if (a) add((b ? '原名单：' : '移除名单：') + listDescription(a));
    if (b) add((a ? '改为名单：' : '新增名单：') + listDescription(b));
  }
  const condition = (node, policy) => {
    if (Array.isArray(node.rules))
      return (
        (node.combinator === 'or' ? '满足任一条件' : '同时满足') +
        '（' +
        node.rules.map((child) => condition(child, policy)).join('；') +
        '）'
      );
    const field = catalog.fields?.find((item) => item.name === node.field),
      operator = field?.operators?.find(
        (item) => item.name === node.operator,
      )?.label;
    if (!field || !operator) fail('operations_agentos_rule_review_required');
    const value = ['keywordList', 'domainList'].includes(node.field)
      ? policy.lists.find((item) => item.id === node.value)?.name
      : (field.values?.find((item) => item.name === node.value)?.label ??
        show(node.value));
    if (value === undefined) fail('operations_agentos_rule_review_required');
    return field.label + ' ' + operator + ' ' + value;
  };
  const ruleDescription = async (rule, policy) => {
    const targets = rule.targets.map((value) =>
      named(catalog.targets, 'key', value),
    );
    if (targets.some((x) => !x))
      fail('operations_agentos_rule_review_required');
    const exceptions = [];
    for (const exception of rule.exceptions) {
      const people = [];
      for (const id of exception.accountIds)
        people.push(await accountLabel(id));
      exceptions.push(
        '「' +
          exception.name +
          '」（' +
          enabled(exception.enabled) +
          '）：' +
          people.join('、'),
      );
    }
    return (
      '「' +
      rule.name +
      '」（' +
      enabled(rule.enabled) +
      '）；适用' +
      targets.join('、') +
      '；' +
      condition(rule.conditions, policy) +
      '；命中后停止本次新操作；例外：' +
      (exceptions.join('；') || '无')
    );
  };
  const changedReference = (node) =>
    Array.isArray(node?.rules)
      ? node.rules.some(changedReference)
      : changedLists.has(node?.value);
  for (const id of new Set([
    ...old.rules.map((x) => x.id),
    ...next.rules.map((x) => x.id),
  ])) {
    const a = old.rules.find((x) => x.id === id),
      b = next.rules.find((x) => x.id === id);
    if (
      isDeepStrictEqual(a, b) &&
      !changedReference(a?.conditions) &&
      !changedReference(b?.conditions)
    )
      continue;
    if (a)
      add((b ? '原规则：' : '移除规则：') + (await ruleDescription(a, old)));
    if (b)
      add((a ? '改为规则：' : '新增规则：') + (await ruleDescription(b, next)));
  }
  return lines;
}
