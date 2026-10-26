import { TaskCurrentSourceItem } from "../tasks/materials/task-material-view";
import { independentMaterialLabel } from "../tasks/materials/task-material-client.mjs";

import { Button } from '@/components/ui/button';

import { X } from 'lucide-react';

import { HistoryFacts } from "../../features/work-records/history";

import { itemLink, exactSelection, FactSummary } from "./presentation";
import type { InformationSessionModel } from "./use-information-session";

export function InformationDetailDialog({model}:{model:InformationSessionModel}) {
  const { detail, setDetail, busy, detailDialog, selectScope, runtime, navigate }=model;
  return (
      <dialog
        ref={detailDialog}
        className="workspace-dialog information-dialog"
        onCancel={() => setDetail(null)}
      >
        {detail && (
          <>
            <header className="dialog-heading">
              <h2>{detail.title}</h2>
              <button
                className="icon-button"
                aria-label="关闭资料"
                onClick={() => setDetail(null)}
              >
                <X size={19} />
              </button>
            </header>
            {detail.unavailable ? (
              <p>这份资料暂时不可读。</p>
            ) : (
              detail.page?.items.map((scope) => (
                <section key={scope.key}>
                  {!scope.items.length && <p>当前无法读取这份资料。</p>}
                  {scope.items.map((item) => (
                    <article key={item.id}>
                      <TaskCurrentSourceItem runtime={runtime} item={item}>{current=><FactSummary item={current} full/>}</TaskCurrentSourceItem>
                      {item.type === 'history' && (
                        <HistoryFacts
                          record={item.record}
                          navigate={navigate}
                        />
                      )}
                      {itemLink(item) && (
                        <Button
                          variant="outline"
                          onClick={() => navigate(itemLink(item)!)}
                        >
                          阅读全文

                        </Button>
                      )}
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() =>
                          selectScope(
                            exactSelection(scope, item),
                            independentMaterialLabel(item,detail.title),
                          )
                        }
                      >
                        关注这项资料
                      </button>
                    </article>
                  ))}
                </section>
              ))
            )}
          </>
        )}
      </dialog>

  );
}
