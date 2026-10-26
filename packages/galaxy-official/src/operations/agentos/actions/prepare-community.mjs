import { checkConversationPublicReference } from "../public-reference.mjs";
import {
  fail,
  label,
  categoryNames,
  cap,
  pick,
  requiredActionFor,
} from './support.mjs';

export async function prepareContentBatch({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const content = this.service('content', 'preview'),
    items = [];
  for (const selected of x.items) {
    const item = (await content.get(actor, selected.kind, selected.id)).content;
    cap(
      x.action === 'hide'
        ? item.capabilities?.canBatchHide
        : item.capabilities?.canBatchRestore,
    );
    items.push({
      ...selected,
      expectedVersion: item.version,
      expectedRevision: item.visibility.version,
    });
    expiry(item.publishedUntil);
  }
  const preview = await content.preview(actor, {
    kind: x.action,
    items,
    ...(x.until === undefined ? {} : { until: x.until }),
  });
  if (
    preview.items.some((item) => !item.eligible) ||
    items.length > preview.maximumItems
  )
    fail('operations_agentos_human_review_required', 409);
  const target = {
    kind: 'content-batch',
    id: items[0].id,
    label: '明确选定的 ' + items.length + ' 项公开内容',
    href: '/admin/operations/community?tab=posts',
  };
  const title =
    '批量' + (x.action === 'hide' ? '下架' : '恢复') + '明确选定的公开内容';
  const requiredAction = requiredActionFor(x);
  const command = {
    kind: x.action,
    items,
    ...(x.until === undefined ? {} : { until: x.until }),
    reason: x.reason,
  };
  basis = [
    { label: '明确影响范围', value: items.length + ' 项已选当前公开来源' },
  ];
  impact = ['逐项核对原版本和运营覆盖版本，未满足条件的对象保留拒绝原因。'];
  return { target, title, requiredAction, command, impact, basis };
}

export async function preparePrivateMessage({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const detail = await this.service('chatReports', 'operatorGet').operatorGet(
      actor,
      { reportId: x.reportId },
    ),
    material = detail.materials.find(
      (item) => item.messageId === x.messageId && item.state === 'available',
    );
  if (!material) fail('chat_report_message_not_selected', 404);
  cap(
    material.moderation?.[
      { hide: 'canHide', restore: 'canRestore', keep: 'canKeep' }[x.action]
    ],
  );
  expiry(detail.readExpiresAt);
  const target = {
    kind: 'chat-report',
    id: x.reportId,
    label: '具体私聊案件已选消息',
    href: '/admin/operations/chat-reports?report=' + x.reportId,
  };
  const title = '处理本案已选消息';
  const requiredAction = requiredActionFor(x);
  const command = {
    expectedVersion: detail.version,
    expectedRevision: material.moderation.revision,
    messageRevision: material.revision,
    action: x.action,
    summary: x.summary,
  };
  basis = [
    { label: '资料范围', value: '仅本案明确提供且当前仍可读取的消息版本' },
  ];
  impact = [
    '记录本案单条消息的' +
      { hide: '屏蔽', restore: '恢复', keep: '维持屏蔽' }[x.action] +
      '；其他案件覆盖和个人隐藏保持各自有效条件。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareContent({
  actor,
  x,
  publicReference,
  expiry,
  deadline,
}) {
  let title,
    requiredAction,
    command,
    impact = [],
    basis = [];
  const response = await this.service('content', 'get').get(
      actor,
      x.targetKind,
      x.targetId,
    ),
    item = response.content;
  if (item.sourceState !== 'available') fail('operations_source_unavailable');
  checkConversationPublicReference(
    publicReference,
    x.targetKind,
    x.targetId,
    item,
  );
  expiry(item.publishedUntil);
  const target = {
    kind: x.targetKind,
    id: x.targetId,
    label: label(item.title, x.targetKind === 'post' ? '公开帖子' : '公开回复'),
    href:
      '/admin/operations/community?tab=posts&contentKind=' +
      x.targetKind +
      '&id=' +
      x.targetId,
  };
  basis = [
    {
      label: '来源',
      value: '当前可公开读取的' + (x.targetKind === 'post' ? '帖子' : '回复'),
    },
    {
      label: '当前展示',
      value: item.visibility.hidden ? '已隐藏' : '正常展示',
    },
  ];
  if (x.kind === 'content-visibility') {
    cap(
      x.action === 'hide'
        ? item.capabilities?.canHide
        : item.capabilities?.canRestore,
    );
    requiredAction = 'content.' + x.action;
    title = x.action === 'hide' ? '下架这条公开内容' : '恢复这条公开内容';
    impact =
      x.action === 'hide'
        ? [
            '停止该内容的公开展示，截止 ' +
              deadline(
                x.until,
                item.maxHideSeconds,
                item.publishedUntil ?? null,
              ),
          ]
        : [
            '解除这次运营下架。作者已撤回、已到期或没有阅读权限的内容仍不展示。',
          ];
    command = {
      kind: x.action,
      expectedVersion: item.version,
      expectedRevision: item.visibility.version,
      ...(x.until === undefined ? {} : { until: x.until }),
      reason: x.reason,
    };
  } else {
    cap(item.capabilities?.canCurate);
    requiredAction = 'content.curate';
    title = '调整这条内容的分类与编排';
    command = {
      expectedVersion: item.version,
      expectedRevision: item.curation.revision,
      ...pick(x, ['topic', 'pinned', 'featured', 'tagIds', 'reason']),
    };
    impact = [
      ...(Object.hasOwn(x, 'topic')
        ? [
            '分类：' +
              (x.topic === null ? '恢复来源分类' : categoryNames[x.topic]),
          ]
        : []),
      ...(x.pinned === undefined ? [] : ['置顶：' + (x.pinned ? '是' : '否')]),
      ...(x.featured === undefined
        ? []
        : ['精选：' + (x.featured ? '是' : '否')]),
    ];
    if (x.tagIds) {
      const response = await this.service('content', 'tags').tags(actor),
        tags = response.items ?? response.tags ?? response;
      if (
        !Array.isArray(tags) ||
        x.tagIds.some((id) => !tags.some((tag) => tag.id === id && tag.enabled))
      )
        fail('operations_tag_unavailable');
      impact.push(
        '标签：' +
          (x.tagIds.length
            ? x.tagIds
                .map((id) =>
                  label(tags.find((tag) => tag.id === id)?.name, '标签'),
                )
                .join('、')
            : '清除运营标签'),
      );
    }
  }
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareSection({
  actor,
  x,
  expiry,
  deadline,
  visibilityCommand,
}) {
  let title,
    requiredAction,
    command,
    impact = [],
    basis = [];
  const item = await this.service('community', 'section').section(
    actor,
    x.targetId,
  );
  expiry(item.readExpiresAt);
  if (item.sourceState !== 'available') fail('operations_source_unavailable');
  const target = {
    kind: 'section',
    id: x.targetId,
    label: label(item.title, '版块'),
    href: '/admin/operations/community?tab=sections&id=' + x.targetId,
  };
  basis = [
    { label: '当前分类', value: categoryNames[item.category] ?? '未记录' },
    {
      label: '当前展示',
      value: item.visibility.hidden ? '已隐藏' : '正常展示',
    },
  ];
  if (x.kind === 'section-classification') {
    cap(item.canManage);
    title = '调整版块分类';
    requiredAction = 'sections.classify';
    impact = ['分类改为' + categoryNames[x.category]];
    command = {
      expectedVersion: item.version,
      category: x.category,
      reason: x.reason,
    };
  } else {
    cap(x.action === 'hide' ? item.canHide : item.canRestore);
    title = x.action === 'hide' ? '下架这个版块' : '恢复这个版块';
    requiredAction = 'sections.' + x.action;
    command = visibilityCommand(item, item.version, x.action);
    impact =
      x.action === 'hide'
        ? ['停止版块展示，截止 ' + deadline(x.until, item.maxHideSeconds)]
        : ['解除这次运营下架，版块仍只向原本有权阅读的人展示。'];
  }
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareResource({
  actor,
  x,
  expiry,
  deadline,
  visibilityCommand,
}) {
  let impact = [],
    basis = [];
  const item = await this.service('resources', 'get').get(
    actor,
    x.targetKind,
    x.targetId,
  );
  expiry(item.readExpiresAt);
  cap(x.action === 'hide' ? item.canHide : item.canRestore);
  const target = {
    kind: x.targetKind,
    id: x.targetId,
    label: label(item.title, x.targetKind === 'projects' ? '项目' : '方法'),
    href:
      '/admin/operations/resources?kind=' + x.targetKind + '&id=' + x.targetId,
  };
  const title =
    (x.action === 'hide' ? '下架这个' : '恢复这个') +
    (x.targetKind === 'projects' ? '项目' : '方法');
  const requiredAction = 'resources.' + x.action;
  const command = visibilityCommand(item, item.version, x.action);
  basis = [
    {
      label: '来源状态',
      value: item.sourceState === 'available' ? '当前可读取' : '当前不可读取',
    },
    {
      label: '当前展示',
      value: item.visibility.hidden ? '已隐藏' : '正常展示',
    },
  ];
  impact =
    x.action === 'hide'
      ? ['停止展示，截止 ' + deadline(x.until, item.maxHideSeconds)]
      : ['解除这次运营下架。已归档、撤回或到期的材料仍不展示。'];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareCase({ actor, x, expiry, deadline }) {
  let impact = [],
    basis = [];
  const item = await this.service('community', 'report').report(
    actor,
    x.targetId,
  );
  cap(item.canModerate);
  expiry(item.readExpiresAt);
  const action =
    x.restrictionAction ?? (x.hideUntil === undefined ? 'keep' : 'hide');
  cap(
    action === 'hide'
      ? item.currentEffect?.canHide
      : action === 'release'
        ? item.currentEffect?.canRelease
        : item.currentEffect?.canKeep,
  );
  const target = {
    kind: 'public-case',
    id: x.targetId,
    label: label(item.title, '公开内容举报与申诉'),
    href: '/admin/operations/community?tab=reports&id=' + x.targetId,
  };
  const title = '复核这项公开举报与申诉';
  const requiredAction = 'cases.resolve';
  const command = {
    expectedVersion: item.version,
    ...pick(x, ['resolution', 'summary', 'restrictionAction', 'hideUntil']),
  };
  basis = [
    { label: '处理资格', value: '当前独立处理者可复核' },
    {
      label: '本案限制',
      value: item.currentEffect?.active ? '当前生效' : '当前无生效限制',
    },
  ];
  impact = [
    '结论：' +
      {
        accepted: '举报成立',
        dismissed: '不采纳举报',
        'needs-review': '需要进一步复核',
      }[x.resolution],
    action === 'keep'
      ? '维持本案现有展示限制。'
      : action === 'release'
        ? '解除本案的隐藏限制。其他案件的限制，以及原内容的可见条件仍保持。'
        : '设置本案隐藏，截止 ' +
          deadline(
            x.hideUntil,
            item.maxHideSeconds,
            item.source?.publishedUntil ?? null,
          ),
    '处理说明：' + x.summary,
  ];
  return { target, title, requiredAction, command, impact, basis };
}
