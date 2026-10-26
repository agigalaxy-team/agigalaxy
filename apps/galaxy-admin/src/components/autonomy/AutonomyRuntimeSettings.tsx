'use client';

import {autonomyRuntimeConfiguration,autonomyRuntimeFields,autonomyRuntimeMerge,autonomyRuntimeDraft} from "../../lib/system-settings/system-settings-view-model";
import type {AutonomyRuntimeRead} from './autonomy-types';
import type {AutonomyRuntimeFields,AutonomyRuntimeChoices,SystemSettingsDraftEntry} from "../system-settings/system-settings-types";
import {ReadStatus} from "../OperationControls";
import {Panel,Empty} from "../system-settings/SystemSettingsPanels";

type Props={value:AutonomyRuntimeRead|null;entry:SystemSettingsDraftEntry<AutonomyRuntimeFields>|null;choices:AutonomyRuntimeChoices|null;loading:boolean;error:string;canRead:boolean;canConfigure:boolean;locked:boolean;pending:boolean;busy:boolean;message:string;commandError:string;formError:string;onChange:(key:keyof AutonomyRuntimeFields,value:string)=>void;onChoice:(key:keyof AutonomyRuntimeFields,value:'mine'|'current')=>void;onSave:()=>void;onDiscard:()=>void;refresh:()=>Promise<unknown>;retry:()=>unknown};

export function AutonomyRuntimeSettings({value,entry,choices,loading,error,canRead,canConfigure,locked,pending,busy,message,commandError,formError,onChange,onChoice,onSave,onDiscard,refresh,retry}:Props){
 const changed=!!value&&!!entry&&value.settings.revision!==entry.revision;
 const merge=changed&&value&&entry?autonomyRuntimeMerge(entry.base,entry.draft,autonomyRuntimeDraft(value.settings),choices?.revision===value.settings.revision?choices.fields:{}):null;
 const dirty=!!entry&&autonomyRuntimeFields.some(([key])=>entry.draft[key]!==entry.base[key]);
 const parsed=entry&&value?autonomyRuntimeConfiguration(entry.draft,value.limits.concurrencyMaximum):null;
 return <Panel title="自动运行参数" action={value?<span className="ss-muted">已存版本 {value.settings.revision}</span>:undefined}>
  {!canRead?<p className="ss-muted">当前没有自动运行配置的查看权限。</p>:<><ReadStatus loading={loading} error={error} retry={refresh}/>{value&&entry?<>
   <fieldset disabled={locked||!canConfigure} onKeyDown={event=>{if(event.key==='Enter'&&event.target instanceof HTMLInputElement){event.preventDefault();if(dirty&&!changed&&parsed?.value&&!locked&&canConfigure)onSave();}}}>
    <div className="ss-form">
     {merge&&<div className="ss-conflict"><p>运行参数已有更新，你的修改已保留。</p>{merge.conflicts.map(field=><fieldset key={field.key}><legend>{field.label}</legend>{(['current','mine'] as const).map(choice=><label key={choice}><input type="radio" name={'ss-runtime-'+field.key} checked={choices?.revision===value.settings.revision&&choices.fields[field.key]===choice} onChange={()=>onChoice(field.key,choice)}/><span>{choice==='current'?'当前设置':'我的修改'}：{field[choice]||'空白'}</span></label>)}</fieldset>)}</div>}
     <div className="ss-form-grid">{autonomyRuntimeFields.map(([key,label,min,maximum,help])=><label key={key}>{label}<input aria-label={label} inputMode="numeric" min={min} max={key==='concurrency'?Math.min(maximum,value.limits.concurrencyMaximum):maximum} maxLength={12} value={entry.draft[key]} onChange={event=>onChange(key,event.currentTarget.value)}/><span className="ss-field-help">{help}</span></label>)}</div>
    </div>
   </fieldset>
   {formError&&<p role="alert" className="ss-validation">{formError}</p>}
   <div className="ss-actions" style={{marginTop:16}}><button type="button" disabled={locked||!dirty} onClick={onDiscard}>撤销参数修改</button>{canConfigure&&<button type="button" className="ss-primary" disabled={locked||changed||!dirty||!parsed?.value} onClick={onSave}>保存运行参数</button>}</div>
  </>:!error&&<Empty>{loading?'正在读取运行参数…':'运行参数暂未取得。'}</Empty>}</>}
  {(pending||commandError||message)&&<p role="status" className="ss-feedback" data-tone={commandError?'error':pending?undefined:'success'}><span>{commandError||(pending?'正在查询参数保存结果…':message)}</span>{pending&&commandError&&<button type="button" disabled={busy} onClick={()=>void retry()}>重新连接</button>}</p>}
 </Panel>;
}
