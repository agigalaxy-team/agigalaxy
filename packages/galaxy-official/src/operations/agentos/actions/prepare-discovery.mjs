import { workbenchCommandSchemas } from "../action-catalog.mjs";
import {
  fail,
  parse,
  label,
  recommendationDirectionNames,
  cap,
} from './support.mjs';

export async function prepareRecommendation({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('recommendations', 'overview').overview(
    actor,
    { days: 7 },
  );
  expiry(item.readExpiresAt);
  cap(item.capabilities?.canConfigure);
  const policy = item.policy,
    theme = item.catalog?.items?.find((item) => item.key === x.themeKey);
  if (!theme || !Array.isArray(policy?.directions))
    fail('operations_agentos_operation_unavailable');
  const command = parse(
    workbenchCommandSchemas[x.kind].omit({ operationId: true }),
    {
      expectedVersion: policy.version,
      enabled: policy.enabled,
      themeKey: x.themeKey,
      direction: x.direction,
      controls: policy.controls,
      reason: x.reason,
      beforeDirections: policy.directions,
      themeVersion: theme.version,
      themeEnabled: theme.enabled,
    },
  );
  const before =
    command.beforeDirections.find((item) => item.key === x.themeKey)
      ?.direction ?? 'keep';
  if (
    before === x.direction ||
    (!theme.enabled && policy.enabled && x.direction !== 'keep')
  )
    fail('operations_agentos_operation_unavailable');
  const target = {
    kind: 'recommendation-theme',
    id: x.themeKey,
    label: label(theme.label, '推荐主题'),
    href:
      '/admin/operations/recommendation?tab=strategy&id=' +
      encodeURIComponent(x.themeKey),
  };
  const title = '调整「' + target.label + '」的推荐方向';
  const requiredAction = 'recommendations.configure';
  basis = [
    { label: '当前方向', value: recommendationDirectionNames[before] },
    { label: '方向调控', value: policy.enabled ? '已启用' : '未启用' },
    { label: '主题状态', value: theme.enabled ? '已启用' : '已停用' },
  ];
  impact = [
    '展示机会：' +
      recommendationDirectionNames[before] +
      '改为' +
      recommendationDirectionNames[x.direction] +
      '。',
    !policy.enabled
      ? '方向调控当前关闭，本次仅保存方向，不改变当前推荐排序。'
      : !theme.enabled
        ? '此主题仍停用，本次不启用主题。'
        : '后续推荐按这一软性方向处理，个人需求、合格供给和负反馈仍参与排序。',
    '保留当前开关、重复与集中控制、其它主题方向及映射。',
    '需要撤销时，可按最新配置恢复原方向。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareSearch({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const service = this.service('searchQuality', 'overview'),
    item = await service.overview(actor, { days: 7, limit: 1 });
  expiry(item.readExpiresAt);
  const configuration = item.configuration;
  let version = configuration.draft;
  if (x.kind === 'search-restore') {
    const history = await service.history(actor, { limit: 50 });
    version = [configuration.active, ...(history.versions ?? [])].find(
      (value) => value?.id === x.versionId,
    );
    cap(version?.restorable);
  }
  cap(
    x.kind === 'search-apply'
      ? item.capabilities?.canPublish
      : item.capabilities?.canRestore,
  );
  if (!version) fail('search_quality_version_unavailable');
  const target = {
    kind: 'search-configuration',
    id: version.id,
    label: '搜索配置版本 ' + version.version,
    href: '/admin/operations/search-quality?tab=versions',
  };
  const title =
    x.kind === 'search-apply' ? '应用已保存的搜索草稿' : '恢复这份搜索配置';
  const requiredAction =
    x.kind === 'search-apply'
      ? 'search-quality.publish'
      : 'search-quality.restore';
  const command = {
    expectedRevision: configuration.revision,
    versionId: version.id,
    reason: x.reason,
  };
  basis = [
    {
      label: '可见范围',
      value: '已下架、到期、非公开或无权阅读的内容仍不进入搜索结果',
    },
  ];
  impact = [
    x.kind === 'search-apply'
      ? '将这份草稿的同义词和排序设置用于后续搜索。'
      : '将后续搜索恢复为所选历史版本的设置。',
    '设置完成后才会显示为已生效；结果暂未取得时，系统会继续查询。',
    '需要回退时，可在版本记录中恢复曾生效的配置。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}
