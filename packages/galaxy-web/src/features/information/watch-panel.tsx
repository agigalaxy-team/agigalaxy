import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";

import { Button } from '@/components/ui/button';

import { PageLoading } from "../../site-shell";

import { informationOperationActive } from "./state";

import { stateNames, time } from "./presentation";
import type { InformationSessionModel } from "./use-information-session";
import { ResultScope, WatchCard } from "./results";

export function InformationWatchPanel({model}:{model:InformationSessionModel}) {
  const { client, watches, watchAfter, events, setEvents, busy, loaded, setNotice, showTab, chooseIdentity, refresh, run, prepareAction, connected }=model;
  const activePending=model.pending.filter(informationOperationActive);
  return (
        <>
          {!connected ? (
            <div className="information-empty">
              <p>使用自己的身份，保存想关注的资料。</p>
              <Button onClick={chooseIdentity}>继续使用</Button>
            </div>
          ) : !loaded ? (
            <PageLoading label="正在读取关注…" />
          ) : (
            <>
              {events ? (
                <article className="information-watch-detail">
                  <button
                    className="text-action"
                    onClick={() => setEvents(null)}
                  >
                     返回我的关注
                  </button>
                  <header>
                    <h2>{events.watch.plan.purpose}</h2>
                    <span>
                      {stateNames[events.watch.state] ?? '当前状态未提供'}
                    </span>
                  </header>
                  {events.current.items.map((scope) =>
                    <ResultScope key={scope.key} scope={scope} withFollow={false} model={model} />,
                  )}
                  <ReadingDetails className="information-source-details">
                    <ReadingSummary>变化记录</ReadingSummary>
                    {!events.events.length ? (
                      <p>还没有新的变化。</p>
                    ) : (
                      events.events.map((event) => (
                        <article key={event.id}>
                          <time>{time(event.at)}</time>
                          <p>
                            {event.changes
                              .map((change) =>
                                change.kind === 'no-longer-in-current-scope'
                                  ? '有资料不再出现在当前范围'
                                  : change.kind ===
                                      'current-source-recheck-required'
                                    ? '有资料需要按当前权限重新读取'
                                    : '资料内容或可见版本有变化',
                              )
                              .join('；')}
                          </p>
                        </article>
                      ))
                    )}
                  </ReadingDetails>
                </article>
              ) : (
                <>
                  <p className="information-footnote">
                    网页打开且可见时会检查变化；关闭网页后，这个页面不会继续运行。
                  </p>
                  {!watches.length && (
                    <div className="information-empty">
                      <h2>还没有关注</h2>
                      <p>找到有用的资料后，可以选择关注。</p>
                      <Button
                        variant="outline"
                        onClick={() => showTab('search')}
                      >
                        去查找资料
                      </Button>
                    </div>
                  )}
                  {watches
                    .filter((row) => !['ended', 'expired'].includes(row.state))
                    .map(row => <WatchCard key={row.watchId} row={row} model={model} />)}
                  {watches.some((row) =>
                    ['ended', 'expired'].includes(row.state),
                  ) && (
                    <ReadingDetails className="information-previous-watches">
                      <ReadingSummary>以前的关注</ReadingSummary>
                      {watches
                        .filter((row) =>
                          ['ended', 'expired'].includes(row.state),
                        )
                        .map(row => <WatchCard key={row.watchId} row={row} model={model} />)}
                    </ReadingDetails>
                  )}
                  {watchAfter && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run((valid) => refresh(valid, watchAfter))
                      }
                    >
                      更早的关注
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {!!activePending.length && (
            <section className="information-pending">
              {activePending.map((operation) => (
                <article key={operation.command.operationId}>
                  <p>
                    {operation.state === 'prepared'
                      ? '还有一份未确认的选择'
                      : '正在确认是否保存成功'}
                    {operation.command.plan?.purpose
                      ? '：' + operation.command.plan.purpose
                      : ''}
                  </p>
                  <button
                    className="text-action"
                    disabled={busy}
                    onClick={() =>
                      void run((valid) =>
                        prepareAction(operation.command, valid),
                      )
                    }
                  >
                    查看这次选择
                  </button>
                  {operation.state === 'prepared' && (
                    <button
                      className="text-action"
                      disabled={busy}
                      onClick={() =>
                        void run(async (valid) => {
                          const result = await client!.stopLocal(
                            operation.command.operationId,
                            { onlyPrepared: true },
                          );
                          if (valid())
                            setNotice(
                              result.state === 'stopped-local'
                                ? '这次选择已取消。'
                                : result.state === 'acknowledged'
                                  ? '这次选择已经保存。'
                                  : '这次选择已提交，正在确认保存结果。',
                            );
                          await refresh(valid);
                        })
                      }
                    >
                      取消这次选择
                    </button>
                  )}
                </article>
              ))}
            </section>
          )}
        </>

  );
}
