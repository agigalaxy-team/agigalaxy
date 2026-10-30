'use client';
import {useEffect,useId,useRef} from 'react';
import type {ModelSettingsConfiguration} from './model-settings-types';
import {modelSettingsDomainNames,modelSettingsDomains} from '../../lib/models/model-settings-view-model';

export function ModelRemovalDialog({id,configuration,onCancel,onConfirm,disabled}:{id:string;configuration:ModelSettingsConfiguration;onCancel:()=>void;onConfirm:()=>void;disabled:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),title=useId();
 const model=configuration.models.find(item=>item.id===id),domains=modelSettingsDomains.filter(domain=>configuration.scenarios[domain]?.modelId===id),dependents=configuration.models.filter(item=>item.id!==id&&item.fallbacks?.some(backup=>backup.modelId===id));
 useEffect(()=>{dialog.current?.showModal();},[]);
 return <dialog ref={dialog} className="model-removal-dialog" aria-labelledby={title} onCancel={onCancel}><h2 id={title}>删除“{model?.displayName||'未命名模型'}”配置？</h2>{!!domains.length&&<p>同时取消场景分配：{domains.map(domain=>modelSettingsDomainNames[domain]).join('、')}。</p>}{!!dependents.length&&<p>从以下模型的备用列表中移除：{dependents.map(item=>item.displayName||'未命名模型').join('、')}。</p>}<p>保存并应用后生效，历史配置与用量记录保留。</p><footer><button type="button" autoFocus onClick={onCancel}>取消</button><button type="button" className="model-settings-danger" disabled={disabled||!model} onClick={onConfirm}>删除配置</button></footer></dialog>;
}
