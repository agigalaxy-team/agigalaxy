'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import type {BusinessUser,UserPage} from './business-types';
import {useOperationsRead} from '../lib/use-operations-read';
import {AccountReference,ReadStatus} from './OperationControls';
export type AccountPickerKnownAccount={accountId:string;uid:string|null;displayName:string|null;state:'available'|'unavailable';readExpiresAt:number};
type KnownAccounts=Readonly<Record<string,AccountPickerKnownAccount>>;
export function AccountPicker({selected,onChange,disabled=false,maxSelected=500,canSearchEmail=true,clearOnOffline=false,label='查找收件账户',knownAccounts,onKnownAccountsChange}:{selected:string[];onChange:(value:string[])=>void;disabled?:boolean;maxSelected?:number;canSearchEmail?:boolean;clearOnOffline?:boolean;label?:string;knownAccounts?:KnownAccounts;onKnownAccountsChange?:(value:KnownAccounts)=>void}){
  const [input,setInput]=useState(''),[query,setQuery]=useState(''),[after,setAfter]=useState(''),[known,setKnown]=useState<Record<string,Pick<BusinessUser,'uid'|'displayName'>>>({});
  const [qualified,setQualified]=useState<Record<string,AccountPickerKnownAccount>>({}),produced=useRef(false),leased=knownAccounts!==undefined||onKnownAccountsChange!==undefined,selectedKey=selected.join(',');
  const page=useOperationsRead<UserPage>({path:query?'/v1/operations/users?'+new URLSearchParams({query,limit:'20',...(after?{after}:{})}):null,failureMessage:'账户暂时无法查找。',clearOnOffline});
  const liveNames={...qualified};for(const [id,value] of Object.entries(knownAccounts??{}))if(!liveNames[id]||value.readExpiresAt>=liveNames[id].readExpiresAt)liveNames[id]=value;
  const visibleKnown:Record<string,{uid:string|null;displayName:string|null}>=leased?{...known,...liveNames}:known;
  useLayoutEffect(()=>{
    if(!leased)return;
    if(query&&/登录|权限|未获准/.test(page.error)){produced.current=true;setQualified({});setKnown({});onKnownAccountsChange?.({});return;}
    if(!page.verified||!page.value)return;
    // Reuse the qualified user-read window; unrelated searches never renew old names.
    const readExpiresAt=page.value.checkedAt+30;if(!Number.isFinite(readExpiresAt)||readExpiresAt<=Date.now()/1000)return;
    const matching=page.value.items.filter(item=>selected.includes(item.accountId));if(!matching.length)return;
    setKnown(previous=>({...previous,...Object.fromEntries(matching.map(item=>[item.accountId,{uid:item.uid,displayName:item.displayName}]))}));
    produced.current=true;setQualified(previous=>{const next={...previous};for(const item of matching)next[item.accountId]={accountId:item.accountId,uid:item.uid,displayName:item.displayName,state:'available',readExpiresAt};return JSON.stringify(next)===JSON.stringify(previous)?previous:next;});
  },[leased,page.value,page.verified,page.error,query,selectedKey]);
  useLayoutEffect(()=>{
    if(!leased||!produced.current)return;
    const live=Object.fromEntries(Object.entries(qualified).filter(([id,value])=>selected.includes(id)&&value.readExpiresAt>Date.now()/1000));onKnownAccountsChange?.(live);
    const expiry=Math.min(...Object.values(qualified).map(value=>value.readExpiresAt));if(!Number.isFinite(expiry))return;
    if(expiry>Date.now()/1000){const timer=setTimeout(()=>onKnownAccountsChange?.(Object.fromEntries(Object.entries(qualified).filter(([id,value])=>selected.includes(id)&&value.readExpiresAt>Date.now()/1000))),Math.max(0,expiry*1000-Date.now())+1);return()=>clearTimeout(timer);}
  },[leased,qualified,onKnownAccountsChange,selectedKey]);
  function select(item:BusinessUser){if(disabled||selected.includes(item.accountId)||maxSelected!==1&&selected.length>=maxSelected||leased&&(!page.verified||!navigator.onLine))return;setKnown(previous=>({...previous,[item.accountId]:{uid:item.uid,displayName:item.displayName}}));if(leased&&page.value){produced.current=true;const readExpiresAt=page.value.checkedAt+30;setQualified(previous=>({...previous,[item.accountId]:{accountId:item.accountId,uid:item.uid,displayName:item.displayName,state:'available',readExpiresAt}}));}onChange(maxSelected===1?[item.accountId]:[...selected,item.accountId]);}
  return <div><label>{label}<input type="search" value={input} disabled={disabled} maxLength={200} placeholder={canSearchEmail?'UID、用户名或完整邮箱':'UID或用户名'} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();setQuery(input.trim());setAfter('');}}}/></label><button type="button" className="galaxy-secondary" disabled={disabled||!input.trim()} onClick={()=>{setQuery(input.trim());setAfter('');}}>查找账户</button><ReadStatus loading={page.loading} error={page.error} retry={page.read}/>{page.value&&<><ul className="galaxy-records">{page.value.items.map(item=><li key={item.accountId}><strong>{item.displayName||item.uid}</strong><span>UID {item.uid}</span><button type="button" className="galaxy-secondary" disabled={disabled||selected.includes(item.accountId)||maxSelected!==1&&selected.length>=maxSelected} onClick={()=>select(item)}>{selected.includes(item.accountId)?'已选择':'选择此账户'}</button></li>)}</ul>{!page.value.items.length&&<p>没有相符的账户。</p>}{page.value.nextAfter&&<button type="button" className="galaxy-secondary" disabled={disabled||page.loading} onClick={()=>setAfter(page.value!.nextAfter!)}>下一批账户</button>}</>}{selected.length>0&&<><h3>已选择 {selected.length} 个账户</h3><ul className="galaxy-records">{selected.map(id=><li key={id}>{leased&&liveNames[id]?.state==='unavailable'?<span>账户当前不可用</span>:<AccountReference id={id} label={visibleKnown[id]?.displayName||visibleKnown[id]?.uid||(leased?'名称暂无法取得':undefined)}/>}<button type="button" className="galaxy-secondary" disabled={disabled} onClick={()=>onChange(selected.filter(value=>value!==id))}>移除</button></li>)}</ul></>}</div>;
}
