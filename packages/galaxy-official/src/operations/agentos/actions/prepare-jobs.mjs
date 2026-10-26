import { cap, requiredActionFor } from './support.mjs';

export async function prepareJobs({ actor, x }) {
  let command,
    impact = [],
    basis = [];
  const job = await this.service('jobActions', 'read').read(actor, x.kind, x);
  if (x.kind === 'search-retry') {
    cap(job.state === 'failed');
    command = { expectedGeneration: job.generation, reason: x.reason };
  } else {
    cap(
      x.kind === 'job-retry'
        ? job.state === 'failed'
        : ['created', 'retry', 'active', 'cancelled'].includes(job.state),
    );
    command = {
      expectedState: job.state,
      expectedRetryCount: job.retryCount,
      reason: x.reason,
    };
  }
  const target = {
    kind: x.kind === 'search-retry' ? 'search-job' : 'queue-job',
    id: x.targetId,
    label:
      x.kind === 'search-retry'
        ? '失败索引任务的第 ' + job.generation + ' 代'
        : x.queue + ' 队列中的具体任务',
    href: '/admin/operations/jobs',
  };
  const title =
    x.kind === 'job-cancel' ? '取消这项运行任务' : '重新安排这项失败任务';
  const requiredAction = requiredActionFor(x);
  basis = [
    { label: '任务 ID', value: x.targetId },
    {
      label: x.kind === 'search-retry' ? '索引代数' : '队列',
      value: x.kind === 'search-retry' ? String(job.generation) : x.queue,
    },
    { label: '当前状态', value: job.state },
  ];
  impact = [
    x.kind === 'job-cancel'
      ? '停止这项队列工作；已完成的外部效果不会撤回。'
      : '仅重新安排所选失败任务，不表示索引或业务已经执行成功。',
    '执行前重新检查任务状态及所属业务权限。',
  ];
  return { target, title, requiredAction, command, impact, basis };
}
