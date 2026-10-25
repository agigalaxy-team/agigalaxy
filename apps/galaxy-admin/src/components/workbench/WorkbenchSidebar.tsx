'use client';

import {useEffect,useId,useRef,useState} from 'react';
import Link from 'next/link';
import {AdminIcon} from '../AdminIcons';
import {WorkbenchEmpty,workbenchNumber} from './WorkbenchCharts';
import {defaultWorkbenchShortcuts,workbenchShortcuts,type WorkbenchPending,workbenchTime,type WorkbenchRecord} from '../../lib/workbench-view-model';

const pendingGroups=[{id:'all',label:'全部'},{id:'reports',label:'举报'},{id:'feedback',label:'反馈'},{id:'files',label:'文件'},{id:'delivery',label:'发送'},{id:'system',label:'运行'}];

export function WorkbenchPendingList({items,available,loading,denied=false,restricted=false}:{items:WorkbenchPending[];available:boolean;loading:boolean;denied?:boolean;restricted?:boolean}){
  const [group,setGroup]=useState('all'),titleId=useId();
  const visible=group==='all'?items:items.filter(item=>item.group===group);
  return <section className="wb-side-panel wb-pending" aria-labelledby={titleId}><header className="wb-section-heading"><h2 id={titleId}>待办</h2></header><div className="wb-pending-filters" role="group" aria-label="待办类型">{pendingGroups.map(item=><button type="button" key={item.id} aria-pressed={group===item.id} onClick={()=>setGroup(item.id)}>{item.label}</button>)}</div>
    <div className="wb-pending-scroll">{denied?<WorkbenchEmpty title="没有待办数据的查看权限" icon="permissions"/>:!available?<WorkbenchEmpty title={loading?'正在读取待办':'待办暂时无法取得'} icon="workspace"/>:!visible.length?<WorkbenchEmpty title={restricted?'当前授权范围内暂无待办':group==='all'?'暂无可显示的待办':'此类暂无待处理事项'} icon="check"/>:<ul className="wb-pending-list">{visible.map(item=><li key={item.id}><span className={'wb-pending-icon wb-pending-icon--'+item.group}><AdminIcon name={item.icon} size={19}/></span><div><h3>{item.label}</h3><p><strong>{workbenchNumber(item.count)}</strong> {item.unit}</p></div><Link prefetch={false} href={item.href} className="wb-small-action">查看</Link></li>)}</ul>}</div>
  </section>;
}

export function WorkbenchProgress({records,available,running,waiting}:{records:WorkbenchRecord[];available:boolean;running:number|null;waiting:number|null}){
  const titleId=useId();
  return <section className="wb-side-panel wb-progress" aria-labelledby={titleId}><header className="wb-section-heading"><h2 id={titleId}>最近推进</h2></header>{available&&records.length?<ol className="wb-progress-list">{records.slice(0,3).map(record=><li key={record.id}><span className="wb-progress-mark"><AdminIcon name="activity" size={17}/></span><div><Link prefetch={false} href={record.href}>{record.label}</Link><time dateTime={record.createdAt}>{workbenchTime(record.createdAt)}</time></div></li>)}</ol>:<p className="wb-inline-empty">{available?'暂无推进记录':'推进记录暂时无法取得'}</p>}{running!==null&&waiting!==null&&<div className="wb-program-state"><span>程序任务</span><Link prefetch={false} href="/admin/operations/jobs">{workbenchNumber(running)} 执行中 · {workbenchNumber(waiting)} 等待</Link></div>}</section>;
}

export function WorkbenchShortcuts({operatorId}:{operatorId:string|null}){
  const [selection,setSelection]=useState(defaultWorkbenchShortcuts),[editing,setEditing]=useState(defaultWorkbenchShortcuts),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),titleId=useId(),dialogTitle=useId();
  const storageKey=operatorId?'galaxy:operations:workbench:shortcuts:v1:'+operatorId:null;
  useEffect(()=>{
    if(!storageKey)return;
    try{const saved=window.localStorage.getItem(storageKey);if(saved!==null){const value:unknown=JSON.parse(saved);if(Array.isArray(value))setSelection([...new Set(value.filter((id):id is string=>typeof id==='string'&&workbenchShortcuts.some(item=>item.id===id)))]);}}
    catch{/* Unavailable storage does not block the dashboard or in-page choices. */}
  },[storageKey]);
  const open=()=>{setEditing([...selection]);setError('');dialog.current?.showModal();};
  const save=()=>{
    setSelection([...editing]);setError('');
    if(storageKey){try{window.localStorage.setItem(storageKey,JSON.stringify(editing));}catch{setError('此浏览器暂时无法保存常用入口，本次选择仍可使用。');}}
    dialog.current?.close();
  };
  const selected=selection.flatMap(id=>{const item=workbenchShortcuts.find(item=>item.id===id);return item?[item]:[];});
  return <section className="wb-side-panel wb-shortcuts" aria-labelledby={titleId}><header className="wb-section-heading"><h2 id={titleId}>常用入口</h2><button type="button" className="wb-text-button" onClick={open}>自定义</button></header>{selected.length?<nav className="wb-shortcut-grid" aria-label="常用功能">{selected.map(item=><Link prefetch={false} href={item.href} key={item.id}><AdminIcon name={item.icon} size={23}/><span>{item.label}</span></Link>)}</nav>:<p className="wb-inline-empty">尚未选择常用入口</p>}{error&&<p className="wb-preference-error" role="status">{error}</p>}
    <dialog ref={dialog} className="wb-shortcut-dialog" aria-labelledby={dialogTitle}><header className="wb-section-heading"><h2 id={dialogTitle}>自定义常用入口</h2><button type="button" className="wb-icon-button" aria-label="取消修改" onClick={()=>dialog.current?.close()}><AdminIcon name="close" size={20}/></button></header><div className="wb-shortcut-choices">{workbenchShortcuts.map(item=><label key={item.id}><input type="checkbox" checked={editing.includes(item.id)} onChange={event=>setEditing(previous=>event.target.checked?[...previous,item.id]:previous.filter(id=>id!==item.id))}/><AdminIcon name={item.icon} size={19}/><span>{item.label}</span></label>)}</div><footer><button type="button" className="wb-button" onClick={()=>dialog.current?.close()}>取消</button><button type="button" className="wb-button wb-button--primary" onClick={save}>保存</button></footer></dialog>
  </section>;
}
