'use client';
import {createContext,useContext,useLayoutEffect,useRef,useState} from 'react';
import type {SettingsDraftScope,SettingsDraftSession,SettingsDraftSnapshots} from './settings-draft-memory';
export const SettingsDraftMemoryContext=createContext<SettingsDraftSession|null>(null);

/** Restore only after this page has a fresh permitted read. The initialization
 * flag lets its existing source-default effects avoid overwriting restoration. */
export function useSettingsDraftMemory<K extends SettingsDraftScope>({scope,ready,denied=false,blocked=false,snapshot,restore,discard}:{scope:K;ready:boolean;denied?:boolean;blocked?:boolean;snapshot:()=>SettingsDraftSnapshots[K];restore:(value:SettingsDraftSnapshots[K])=>void;discard?:()=>void}){
 const session=useContext(SettingsDraftMemoryContext),prepared=useRef<SettingsDraftSession|null>(null),rejected=useRef(false),[initialized,setInitialized]=useState(false);
 const latest=useRef({snapshot,restore,ready,denied,blocked,discard});latest.current={snapshot,restore,ready,denied,blocked,discard};
 useLayoutEffect(()=>{
  if(!session||!session.current()){prepared.current=null;setInitialized(false);return;}
  if(denied){session.clear(scope);prepared.current=session;setInitialized(true);if(!rejected.current){rejected.current=true;latest.current.discard?.();}return;}
  rejected.current=false;
  if(!ready)return;
  if(blocked){setInitialized(true);return;}
  if(prepared.current!==session){const saved=session.read(scope);prepared.current=session;setInitialized(true);if(saved){latest.current.restore(saved);return;}}
  session.write(scope,snapshot());
 },[session,scope,ready,denied,blocked,snapshot]);
 useLayoutEffect(()=>()=>{
  if(session?.current()&&prepared.current===session&&latest.current.ready&&!latest.current.denied&&!latest.current.blocked)session.write(scope,latest.current.snapshot());
 },[session,scope]);
 return {initialized:initialized&&!!session?.current()&&(blocked||prepared.current===session),session};
}
