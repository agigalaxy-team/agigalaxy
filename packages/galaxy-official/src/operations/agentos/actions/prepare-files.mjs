import { z } from 'zod';
import {
  fail,
  label,
  cap,
  count,
  restrictionTime,
  requiredActionFor,
} from './support.mjs';

export async function prepareFileScan({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('files', 'get').get(
    actor,
    x.targetKind,
    x.targetId,
  );
  cap(item.canRetryScan);
  expiry(item.readExpiresAt);
  const target = {
    kind: 'file',
    id: x.targetId,
    label: label(item.name, '文件'),
    href:
      '/admin/operations/files?fileKind=' + x.targetKind + '&id=' + x.targetId,
  };
  const title = '重新安排文件扫描';
  const requiredAction = 'files.scan.retry';
  const command = {
    kind: 'scan',
    expectedVersion: item.processingVersion ?? item.version,
    reason: x.reason,
  };
  basis = [{ label: '处理资格', value: '当前可重新安排扫描' }];
  impact = ['重新安排安全扫描，不删除文件。扫描结果会在检查完成后更新。'];
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareFileAccess({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const item = await this.service('fileAccess', 'get').get(
      actor,
      x.targetKind,
      x.targetId,
    ),
    access = item.access;
  if (
    item.id !== x.targetId ||
    item.kind !== x.targetKind ||
    typeof item.processingVersion !== 'string' ||
    !item.processingVersion.length ||
    item.processingVersion.length > 8192 ||
    count(access?.revision) === null ||
    typeof access.stopped !== 'boolean'
  )
    fail('operations_agentos_operation_unavailable');
  cap(x.action === 'stop' ? access.canStop : access.canRestore);
  expiry(item.readExpiresAt);
  if (x.action === 'stop' && x.until <= this.now())
    fail('operations_file_access_until', 400);
  if (
    x.action === 'stop'
      ? access.stopped
      : !access.stopped ||
        !Number.isSafeInteger(access.until) ||
        access.until <= this.now()
  )
    fail('operations_file_access_changed');
  const target = {
    kind: 'file',
    id: x.targetId,
    label: label(item.name, x.targetKind === 'chat' ? '私聊附件' : '社区附件'),
    href:
      '/admin/operations/files?fileKind=' + x.targetKind + '&id=' + x.targetId,
  };
  const title = x.action === 'stop' ? '停止此文件访问' : '恢复此文件访问';
  const requiredAction = requiredActionFor(x);
  const command = {
    expectedVersion: item.processingVersion,
    expectedRevision: access.revision,
    action: x.action,
    reason: x.reason,
    ...(x.action === 'stop' ? { until: x.until } : {}),
  };
  basis = [
    {
      label: '文件来源',
      value: x.targetKind === 'chat' ? '私聊附件' : '社区附件',
    },
    {
      label: '运营访问状态',
      value: access.stopped
        ? '停止至北京时间 ' + restrictionTime(access.until * 1000)
        : '当前没有生效的运营访问覆盖',
    },
  ];
  impact = [
    x.action === 'stop'
      ? '停止此文件的获准取件，截止北京时间 ' +
        restrictionTime(x.until * 1000) +
        '。'
      : '解除当前这一版运营访问覆盖。',
    '此操作不删除文件，也不更改原存储期限、作者撤回或清理计划。',
    x.action === 'stop'
      ? '停止期间，下载与获准导出仍受同一文件访问控制。'
      : '恢复后仍按原扫描结果、来源状态与阅读权限判断是否可取件。',
    '处理原因：' + x.reason,
  ];
  expiry(x.action === 'stop' ? x.until : access.until);
  return { target, title, requiredAction, command, impact, basis };
}

export async function prepareFileCleanup({ actor, x, expiry }) {
  let impact = [],
    basis = [];
  const plan = await this.service('fileCleanup', 'plan').plan(actor, x.planId);
  expiry(plan.readExpiresAt);
  cap(plan.state === 'awaiting-approval' && plan.permissions?.canApprove);
  await this.human(actor, 'files.cleanup.approve');
  const review = () => fail('operations_agentos_cleanup_review_required');
  if (
    plan.id !== x.planId ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    !Array.isArray(plan.items) ||
    plan.items.length < 1 ||
    plan.items.length > 50 ||
    plan.itemCount !== plan.items.length ||
    count(plan.declaredBytes) === null
  )
    review();
  const keys = new Set();
  let bytes = 0;
  impact = [
    '清除以下 ' + plan.itemCount + ' 份文件在服务器上的副本，无法从此处恢复。',
  ];
  for (const [index, item] of plan.items.entries()) {
    const key = item.kind + ':' + item.id;
    if (
      !['chat', 'forum'].includes(item.kind) ||
      !z.uuid().safeParse(item.id).success ||
      keys.has(key) ||
      count(item.size) === null ||
      !['expired', 'unreferenced'].includes(item.reason) ||
      item.state !== 'pending'
    )
      review();
    keys.add(key);
    bytes += item.size;
    if (!Number.isSafeInteger(bytes)) review();
    const source = item.kind === 'chat' ? '私聊附件' : '社区附件',
      name = label(item.name, '未命名' + source),
      references = count(item.referenceCount),
      active = count(item.activeReferences),
      expiresAt =
        typeof item.expiresAt === 'string' &&
        Number.isFinite(Date.parse(item.expiresAt))
          ? new Date(item.expiresAt).toISOString()
          : null;
    impact.push(
      index +
        1 +
        '. ' +
        name +
        ' · ' +
        source +
        ' · 声明大小 ' +
        item.size.toLocaleString('zh-CN') +
        ' 字节 · ' +
        (item.reason === 'expired' ? '既有期限已到' : '已无有效来源引用') +
        ' · 制定时有效引用 ' +
        (active === null ? '未确认' : active) +
        ' / 总引用 ' +
        (references === null ? '未确认' : references) +
        ' · 既有到期时间 ' +
        (expiresAt ?? '未记录'),
    );
  }
  if (bytes !== plan.declaredBytes) review();
  impact.push(
    '只处理这份已列明的计划，不包含之后新增的文件。清理前会再次核对引用、留存和对象状态，有变化的文件不会继续清理。',
    '批准只安排逐项处理；对象是否已移除以实际结果为准，磁盘释放空间目前无法确认。',
  );
  if (
    impact.length > 54 ||
    impact.some((line) => line.length > 5000) ||
    impact.reduce((n, line) => n + line.length, 0) > 20000
  )
    review();
  const target = {
    kind: 'file-cleanup-plan',
    id: x.planId,
    label: '具体文件清理计划（' + plan.itemCount + ' 份文件）',
    href: '/admin/operations/files?kind=all&view=cleanup&plan=' + x.planId,
  };
  const title = '批准清理这 ' + plan.itemCount + ' 份文件';
  const requiredAction = 'files.cleanup.approve';
  const command = { expectedRevision: plan.revision };
  basis = [
    {
      label: '计划制定时间',
      value:
        typeof plan.createdAt === 'string' &&
        Number.isFinite(Date.parse(plan.createdAt))
          ? new Date(plan.createdAt).toISOString()
          : '未记录',
    },
    {
      label: '固定范围',
      value:
        plan.itemCount +
        ' 份文件；声明大小合计 ' +
        plan.declaredBytes.toLocaleString('zh-CN') +
        ' 字节',
    },
    { label: '当前计划', value: '等待本次人工批准' },
  ];
  return { target, title, requiredAction, command, impact, basis };
}
