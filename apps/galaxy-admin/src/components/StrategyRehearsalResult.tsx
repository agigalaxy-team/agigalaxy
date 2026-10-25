'use client';

import type {StrategyConfiguration,StrategyExecutionCheck,StrategyRehearsal} from './strategies-types';
import {operatorPermissionLabel} from '../lib/access';
import {strategyCodeNames,strategyRehearsalReady,strategyRouteNames} from '../lib/strategies-view-model';
import './autonomy.css';

const checks:Record<string,[string,string]>={
 'execution-configured':['执行设置','尚未配置执行方式。'],
 'ai-account-enabled':['AI 工作账户','所选 AI 工作账户尚未启用。'],
 'current-role':['当前业务角色','AI 尚无有效业务角色。'],
 'purpose-defined':['工作目标','共同目标、领域目标或策略目标尚未填写。'],
 'scope-resolved':['对象范围','尚未明确对象范围，或尚未选择具体对象。'],
 'trigger-configured':['触发设置','触发时刻、间隔或业务事件尚未补齐。'],
 'concrete-sample':['指定对象核对','尚无当前可用的指定对象。'],
 role:['动作权限','该动作未包含在 AI 当前角色权限内。'],
 handler:['动作处理通道','该动作的业务处理服务尚未接通。'],
 'ordinary-action':['自主办理范围','该动作不满足自主办理条件，需要人工处理。'],
 grant:['自动执行授权','缺少覆盖该动作、执行岗位和对象范围的有效自动授权。'],
 'preview-read':['对象查看权限','当前管理人员没有核对这个业务对象的权限。'],
 source:['指定对象当前状态','指定对象已不可用，或不符合当前处理条件。'],
};
const objectKinds:Record<string,string>={post:'帖子',reply:'回复',section:'分区',projects:'项目资源',methods:'方法资源',account:'账户',feedback:'反馈',case:'举报','chat-file':'私信文件','forum-file':'论坛文件','message-plan':'消息计划','search-quality':'搜索配置'};
function checkText(check:StrategyExecutionCheck){const [kind,action]=check.key.split(':'),value=checks[check.key]??checks[kind],label=(value?.[0]??'处理条件')+(action&&checks[kind]&&/^[a-z][a-z0-9_.-]{0,119}$/.test(action)?' · '+operatorPermissionLabel(action):'');const detail=check.detail&&/[\u3400-\u9fff]/.test(check.detail)?check.detail.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'关联记录'):null;return{label,description:detail??(check.state==='unknown'?'当前条件尚不能核对。':value?.[1]??'所需处理条件尚未满足。')};}

export function StrategyRehearsalResult({value,configuration}:{value:StrategyRehearsal;configuration:StrategyConfiguration}){
 const expected=configuration.strategies.filter(strategy=>strategy.enabled&&strategy.execution),missing=expected.filter(strategy=>!value.executionPreviews.some(preview=>preview.strategyId===strategy.id)),ready=strategyRehearsalReady(value,configuration);
 return <div className="strategies-rehearsal" role="status"><strong>{ready?'当前预演条件满足':'预演尚未满足发布条件'}</strong><span>模型调用 0 · 未办理业务</span>
  {missing.length>0&&<p>{missing.map(strategy=>strategy.name).join('、')}的执行预演结果尚未取得。</p>}
  {value.uncoveredStrategyIds.length>0&&<p>{value.uncoveredStrategyIds.map(id=>configuration.strategies.find(strategy=>strategy.id===id)?.name??'策略').join('、')}仍有未满足的检查。</p>}
  <div className="strategies-execution-previews">{value.executionPreviews.map(preview=>{const failed=preview.checks.filter(check=>check.state!=='pass'),passed=preview.checks.filter(check=>check.state==='pass');return <section key={preview.strategyId} data-valid={preview.valid}><header><h3>{configuration.strategies.find(strategy=>strategy.id===preview.strategyId)?.name??'策略'}</h3><span>{preview.valid?'配置与当前处理条件已满足':'仍有处理条件未满足'}</span></header>
   <p>{passed.length} 项检查通过{failed.length?' · '+failed.length+' 项待处理':''}</p>
   {failed.length>0&&<ul className="strategies-preview-checks">{failed.map((check,index)=>{const text=checkText(check);return <li key={check.key+index}><strong>{check.state==='unknown'?'待核对':'不满足'} · {text.label}</strong><span>{text.description}</span></li>;})}</ul>}
   {passed.length>0&&<p className="strategies-muted">已核对：{[...new Set(passed.map(check=>checkText(check).label))].join('、')}</p>}
   <p>{preview.qualification==='checked-before-each-action'?'对象范围采用持续条件，每次办理前逐一核对当时的对象与授权。':'本次仅核对当前指定对象及其来源版本，每次办理前仍会再次核对。'}</p>
   {preview.objects.length>0?<ul className="strategies-preview-objects">{preview.objects.map((object,index)=><li key={object.action+object.id}><span>对象 {index+1} · {objectKinds[object.kind??'']??'业务对象'} · {operatorPermissionLabel(object.action)}</span><span>{object.available?'当前可用':'当前不可用'}{typeof object.version==='number'?' · 来源版本 '+object.version:object.version?' · 来源版本已记录':' · 来源版本未取得'}{typeof object.revision==='number'?' · 修订 '+object.revision:''}</span></li>)}</ul>:preview.scope.kind==='selected'&&<p>指定对象的核对记录尚未取得。</p>}
   {preview.grants.length>0&&<p>本次覆盖授权：{preview.grants.map((grant,index)=>'授权 '+(index+1)+' · 版本 '+grant.version).join('；')}</p>}
   <p className="strategies-muted">语义判断尚未验证；本次未调用模型，未执行正式处理。</p>
  </section>;})}</div>
  {value.samples.map((sample,index)=><p key={sample.strategyId+sample.executionId+index}>{configuration.strategies.find(strategy=>strategy.id===sample.strategyId)?.name??'策略'} · {strategyRouteNames[sample.classification.route]}{sample.classification.code&&strategyCodeNames[sample.classification.code]?' · '+strategyCodeNames[sample.classification.code]:''}</p>)}
 </div>;
}
