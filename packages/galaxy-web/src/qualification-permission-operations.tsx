import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
export function QualificationPermissionOperations({
  client,
  pending,
  busy,
  run,
  onComplete,
}: any) {
  const [review, setReview] = useState<any>(null);
  return (
    <>
      {pending.map((p: any) => (
        <article className="message" key={p.operationId}>
          <h3>
            {p.state === 'stopped-local'
              ? '已停止本机重试，仍可核对结果'
              : '原操作待取得回执'}
          </h3>
          <p>
            请求、许可和计算各自保留原编号与原内容。未知结果不会由重新填写的内容替代。
          </p>
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await client.reconcile(p.operationId);
                  await onComplete?.(r);
                })
              }
            >
              查询原操作
            </Button>
            {p.state !== 'stopped-local' && (
              <>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      onComplete?.(
                        await client.retry(p.operationId, { confirmed: true }),
                      ),
                    )
                  }
                >
                  重试原操作
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await client.reviewAuthorization(p.operationId);
                      if (r.state === 'reauthorization-required') setReview(r);
                      else await onComplete?.(r);
                    })
                  }
                >
                  检查重连授权
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () =>
                      onComplete?.(
                        await client.stopLocalRetry(p.operationId, {
                          confirmed: true,
                        }),
                      ),
                    )
                  }
                >
                  停止本机重试
                </Button>
                <p>
                  停止本机重试不确认取消服务端在途请求。已登记的请求应另行取消，已授出的许可应另行撤销。
                </p>
              </>
            )}
          </div>
        </article>
      ))}
      {review && (
        <article className="message">
          <h3>确认同一业务内容的新授权</h3>
          <p>
            只有原业务和原授权均未被记录、且旧授权不能用于当前连接时，才会替换本机签名。
          </p>
          <p>
            受众：{review.viewers.join('、') || '仅本人'}；授权截止：
            {new Date(review.expiresAt * 1000).toLocaleString()}。
          </p>
          <details>
            <summary>查看将继续提交的原请求／许可内容</summary>
            <pre>{JSON.stringify(review.payload, null, 2)}</pre>
          </details>
          <div className="button-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await client.reauthorize(
                    review.operationId,
                    review,
                    { confirmed: true },
                  );
                  setReview(null);
                  await onComplete?.(r);
                })
              }
            >
              确认相同内容并继续
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setReview(null)}
            >
              暂不处理
            </Button>
          </div>
        </article>
      )}
    </>
  );
}
