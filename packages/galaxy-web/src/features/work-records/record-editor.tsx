import React from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {X} from 'lucide-react';
import {ReadingDetails,ReadingSummary} from "../../shared/reading/reading-details";
import {ConfigurationPicker} from "../tools/configuration-picker";
import type {WorkTask,WorkRuntime} from "../tasks/work-task-types";
import type {CapsuleSourceItem} from "../capsules/capsule-authoring-types";
import type {WorkFactAction,WorkFactPending,WorkComposeValue,WorkForm,WorkTextField,WorkAttempt,WorkEditorTarget,WorkRecordView,WorkResult,WorkIntervention} from './contracts';
import {actionTitles,downloadRecord,refsKey,names,outcomes,methods} from './record-labels';

type WorkRecordEditorProps={
  editor:React.RefObject<HTMLDialogElement|null>;
  action:WorkFactAction|null;
  busy:boolean;
  pending:WorkFactPending|null;
  error:string;
  composeError:string;
  closeEditor:()=>void;
  run:(fn:(check:()=>void)=>Promise<void>)=>Promise<void>;
  save:()=>Promise<void>;
  composeValue:()=>WorkComposeValue;
  reloadSavedCompose:()=>Promise<void>;
  task:WorkTask;
  form:WorkForm;
  setForm:React.Dispatch<React.SetStateAction<WorkForm>>;
  runtime:WorkRuntime;
  subjectId:string;
  configurationConditions:CapsuleSourceItem[];
  setConfigurationConditions:React.Dispatch<React.SetStateAction<CapsuleSourceItem[]>>;
  configurationSources:CapsuleSourceItem[];
  setConfigurationSources:React.Dispatch<React.SetStateAction<CapsuleSourceItem[]>>;
  attempts:WorkAttempt[];
  related:string[];
  setRelated:React.Dispatch<React.SetStateAction<string[]>>;
  person:(id:string|null|undefined)=>string;
  evidence:WorkRecordView[];
  recordSelected:string[];
  setRecordSelected:React.Dispatch<React.SetStateAction<string[]>>;
  ownOrigins:WorkEditorTarget[];
  eligibleResults:WorkResult[];
  interventions:WorkIntervention[];
  verificationTargets:[string,WorkEditorTarget[]][];
  requester:boolean;
  results:WorkResult[];
  verifications:WorkRecordView[];
  inputId:string;
  viewers:string[];
  setViewers:React.Dispatch<React.SetStateAction<string[]>>;
};

// Controlled form: the workspace keeps the draft, lease and operation generation.
export function WorkRecordEditor({editor,action,busy,pending,error,composeError,closeEditor,run,save,composeValue,reloadSavedCompose,task,form,setForm,runtime,subjectId,configurationConditions,setConfigurationConditions,configurationSources,setConfigurationSources,attempts,related,setRelated,person,evidence,recordSelected,setRecordSelected,ownOrigins,eligibleResults,interventions,verificationTargets,requester,results,verifications,inputId,viewers,setViewers}:WorkRecordEditorProps){
  const field = (
    title: string,
    key: WorkTextField,
    required = true,
    maxLength = 1200,
  ) => (
    <label htmlFor={inputId+'-'+key}>
      {title}
      {maxLength<=300?<Input id={inputId+'-'+key}
        aria-label={title}
        required={required}
        maxLength={maxLength}
        value={form[key]}
        onChange={(e)=>setForm({...form,[key]:e.target.value})}
      />:<Textarea id={inputId+'-'+key}
        aria-label={title}
        required={required}
        maxLength={maxLength}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />}
    </label>
  );
  const chooseRecords = (
    items: WorkEditorTarget[],
    selected: string[],
    set: (x: string[]) => void,
    title: string,
  ) => items.length ? (
    <fieldset>
      <legend>{title}</legend>
      {items.map(item => (
        <label key={refsKey(item)}>
          <input
            type="checkbox"
            checked={selected.includes(refsKey(item))}
            onChange={(e) =>
              set(
                e.target.checked
                  ? [...selected, refsKey(item)]
                  : selected.filter((x) => x !== refsKey(item)),
              )
            }
          />
          {item.summary ?? item.description ?? item.record?.summary ?? item.id}{' '}
          · {person(item.actorId ?? item.record?.reportedBy)} · 版本 {item.version}
        </label>
      ))}
    </fieldset>
  ) : null;
  return (
      <dialog ref={editor} className="workspace-dialog work-record-dialog" onCancel={event=>{event.preventDefault();closeEditor();}}>{action && (
        <form
          className="workspace-form work-editor-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(save);
          }}
        >
          <header className="dialog-heading"><h3>{actionTitles[action.kind]??'记录工作'}</h3><button type="button" className="icon-button" disabled={busy} aria-label="关闭记录编辑" onClick={closeEditor}><X size={19}/></button></header>
          {error&&<p className="message error" role="alert">{error}</p>}
          {composeError&&<div className="message error" role="alert"><p>{composeError}</p><button type="button" className="text-action" onClick={()=>downloadRecord(composeValue(),'galaxy-work-draft.json')}>保存本页输入</button><button type="button" className="text-action" disabled={busy} onClick={()=>void run(async()=>{await reloadSavedCompose();})}>放弃本页编辑，读取已保存稿</button></div>}
          <fieldset disabled={busy||!!action.pendingOperation} style={{ display: 'contents' }}>
          {!task.caseId && (
            <>

              <label>
                <input
                  type="checkbox"
                  checked={form.synthetic}
                  onChange={(e) =>
                    setForm({ ...form, synthetic: e.target.checked })
                  }
                />{' '}
                本次是合成或演示案例
              </label>
            </>
          )}
          {action.kind === 'attempt-start' && (
            <>
              {field('正在尝试的做法', 'strategy')}
              <p className="permission-line">这里只记录已经开始的尝试；尚未采用的建议可以留在讨论中。</p>
              {field('实际使用的环境；未知可留空', 'environment', false, 160)}
              {field('环境版本；未知可留空', 'environmentVersion', false, 80)}
              {field('实际使用哪些输入', 'inputScope')}
              {field('本人已获准的操作范围，每行一项', 'permissionScope')}
              <ConfigurationPicker {...{runtime,subjectId,busy,run}} single selected={configurationConditions} onChange={setConfigurationConditions}/>
              <a href="/app/configurations" target="_blank" rel="noopener">在独立页面登记配置版本</a>
            </>
          )}
          {['attempt-end', 'attempt-correct'].includes(action.kind) && (
            <>
              <label>
                尝试状态
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {[
                    ['completed', '本段尝试已结束'],
                    ['abandoned', '已放弃'],
                    ['canceled', '已取消'],
                    ['inconclusive', '无法确定'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('实际结果说明', 'summary')}
              {field('失败/中止原因；没有结论时明确填写未知', 'failureReason')}
            </>
          )}
          {action.kind === 'intervention' && (
            <>
              <label>
                做了哪方面的工作
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {Object.entries(names).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('做了什么', 'description')}
              {field('有什么作用', 'observedEffect')}
              {attempts.length>0&&<fieldset>
                <legend>关联已有尝试</legend>
                {attempts.map(x => (
                  <label key={x.id}>
                    <input
                      type="checkbox"
                      checked={related.includes(x.id)}
                      onChange={(e) =>
                        setRelated(
                          e.target.checked
                            ? [...related, x.id]
                            : related.filter((v) => v !== x.id),
                        )
                      }
                    />
                    {x.strategy} · {person(x.actorId)}
                  </label>
                ))}
              </fieldset>}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '关联已有来源（可选）',
              )}
            </>
          )}
          {action.kind === 'intervention-response' && (
            <>
              <p>{action.target?.description}</p>
              <label>
                本人意见
                <select
                  required
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="">选择你的意见</option>
                  <option value="accepted">认可实际作用</option>
                  <option value="partial">部分认可</option>
                  <option value="disputed">有具体异议</option>
                </select>
              </label>
              {field('本人意见说明', 'summary')}
            </>
          )}
          {action.kind === 'result-recorded' && (
            <>
              <label>
                这次结果来自本人的哪项实际工作
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择实际来源</option>
                  {ownOrigins.map(x => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.description ?? x.strategy} · 第 {x.version} 版
                    </option>
                  ))}
                </select>
              </label>
              {field('取得的具体结果', 'summary')}
              {field('适用限制与尚未做到的事情', 'limitations')}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '支持这份结果的来源（可选）',
              )}
            </>
          )}
          {['intervention','result-recorded'].includes(action.kind)&&<ConfigurationPicker {...{runtime,subjectId,busy,run}} selected={configurationSources} onChange={setConfigurationSources}/>}
          {['attempt-end', 'attempt-correct', 'result-recorded'].includes(
            action.kind,
          ) && (
            <label>
              得到的结果
              <select
                value={form.outcome}
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}
              >
                {Object.entries(outcomes).map(([id, title]) => (
                  <option key={id} value={id}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action.kind === 'deliver' && (
            <>
              <label>
                提交验收的本人结果
                <select
                  required
                  value={form.resultChoice}
                  onChange={(e) =>
                    setForm({ ...form, resultChoice: e.target.value })
                  }
                >
                  {eligibleResults.map(x => (
                    <option key={refsKey(x)} value={refsKey(x)}>
                      {x.summary} / 版本{x.version}
                    </option>
                  ))}
                </select>
              </label>
              {field('给发起者的说明', 'summary')}
              {chooseRecords(
                interventions,
                related,
                setRelated,
                '一同引用的工作（保留原作者）',
              )}
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '支持这次交付的来源（可选）',
              )}
            </>
          )}
          {action.kind === 'evidence' && (
            <>
              <label>
                证据类型
                <select
                  value={form.evidenceType}
                  onChange={(e) =>
                    setForm({ ...form, evidenceType: e.target.value })
                  }
                >
                  {[
                    ['self-assertion', '本人来源声明'],
                    ['test-result', '实际测试结果'],
                    ['git-commit', '代码提交'],
                    ['pull-request', 'Pull Request'],
                    ['ci-result', 'CI结果'],
                    ['build-result', '构建结果'],
                    ['organization-record', '组织记录'],
                    ['external-platform-record', '外部平台记录'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {form.evidenceType === 'ci-result' ? (
                <>
                  <p>
                    记录实际 GitHub Actions
                    来源。这里只保存你的来源声明，后续选择对应结果后可申请观察公开
                    CI；不会把声明直接算成已验证。
                  </p>
                  {field('GitHub 仓库所有者', 'ciOwner', true, 100)}
                  {field('仓库名称', 'ciRepository', true, 100)}
                  {field('实际 Workflow run ID', 'ciRunId', true, 24)}
                  {field('本次 run attempt', 'ciAttempt', true, 10)}
                  {field(
                    '本次实际 40 位小写 Git commit SHA',
                    'ciCommit',
                    true,
                    40,
                  )}
                  {action.target && !form.ciOwner && (
                    <p>
                      旧来源未按此结构登记。不同来源身份需要新建记录，不能用纠正覆盖旧来源。
                    </p>
                  )}
                </>
              ) : (
                <>
                  {field('来源系统名称', 'originSystem', true, 120)}
                  {field(
                    '实际来源的稳定编号（例如提交ID或报告编号）',
                    'externalStableId',
                    true,
                    1000,
                  )}
                  {field('实际内容版本', 'contentVersion', true, 240)}
                </>
              )}
              {field(
                '来源发布者/签发者（按所知如实描述）',
                'issuer',
                true,
                1000,
              )}
              {field(
                '实际来源链接（可选，不由银河自动打开）',
                'uri',
                false,
                2048,
              )}
              <label htmlFor={inputId+'-original-at'}>
                来源原始发生时间
                <Input id={inputId+'-original-at'}
                  type="datetime-local"
                  required
                  value={form.originalAt}
                  onChange={(e) =>
                    setForm({ ...form, originalAt: e.target.value })
                  }
                />
              </label>
              <label>
                本人观察到的来源状态
                <select
                  value={form.sourceState}
                  onChange={(e) =>
                    setForm({ ...form, sourceState: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知'],
                    ['available', '当时可用'],
                    ['unreachable', '当时不可达'],
                    ['removed', '已移除'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('来源说明与内容范围', 'summary', true, 4000)}
              <p>
                此处登记实际引用信息，不上传原始文件，不填写虚构的摘要哈希。来源声明和独立验证分别成立。
              </p>
            </>
          )}
          {action.kind === 'verification' && (
            <>
              <label>
                实际检查的目标版本
                <select
                  required
                  value={form.sourceChoice}
                  onChange={(e) =>
                    setForm({ ...form, sourceChoice: e.target.value })
                  }
                >
                  <option value="">选择检查目标</option>
                  {verificationTargets.flatMap(([kind, items]) =>
                    items
                      .filter(
                        (x) =>
                          !action.target?.record?.target ||
                          (kind === action.target.record.target.type &&
                            x.id === action.target.record.target.id),
                      )
                      .map((x) => (
                        <option
                          key={kind + refsKey(x)}
                          value={kind + ':' + refsKey(x)}
                        >
                          {x.summary ?? x.description ?? x.strategy} · 第 {x.version} 版
                        </option>
                      )),
                  )}
                </select>
              </label>
              <label>
                实际采用的方法
                <select
                  value={form.method}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      method: e.target.value,
                      observation: [
                        'participant-feedback',
                        'requester-acceptance',
                      ].includes(e.target.value)
                        ? 'comment'
                        : 'inconclusive',
                    })
                  }
                >
                  {Object.entries(methods)
                    .filter(
                      ([id]) => id !== 'requester-acceptance' || requester,
                    )
                    .map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                </select>
              </label>
              {field('本次检查或反馈仅涵盖什么', 'scope', true, 4000)}
              {field('实际环境、仓库版本及前提条件', 'conditions', true, 2000)}
              {field(
                '实际命令或检查方法；反馈可写未执行测试',
                'command',
                true,
                2000,
              )}
              <label>
                实际观察
                <select
                  value={form.observation}
                  onChange={(e) =>
                    setForm({ ...form, observation: e.target.value })
                  }
                >
                  {(['participant-feedback', 'requester-acceptance'].includes(
                    form.method,
                  )
                    ? [
                        ['comment', '意见'],
                        ['accepted', '接受'],
                        ['partially-accepted', '部分接受'],
                        ['rejected', '不接受'],
                        ['inconclusive', '不明确'],
                      ]
                    : [
                        ['passed', '所列检查通过'],
                        ['failed', '所列检查未通过'],
                        ['inconclusive', '不明确'],
                      ]
                  ).map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('检查说明、结果与未覆盖之处', 'summary', true, 4000)}
              <label>
                你与目标作者的关系（本人声明）
                <select
                  value={form.relationship}
                  onChange={(e) =>
                    setForm({ ...form, relationship: e.target.value })
                  }
                >
                  {[
                    ['unknown', '未知/不作独立声明'],
                    ['same-controller', '同一控制方'],
                    ['counterparty', '协作相对方'],
                    ['independent', '本人声明独立'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {chooseRecords(
                evidence,
                recordSelected,
                setRecordSelected,
                '实际检查使用的支持证据（测试/评审必须有来源，反馈可无）',
              )}
            </>
          )}
          {['evidence', 'verification'].includes(action.kind) && (
            <label htmlFor={inputId+'-observed-at'}>
              本人实际观察时间
              <Input id={inputId+'-observed-at'}
                type="datetime-local"
                required
                value={form.observedAt}
                onChange={(e) =>
                  setForm({ ...form, observedAt: e.target.value })
                }
              />
            </label>
          )}
          {action.kind === 'resolution-recorded' && (
            <>
              <label>
                整个问题的当前状态
                <select
                  value={form.resolution}
                  onChange={(e) =>
                    setForm({ ...form, resolution: e.target.value })
                  }
                >
                  {[
                    ['unresolved', '仍未解决'],
                    ['partially-resolved', '部分解决'],
                    ['resolved', '已解决'],
                    ['inconclusive', '暂不明确'],
                    ['regressed', '出现回归'],
                  ].map(([id, title]) => (
                    <option key={id} value={id}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {field('请求者的判断及适用范围', 'summary')}
              {field('已满足目标，每行一项', 'satisfied', false)}
              {field('仍未满足目标，每行一项', 'remaining', false)}
              {chooseRecords(
                results,
                related,
                setRelated,
                '本次明确依据的结果版本',
              )}
              {chooseRecords(
                verifications,
                recordSelected,
                setRecordSelected,
                '本次明确依据的检查版本（可以没有）',
              )}
            </>
          )}
          {action.target &&
            ['attempt-correct', 'evidence', 'verification', 'revoke'].includes(
              action.kind,
            ) &&
            field('为何纠正或撤回（保留原时点记录）', 'reason')}
          {action.kind === 'deliver' ? (
            <p className="muted">
              这份交付记录仅交给请求者。所引工作与证据分别沿用各作者原先授权，不扩大其他参与者权限。
            </p>
          ) : (
            <ReadingDetails mode="inline" className="work-scope-choice"><ReadingSummary>{viewers.length?person(subjectId)+"和 "+viewers.map(person).join("、")+"可读":"仅自己可读"} · 调整</ReadingSummary><fieldset>
              <legend>谁可以阅读这条记录？</legend>
              {[
                ...new Set([
                  task.requesterId,
                  ...(task.participations ?? []).map(p => p.subjectId),
                ]),
              ]
                .filter((id) => id !== subjectId)
                .map(id => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={viewers.includes(id)}
                      onChange={(e) =>
                        setViewers(
                          e.target.checked
                            ? [...viewers, id]
                            : viewers.filter((x) => x !== id),
                        )
                      }
                    />
                    <span title={id}>{person(id)}</span>
                    {id === task.requesterId
                      ? '（发起者）'
                      : ''}
                  </label>
                ))}
            </fieldset></ReadingDetails>
          )}
          </fieldset>
          <div className="button-row">
            <Button type="submit" disabled={busy || !!pending || !!action.pendingOperation}>
              {action.kind === 'deliver' ? '交给发起者' : '保存记录'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeEditor}
            >
              稍后继续
            </Button>
          </div>
        </form>
      )}</dialog>
  );
}
