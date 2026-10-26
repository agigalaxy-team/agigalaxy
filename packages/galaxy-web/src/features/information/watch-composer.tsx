import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { X, Plus } from 'lucide-react';

import { actionNames, time, scopeTitle } from "./presentation";
import type { InformationSessionModel } from "./use-information-session";

export function InformationWatchComposer({model}:{model:InformationSessionModel}) {
  const { selected, setSelected, selectionLabels, watchPurpose, setWatchPurpose, expires, setExpires, report, setReport, reportTime, setReportTime, editing, watchOpen, preview, watches, busy, error, notice, composeReady, composeDialog, inputId, minimumExpiry, showTab, draftProblem, run, commitPrepared, prepareWatch, closeComposer, discardWatchDraft, editPreview, connected }=model;
  return (
      <dialog
        ref={composeDialog}
        className="workspace-dialog information-dialog"
        onCancel={(event) => {
          event.preventDefault();
          void closeComposer();
        }}
      >
        {(watchOpen || preview) && (
          <>
            <header className="dialog-heading">
              <h2>
                {preview
                  ? (actionNames[preview.command.action] ?? '确认选择')
                  : editing
                    ? '调整关注'
                    : '关注这些资料'}
              </h2>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="关闭关注编辑"
                onClick={() => void closeComposer()}
              >
                <X size={19} />
              </button>
            </header>
            {error && (
              <p role="alert" className="message error">
                {error}
              </p>
            )}
            {preview ? (
              <div className="information-watch-preview">
                {preview.command.plan ? (
                  <>
                    <h3>{preview.command.plan.purpose}</h3>
                    <ul>
                      {preview.command.plan.sources.map((scope) => (
                        <li key={scope.key}>
                          {selectionLabels[scope.key] ?? scopeTitle(scope)}
                        </li>
                      ))}
                    </ul>
                    <p>至 {time(preview.command.plan.expiresAt)}</p>
                    <p>
                      {preview.command.plan.report.mode === 'daily'
                        ? '每天在所选时刻汇总实际变化'
                        : '发现变化时提醒'}
                    </p>
                  </>
                ) : (
                  <>
                    <h3>
                      {watches.find(
                        (row) => row.watchId === preview.command.watchId,
                      )?.plan.purpose ?? '这份关注'}
                    </h3>
                    <p>
                      {preview.command.action === 'pause'
                        ? '暂停后不再检查这个范围，已有记录保留。'
                        : preview.command.action === 'end'
                          ? '结束这份关注并保留已有记录。'
                          : '按原来选定的范围和期限继续。'}
                    </p>
                  </>
                )}
                <p className="information-footnote">
                  网页打开且可见时执行。没有变化时不提醒。
                </p>
                <div className="button-row">
                  <Button
                    disabled={busy || !connected}
                    onClick={() =>
                      void run((valid) => commitPrepared(preview, valid))
                    }
                  >
                    {actionNames[preview.command.action] ?? '确认'}
                  </Button>
                  {preview.command.plan && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run(editPreview)}
                    >
                      修改选择
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void closeComposer()}
                  >
                    稍后继续
                  </Button>
                </div>
              </div>
            ) : (
              <form
                className="information-watch-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(prepareWatch);
                }}
              >
                <fieldset disabled={busy || !composeReady}>
                  {notice && (
                    <output className="information-notice">
                      {notice}
                    </output>
                  )}
                  {draftProblem('watch')}
                  <label htmlFor={inputId+'-watchPurpose'}>
                    关注名称
                    <Input id={inputId+'-watchPurpose'}
                      required
                      maxLength={300}
                      value={watchPurpose}
                      onChange={(event) => setWatchPurpose(event.target.value)}
                    />
                  </label>
                  <section className="information-selected">
                    <h3>关注范围</h3>
                    {selected.map((scope, index) => (
                      <div key={scope.key}>
                        <span>
                          {selectionLabels[scope.key] ?? scopeTitle(scope)}
                        </span>
                        <button
                          className="text-action"
                          type="button"
                          onClick={() =>
                            setSelected((old) =>
                              old.filter((_, i) => i !== index),
                            )
                          }
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-action"
                      onClick={() =>
                        void closeComposer(true).then(() => showTab('search'))
                      }
                    >
                      <Plus size={14} />
                      再选一些资料
                    </button>
                  </section>
                  <label htmlFor={inputId+'-expires'}>
                    关注到什么时候
                    <Input id={inputId+'-expires'}
                      type="datetime-local"
                      required
                      min={minimumExpiry}
                      step={1}
                      value={expires}
                      onChange={(event) => setExpires(event.target.value)}
                    />
                  </label>
                  <label>
                    提醒方式
                    <select
                      value={report}
                      onChange={(event) => setReport(event.target.value==='daily'?'daily':'changes')}
                    >
                      <option value="changes">有变化时提醒</option>
                      <option value="daily">每天汇总变化</option>
                    </select>
                  </label>
                  {report === 'daily' && (
                    <label htmlFor={inputId+'-reportTime'}>
                    每天的汇总时间
                      <Input id={inputId+'-reportTime'}
                        required
                        type="time"
                        value={reportTime}
                        onChange={(event) => setReportTime(event.target.value)}
                      />
                      <small>按当前时区设置；没有变化时不发送。</small>
                    </label>
                  )}
                  <p className="information-footnote">
                    此页面关闭后不会继续检查。关注仅保存到你的私有空间。
                  </p>
                  <div className="button-row">
                    <Button type="submit" disabled={!selected.length || busy}>
                      {editing ? '保存更改' : '开启关注'}
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => void closeComposer()}
                    >
                      稍后继续
                    </Button>
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => void run(discardWatchDraft)}
                    >
                      放弃这次编辑
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
          </>
        )}
      </dialog>

  );
}
