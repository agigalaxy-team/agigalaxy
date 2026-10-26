import {
  fail,
  label,
  stateNames,
  moduleNames,
  cap,
  pick,
  count,
  restrictionTime,
  requiredActionFor,
} from './support.mjs';

export async function prepareAccountRestriction({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('accounts', 'get').get(actor, x.targetId),
    account = item.account,
    restriction = account?.restriction;
  if (
    account?.accountId !== x.targetId ||
    restriction?.scope !== 'community-participation' ||
    count(restriction.revision) === null ||
    typeof restriction.active !== 'boolean'
  )
    fail('operations_agentos_operation_unavailable');
  expiry(
    item.readExpiresAt ??
      (Number.isSafeInteger(item.checkedAt) ? item.checkedAt + 30 : null),
  );
  cap(
    x.action === 'apply'
      ? item.permissions?.canRestrict
      : item.permissions?.canRelease,
  );
  if (x.action === 'apply' && Date.parse(x.until) <= this.now() * 1000)
    fail('operations_agentos_restriction_deadline');
  if (
    x.action === 'release' &&
    (!restriction.active ||
      !Number.isFinite(Date.parse(restriction.until)) ||
      Date.parse(restriction.until) <= this.now() * 1000)
  )
    fail('operations_agentos_restriction_inactive');
  const name = label(account.displayName, null),
    uid = label(account.uid, null);
  if (!name && !uid) fail('operations_agentos_operation_unavailable');
  const target = {
    kind: 'account',
    id: x.targetId,
    label: name
      ? uid && uid !== name
        ? name + '（UID ' + uid + '）'
        : name
      : 'UID ' + uid,
    href: '/admin/operations/users?account=' + x.targetId + '&tab=restrictions',
  };
  const title =
    x.action === 'release'
      ? '解除此账户参与限制'
      : restriction.active
        ? '调整此账户参与限制'
        : '限制此账户参与';
  const requiredAction = requiredActionFor(x);
  const command = {
    expectedRevision: restriction.revision,
    reason: x.reason,
    ...(x.action === 'apply' ? { until: x.until } : {}),
  };
  basis = [
    {
      label: '当前参与状态',
      value: restriction.active
        ? '限制至北京时间 ' + restrictionTime(restriction.until)
        : '当前没有生效的参与限制',
    },
  ];
  impact = [
    x.action === 'release'
      ? '解除当前这一版账户参与限制，其他内容治理、权限和额度仍按原条件执行。'
      : (restriction.active ? '本次将现有限制调整为' : '本次限制生效至') +
        '北京时间 ' +
        restrictionTime(x.until) +
        '。',
    '现有业务参与总门覆盖帖子发布与修订、回复、任务发布、评论、邀请、聊天发送与编辑及相关上传。',
    '这项限制不关闭登录、不删除已有内容；已有读取、撤回和退出仍按各自权限执行。',
    '处理原因：' + x.reason,
  ];
  expiry(
    Math.floor(
      Date.parse(x.action === 'apply' ? x.until : restriction.until) / 1000,
    ),
  );
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareFeedback({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const response = await this.service('feedback', 'get').get(actor, x.targetId),
    item = response.feedback;
  cap(response.permissions?.canManage);
  expiry(response.readExpiresAt);
  const target = {
    kind: 'feedback',
    id: x.targetId,
    label: label(item.title, '使用反馈'),
    href: '/admin/operations/feedback?id=' + x.targetId,
  };
  const title = '更新这条使用反馈';
  const requiredAction = 'feedback.update';
  const command = {
    expectedRevision: item.revision,
    ...pick(x, ['category', 'module', 'state', 'note']),
  };
  basis = [{ label: '当前状态', value: stateNames[item.state] ?? '未记录' }];
  impact = [
    ...(x.state === undefined ? [] : ['状态：' + stateNames[x.state]]),
    ...(Object.hasOwn(x, 'category')
      ? [
          '分类：' +
            (x.category === null
              ? '未分类'
              : x.category === 'problem'
                ? '问题'
                : '建议'),
        ]
      : []),
    ...(x.module === undefined ? [] : ['所属模块：' + moduleNames[x.module]]),
    ...(x.note ? ['添加内部备注：' + x.note] : []),
  ];
  return { target, title, requiredAction, command, impact, basis };
}
