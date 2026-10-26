import { ReadingDetails, ReadingSummary } from "../../shared/reading/reading-details";
import { TaskCurrentSourceItem, TaskDerivedTitle } from "../tasks/materials/task-material-view";
import { independentMaterialLabel } from "../tasks/materials/task-material-client.mjs";

import { Button } from '@/components/ui/button';

import { Bell } from 'lucide-react';

import type { InformationScope, InformationWatch } from "./state";
import { stateNames, time, scopeTitle, exactSelection, FactSummary } from "./presentation";
import type { InformationSessionModel } from "./use-information-session";
export function WatchCard({row,model}:{row:InformationWatch;model:InformationSessionModel}) {
    const { busy, run, saveWatchAction, editWatch, showEvents }=model;
    return (
      <article className="information-watch" key={row.watchId}>
        <header>
          <button onClick={() => void run((valid) => showEvents(row, valid))}>
            {row.plan.purpose}
          </button>
          <span>{stateNames[row.state] ?? '当前状态未提供'}</span>
        </header>
        <p>{row.plan.sources.map(scopeTitle).join(' · ')}</p>
        <small>至 {time(row.plan.expiresAt)}</small>
        <footer>
          <button
            className="text-action"
            disabled={busy}
            onClick={() => void run((valid) => showEvents(row, valid))}
          >
            查看资料与变化

          </button>
          {['active', 'paused'].includes(row.state) && (
            <button
              className="text-action"
              disabled={busy}
              onClick={() =>
                void run((valid) =>
                  saveWatchAction(
                    {
                      operationId: crypto.randomUUID(),
                      watchId: row.watchId,
                      expectedRevision: row.revision,
                      action: row.state === 'active' ? 'pause' : 'resume',
                    },
                    valid,
                  ),
                )
              }
            >
              {row.state === 'active' ? '暂停' : '恢复'}
            </button>
          )}
          <ReadingDetails className="information-watch-options">
            <ReadingSummary>设置</ReadingSummary>
            {row.state !== 'ended' && (
              <>
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() => void run((valid) => editWatch(row, valid))}
                >
                  调整范围与期限
                </button>
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() =>
                    void run((valid) =>
                      saveWatchAction(
                        {
                          operationId: crypto.randomUUID(),
                          watchId: row.watchId,
                          expectedRevision: row.revision,
                          action: 'end',
                        },
                        valid,
                      ),
                    )
                  }
                >
                  结束关注
                </button>
              </>
            )}
            <p>上次检查：{time(row.lastCheckedAt)}</p>
            {row.sourceCoverage?.some(
              (source) =>
                source.state === 'temporarily-unavailable' || !source.complete,
            ) && <p>部分来源暂时不可用或尚未读完。</p>}
          </ReadingDetails>
        </footer>
      </article>
    );
  }
export function ResultScope({scope,withFollow=true,model}:{scope:InformationScope;withFollow?:boolean;model:InformationSessionModel}) {
    const { query, page, busy, run, openItem, selectScope, loadMore, runtime }=model;
    return (
      <section className="information-result-group" key={scope.key}>
        <header>
          <h2>{scopeTitle(scope)}</h2>
          {withFollow && (
            <button
              className="text-action"
              disabled={busy}
              onClick={() =>
                selectScope(
                  { key: scope.key, source: scope.source },
                  (page?.purpose ?? query.trim()) + ' · ' + scopeTitle(scope),
                )
              }
            >
              <Bell size={15} />
              关注此范围
            </button>
          )}
        </header>
        {!scope.items?.length && (
          <p className="information-empty">
            {scope.state === 'temporarily-unavailable'
              ? '暂时无法读取，其他资料仍可查看。'
              : '当前没有可读的相关资料。'}
          </p>
        )}
        {(scope.items ?? []).map((item) => (
          <article className="information-result" key={item.id}>
            <h3>
              <button
                disabled={busy}
                onClick={() =>
                  void run((valid) => openItem(scope, item, valid))
                }
              >
                <TaskDerivedTitle runtime={runtime} source={item} fallback="查看资料"/>
              </button>
            </h3>
            <TaskCurrentSourceItem runtime={runtime} item={item}>{current=><FactSummary item={current}/>}</TaskCurrentSourceItem>
            <footer>
              <button
                className="text-action"
                disabled={busy}
                onClick={() =>
                  void run((valid) => openItem(scope, item, valid))
                }
              >
                查看内容

              </button>
              {withFollow && (
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() =>
                    selectScope(
                      exactSelection(scope, item),
                      independentMaterialLabel(item,scopeTitle(scope)),
                    )
                  }
                >
                  关注这项资料
                </button>
              )}
            </footer>
          </article>
        ))}
        {scope.nextCursor && withFollow && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run((valid) => loadMore(scope, valid))}
          >
            更多{scopeTitle(scope)}
          </Button>
        )}
      </section>
    );
  }
