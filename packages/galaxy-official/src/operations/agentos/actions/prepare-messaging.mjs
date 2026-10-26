import { z } from 'zod';
import { transaction } from "../../../infrastructure/database.mjs";
import {
  parse,
  label,
  cap,
  requiredActionFor,
  humanDraftConfig,
} from './support.mjs';

export async function prepareMessageDraft({ actor, x, operationId, expiry }) {
  let command,
    impact = [],
    basis = [];
  const create = x.kind === 'message-draft-create',
    config = humanDraftConfig(x.config),
    messaging = this.service('messaging', 'validateConfig');
  // The creation ID belongs to the original server operation/card. It is
  // never accepted in model arguments or replaced during card revalidation.
  const id = create ? parse(z.uuid(), operationId) : x.targetId;
  await transaction(this.db, (db) => messaging.validateConfig(config, db));
  if (create) command = { planId: id, config };
  else {
    const response = await messaging.get(actor, id),
      item = response.plan;
    expiry(response.readExpiresAt);
    cap(
      item?.id === id && item.state === 'draft' && item.capabilities?.canSave,
    );
    command = {
      expectedVersion: item.version,
      expectedRevision: item.revision,
      config,
    };
  }
  expiry(Math.floor(Date.parse(config.content.expiresAt) / 1000));
  const target = {
    kind: 'message-plan',
    id,
    label: label(config.content.title, '待核实消息草稿'),
    href: '/admin/operations/messaging?id=' + id,
  };
  const title = create
    ? '生成待人工核实的消息草稿'
    : '保存待人工核实的消息草稿';
  const requiredAction = requiredActionFor(x);
  basis = [
    { label: '事实与受众', value: '待人工核实；本操作不批准发布' },
    {
      label: '渠道',
      value: config.channels
        .map(
          (channel) =>
            ({
              announcement: '公开公告',
              inapp: '站内信',
              email: '系统邮件',
            })[channel],
        )
        .join('、'),
    },
    {
      label: '受众草案',
      value:
        config.audience.kind === 'all-accounts'
          ? '全部符合条件的账户'
          : config.audience.kind === 'accounts'
            ? '明确列出的 ' + config.audience.accountIds.length + ' 个账户'
            : '主体类型：' +
              config.audience.subjectTypes
                .map(
                  (type) =>
                    ({
                      person: '个人',
                      agent: 'Agent',
                      organization: '组织',
                    })[type],
                )
                .join('、'),
    },
  ];
  impact = [
    '仅保存草稿，保存后仍需人工核实事实与受众；本操作不发布、不发送。',
    '标题：' + config.content.title,
    '正文：',
    config.content.body,
    '正文链接：' + (config.content.href ?? '无'),
    '截止时间：' + config.content.expiresAt,
    '时间草案：' +
      (config.schedule.kind === 'immediate'
        ? '发布批准后立即执行'
        : config.schedule.kind === 'once'
          ? config.schedule.at
          : config.schedule.cron + ' · ' + config.schedule.timezone),
  ];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareMessagingState({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const response = await this.service('messaging', 'get').get(
      actor,
      x.targetId,
    ),
    item = response.plan;
  expiry(response.readExpiresAt);
  cap(
    item.capabilities?.[
      {
        activate: 'canActivate',
        pause: 'canPause',
        resume: 'canResume',
        stop: 'canStop',
        withdraw: 'canWithdraw',
      }[x.action]
    ],
  );
  const target = {
    kind: 'message-plan',
    id: x.targetId,
    label: label(item.config?.content?.title, '消息计划'),
    href: '/admin/operations/messaging?id=' + x.targetId,
  };
  const title = {
    activate: '发布这份消息计划',
    pause: '暂停这份消息计划',
    resume: '恢复这份消息计划',
    stop: '停止这份消息计划',
    withdraw: '撤回这份消息计划',
  }[x.action];
  const requiredAction = ['activate', 'resume'].includes(x.action)
    ? 'notices.publish'
    : 'notices.withdraw';
  const command = {
    expectedVersion: item.version,
    expectedRevision: item.revision,
  };
  basis = [
    {
      label: '当前计划',
      value:
        {
          draft: '草稿',
          active: '运行中',
          paused: '已暂停',
          stopped: '已停止',
          expired: '已到期',
        }[item.effectiveState ?? item.state] ?? '未记录',
    },
    {
      label: '渠道',
      value:
        (item.config?.channels ?? [])
          .map(
            (channel) =>
              ({
                announcement: '公开公告',
                inapp: '站内信',
                email: '系统邮件',
              })[channel],
          )
          .filter(Boolean)
          .join('、') || '未记录',
    },
  ];
  const audience = item.config?.audience;
  basis.push({
    label: '受众',
    value:
      audience?.kind === 'all-accounts'
        ? '全部符合条件的账户'
        : audience?.kind === 'accounts'
          ? '已选 ' + audience.accountIds.length + ' 个账户'
          : audience?.kind === 'attributes'
            ? '主体类型：' +
              audience.subjectTypes
                .map(
                  (type) =>
                    ({
                      person: '个人',
                      agent: 'Agent',
                      organization: '组织',
                    })[type],
                )
                .join('、')
            : '未记录',
  });
  impact = ['activate', 'resume'].includes(x.action)
    ? [
        '按这份计划的内容、渠道和时间发布或发送；每次执行时确定并保留当次符合条件的受众。',
        '邮件提交后是否送达，以实际回执为准。',
      ]
    : x.action === 'withdraw'
      ? ['撤回已发布的公告和站内信，停止后续发送；已提交的邮件无法收回。']
      : [
          x.action === 'pause'
            ? '暂停后续发送，已发送的消息保持当前状态。'
            : '停止后续发送，已发送的消息保持当前状态。',
        ];
  return { target, title, requiredAction, command, impact, basis };
}
