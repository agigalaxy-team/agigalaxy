import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export function TaskOperationRecovery({
  runtime,
  connected,
  taskId = null,
  onComplete,
  onStopped,
}: {
  runtime: any;
  connected: boolean;
  taskId?: string | null;
  onComplete?: (receipt: any) => void | Promise<void>;
  onStopped?: (receipt: any) => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<any>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [stopPreview, setStopPreview] = useState<any>(null),
    [stopped, setStopped] = useState<any[]>([]);
  const epoch = useRef(0),
    working = useRef(false);
  useEffect(() => {
    const lease = ++epoch.current;
    setPreview(null);
    setStopPreview(null);
    setStopped([]);
    setMessage('');
    runtime?.stoppedTaskOperations(taskId).then((records: any[]) => {
      if (lease === epoch.current) setStopped(records);
    });
    return () => {
      epoch.current++;
    };
  }, [runtime, connected, taskId]);
  async function run(action: (valid: () => boolean) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    const lease = epoch.current;
    setBusy(true);
    setMessage('');
    try {
      await action(() => lease === epoch.current);
    } catch (error: any) {
      if (lease === epoch.current) setMessage(error.message);
    } finally {
      if (lease === epoch.current) {
        const records = await runtime.stoppedTaskOperations(taskId);
        if (lease === epoch.current) {
          setStopped(records);
          setBusy(false);
        }
      }
      working.current = false;
    }
  }
  return (
    <section className="operation-recovery">
      <Button
        variant="ghost"
        disabled={!runtime || !connected || busy}
        onClick={() =>
          run(async (valid) => {
            setPreview(null);
            const result = await runtime.reviewTaskAuthorization(taskId);
            if (!valid()) return;
            if (result.state === 'reauthorization-required') setPreview(result);
            else if (result.state === 'acknowledged') {
              setMessage('原操作已经完成。');
              await onComplete?.(result);
            } else
              setMessage(
                result.state === 'none'
                  ? '没有待恢复的操作。'
                  : '原授权仍可使用，请点击“重试原操作”或“重试原发布”。',
              );
          })
        }
      >
        重连后检查原操作授权
      </Button>
      <Button
        variant="ghost"
        disabled={!runtime || busy}
        onClick={() =>
          run(async (valid) => {
            setPreview(null);
            const result = await runtime.reviewTaskStop(taskId);
            if (!valid()) return;
            if (result.state === 'acknowledged') {
              setMessage('原操作已经被服务接受，不把它显示为已取消。');
              await onComplete?.(result);
            } else if (result.state === 'none')
              setMessage('没有当前待停止的操作。');
            else setStopPreview(result);
          })
        }
      >
        查看停止本机重试的范围
      </Button>
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
      {preview && (
        <div className="message">
          <h3>确认继续同一项操作</h3>
          <p>
            服务未收到原操作及其授权。旧授权不能用于当前连接，确认后会为下列相同内容签署新授权，并保留原操作编号。
          </p>
          <p>
            可见范围：{preview.visibility === 'Public' ? '公开' : '私有'}
            ；授权有效至 {new Date(preview.expiresAt * 1000).toLocaleString()}。
          </p>
          {preview.viewers?.length > 0 && (
            <p>允许查看的身份：{preview.viewers.join('、')}</p>
          )}
          <details>
            <summary>查看这次继续提交的原内容</summary>
            <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
          </details>
          <div className="button-row">
            <Button
              disabled={busy}
              onClick={() =>
                run(async (valid) => {
                  const receipt = await runtime.reauthorizeTaskOperation(
                    preview,
                    { taskId, confirmed: true },
                  );
                  if (!valid()) return;
                  setPreview(null);
                  setMessage('原操作已提交并取得回执。');
                  await onComplete?.(receipt);
                })
              }
            >
              确认相同内容并继续
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              暂不处理
            </Button>
          </div>
        </div>
      )}
      {stopPreview && (
        <div className="message">
          <h3>停止本机重试</h3>
          <p>
            操作：{stopPreview.kind}；原任务 {stopPreview.taskId}；原操作{' '}
            {stopPreview.eventId}。
          </p>
          <code>{stopPreview.payloadHash}</code>
          <p>
            {stopPreview.receipt.state === 'absent'
              ? '本次查询没有找到业务接受回执。'
              : stopPreview.receipt.state === 'conflict'
                ? '原 ID 与服务回执存在冲突。'
                : '网络或权限当前不足以确认服务端结果。'}{' '}
            这不证明在途请求以后不会完成。
          </p>
          <p>
            确认后只清除此浏览器的当前重试队列，先保留原
            ID、摘要哈希及查询记录。以后不会自动再发；实际撤回邀请、退出参与或取消任务仍需另走对应操作。
          </p>
          <div className="button-row">
            <Button
              disabled={busy}
              onClick={() =>
                run(async (valid) => {
                  const result = await runtime.stopTaskOperation(stopPreview, {
                    taskId,
                    confirmed: true,
                  });
                  if (!valid()) return;
                  setStopPreview(null);
                  if (result.state === 'acknowledged') {
                    setMessage('核对时发现原操作已接受。');
                    await onComplete?.(result);
                  } else if (result.state === 'stopped-local') {
                    setMessage(
                      '已停止本机重试；服务端取消未确认。可以按当前事实准备独立的新操作。',
                    );
                    await onStopped?.(result);
                  } else setMessage('当前没有待停止的原操作。');
                })
              }
            >
              确认停止本机重试
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setStopPreview(null)}
            >
              继续保留原队列
            </Button>
          </div>
        </div>
      )}
      {!!stopped.length && (
        <details>
          <summary>已停止本机重试的原操作（仅查询）</summary>
          {stopped.map((record) => (
            <article className="message" key={record.eventId}>
              <p>
                {record.kind} · {record.eventId}
              </p>
              <code>{record.payloadHash}</code>
              <p>
                {record.receipt.state === 'acknowledged'
                  ? '服务已经接受原操作；本记录不表示当前仍可读原文。'
                  : record.receipt.state === 'absent'
                    ? '最近一次没有找到接受回执，服务端取消仍未确认。'
                    : record.receipt.state === 'conflict'
                      ? '精确回执冲突，未自动替换原标识。'
                      : '当前结果未知。'}
              </p>
              <Button
                variant="outline"
                disabled={busy || !connected}
                onClick={() =>
                  run(async (valid) => {
                    const result = await runtime.queryStoppedTaskOperation(
                      record.eventId,
                      { taskId },
                    );
                    if (!valid()) return;
                    if (result.receipt.state === 'acknowledged') {
                      setMessage(
                        '已查询到原操作接受回执。请查看当前业务状态。',
                      );
                      await onComplete?.({ ...result, ...result.receipt });
                    } else setMessage('已更新原回执状态，没有重新发送。');
                  })
                }
              >
                只查询这个原操作
              </Button>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
