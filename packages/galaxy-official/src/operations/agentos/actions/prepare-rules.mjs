import { fail, label, cap } from './support.mjs';
import { ruleNames, ruleDifference } from './rule-review.mjs';

export async function prepareRules({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const service = this.service('rules', 'get'),
    item = await service.get(actor, x.key);
  expiry(item.readExpiresAt);
  cap(
    x.kind === 'rule-publish'
      ? item.capabilities?.canPublish
      : item.capabilities?.canRestore,
  );
  await this.human(actor, 'rules.write');
  let version = item.draft;
  if (x.kind === 'rule-restore') {
    version = item.active?.id === x.versionId ? item.active : null;
    let after = null,
      complete = false;
    for (let page = 0; !version && page < 5; page++) {
      const history = await service.versions(actor, x.key, {
        limit: 50,
        ...(after ? { after } : {}),
      });
      expiry(history.readExpiresAt);
      version =
        history.items?.find((row) => row.version?.id === x.versionId)
          ?.version ??
        (history.baseline?.id === x.versionId ? history.baseline : null);
      if (!history.nextAfter) {
        complete = true;
        break;
      }
      if (history.nextAfter === after)
        fail('operations_agentos_rule_review_required');
      after = history.nextAfter;
    }
    if (!version)
      fail(
        complete
          ? 'operations_rule_version_unavailable'
          : 'operations_agentos_rule_review_required',
        complete ? 404 : 409,
      );
    if (
      !Number.isSafeInteger(version.publishedVersion) ||
      version.publishedVersion < 1
    )
      fail('operations_rule_version_not_published');
  }
  if (!version || version.key !== x.key) fail('operations_rule_draft_changed');
  const accountNames = new Map(),
    accountName = async (id) => {
      if (accountNames.has(id)) return accountNames.get(id);
      if (accountNames.size >= 100)
        fail('operations_agentos_rule_review_required');
      const current = await this.service('accounts', 'get').get(actor, id),
        account = current.account;
      expiry(current.readExpiresAt);
      const name = label(account?.displayName, null),
        uid = label(account?.uid, null);
      if (!name && !uid) fail('operations_agentos_rule_review_required');
      const value = name
        ? uid && uid !== name
          ? name + '（UID ' + uid + '）'
          : name
        : 'UID ' + uid;
      accountNames.set(id, value);
      return value;
    };
  const differences = await ruleDifference(
    x.key,
    item.active?.policy,
    version.policy,
    item.catalog ?? {},
    accountName,
  );
  const target = {
    kind: 'rule',
    id: x.key,
    label: ruleNames[x.key],
    href:
      '/admin/operations/rules?key=' +
      encodeURIComponent(x.key) +
      '&version=' +
      version.id,
  };
  const title =
    x.kind === 'rule-publish'
      ? '发布这份' + ruleNames[x.key] + '草稿'
      : '恢复这份' + ruleNames[x.key] + '历史内容';
  const requiredAction = 'rules.write';
  const command = {
    expectedRevision: item.revision,
    versionId: version.id,
    reason: x.reason,
  };
  basis = [
    { label: '当前发布', value: '发布版本 ' + item.active.publishedVersion },
    {
      label: x.kind === 'rule-publish' ? '已保存草稿' : '目标历史内容',
      value:
        x.kind === 'rule-publish'
          ? '管理版本 ' + version.version
          : '发布版本 ' + version.publishedVersion,
    },
  ];
  impact = [
    ...(differences.length
      ? differences
      : ['内容与当前发布相同，将记录为新的发布版本。']),
    x.key === 'business-controls'
      ? '只影响之后对应的新操作；既有内容不会被追溯处置。'
      : '后续操作按新的额度和规则检查，已经发生的操作不撤销。',
    item.adoption?.mode === 'current-transaction'
      ? '后续对应操作会读取当前发布规则。'
      : '各运行组件更新后采用，实际采用状态可在规则页查看。',
    '变更说明：' + x.reason,
  ];
  if (
    impact.some((line) => line.length > 5000) ||
    impact.reduce((n, line) => n + line.length, 0) > 20000
  )
    fail('operations_agentos_rule_review_required');
  return { target, title, requiredAction, command, impact, basis };
}
