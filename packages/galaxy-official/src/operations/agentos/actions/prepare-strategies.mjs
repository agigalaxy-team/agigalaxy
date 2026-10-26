import { fail, label, cap, requiredActionFor } from './support.mjs';

export async function prepareOrdinaryStrategy({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const prepared = await this.service('ordinaryStrategies', 'prepare').prepare(
    actor,
    x.kind === 'ordinary-strategy-draft' ? 'draft' : 'publish',
    x,
  );
  expiry(prepared.readExpiresAt);
  const command = prepared.command;
  const target = {
    kind: 'strategy',
    id: x.strategyId,
    label: label(prepared.strategy.name, '日常策略'),
    href: '/admin/operations/strategies?strategy=' + x.strategyId,
  };
  const title =
    x.kind === 'ordinary-strategy-draft'
      ? '调整已批准边界内的日常策略'
      : '发布已保存的日常策略调整';
  const requiredAction = requiredActionFor(x);
  basis = [
    { label: '授权范围', value: '仅包含已批准的参数、启停及领导方式边界' },
  ];
  impact = [
    x.kind === 'ordinary-strategy-draft'
      ? '保存一份受限草稿，后续仍需通过当前消费者预演。'
      : '对新事项使用已预演的受限策略版本。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareStrategyControl({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('strategies', 'get').get(actor);
  cap(item.capabilities?.canControl);
  if (!item.active || item.paused === (x.action === 'pause'))
    fail('operations_agentos_operation_unavailable');
  expiry(item.readExpiresAt);
  const target = {
    kind: 'strategy-configuration',
    id: item.active.id,
    label: '当前已发布策略',
    href: '/admin/operations/strategy',
  };
  const title = x.action === 'pause' ? '暂停策略执行' : '恢复策略执行';
  const requiredAction = 'strategies.control';
  const command = {
    expectedRevision: item.revision,
    kind: x.action,
    reason: x.reason,
  };
  basis = [{ label: '当前执行', value: item.paused ? '已暂停' : '已启用' }];
  impact = [
    x.action === 'pause'
      ? '暂停整套已发布策略的后续步骤；已经完成的处理不撤销。'
      : '恢复整套已发布策略的后续步骤；已经完成的处理不会再次执行。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareStrategyContinuation({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('strategies', 'runDetail').runDetail(
    actor,
    x.runId,
  );
  expiry(item.readExpiresAt);
  if (
    item.run?.native?.status !== 'PAUSED' ||
    item.run.native.awaitingHuman !== true
  )
    fail('p13_run_not_paused');
  cap(item.run.canContinue);
  const target = {
    kind: 'strategy-run',
    id: x.runId,
    label: label(item.run.strategy?.name, '策略事项'),
    href: '/admin/operations/strategy?tab=runs&run=' + x.runId,
  };
  const title =
    x.decision === 'proceed' ? '同意推进这项处理' : '不执行这项处理';
  const requiredAction = 'strategies.run';
  const command =
    item.run.native.pauseKind === 'input'
      ? { inputDecision: x.decision }
      : { confirmed: x.decision === 'proceed' };
  basis = [
    {
      label: '当前步骤',
      value: label(item.run.native.currentStep, '等待本次人工决定'),
    },
  ];
  impact = [
    x.decision === 'proceed'
      ? '按原计划继续这项处理。若权限或内容状态已有变化，系统会停止相应动作。'
      : '结束本次处理，不执行待确认动作。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}
