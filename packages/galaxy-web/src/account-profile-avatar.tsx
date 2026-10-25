import React,{useId} from 'react';
import {accountAvatarKey,accountAvatarOptions} from '../../galaxy-official/src/shared/account-profile-presentation.mjs';
import {accountAvatarSelection} from './account-avatar-assets.mjs';
import './account-profile-avatar.css';

type SubjectType='person'|'organization'|'agent'|null;
export function AccountProfileAvatar({avatarKey,seed,subjectType=null,className='',size}:{name?:string|null;avatarKey?:string|null;seed?:string|null;subjectType?:SubjectType;className?:string;size?:number}){
 const key=accountAvatarKey(avatarKey),avatar=accountAvatarSelection(key,seed,subjectType);
 return <span className={'galaxy-profile-avatar '+className} data-avatar-key={key??'default'} data-subject-type={avatar.subjectType} aria-hidden="true" style={size?{width:size,height:size,minWidth:size}:undefined}><img src={avatar.src} alt="" width={128} height={128} draggable={false} decoding="async"/></span>;
}
export function AccountAvatarPicker({value,onChange,disabled=false,name,seed,subjectType=null}:{value:string|null;onChange:(key:string|null)=>void;disabled?:boolean;name?:string;seed?:string|null;subjectType?:SubjectType}){
 const id=useId(),group=name??id,choices=[{key:null,label:'默认头像'},...accountAvatarOptions.map((option,index)=>({key:option.key,label:'头像 '+(index+1)}))];
 return <fieldset className="galaxy-profile-avatar-picker" disabled={disabled}><legend>头像</legend><div className="galaxy-profile-avatar-options">{choices.map(option=><label key={option.key??'default'} className="galaxy-profile-avatar-choice" data-selected={value===option.key}><input type="radio" name={group} checked={value===option.key} onChange={()=>onChange(option.key)}/><AccountProfileAvatar avatarKey={option.key} seed={seed} subjectType={subjectType} size={32}/><span>{option.label}</span></label>)}</div><p className="galaxy-profile-avatar-credit">人物：<a href="https://personas.draftbit.com/" target="_blank" rel="noreferrer">Personas by Draftbit</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>；机器人：<a href="https://bottts.com/" target="_blank" rel="noreferrer">Bottts</a>；图形：DiceBear。默认头像随账户保持一致。</p></fieldset>;
}

