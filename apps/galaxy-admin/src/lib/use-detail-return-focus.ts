'use client';

import {useCallback,useLayoutEffect,useRef} from 'react';

export function useDetailReturnFocus({selectedKey,scopeKey,readableKeys}:{selectedKey:string;scopeKey:string;readableKeys:readonly string[]|null}){
 const buttons=useRef(new Map<string,HTMLButtonElement>()),pending=useRef<{key:string;scope:string}|null>(null);
 const register=useCallback((key:string,button:HTMLButtonElement|null)=>{if(button)buttons.current.set(key,button);else buttons.current.delete(key);},[]);
 const prepareReturn=useCallback(()=>{pending.current=selectedKey?{key:selectedKey,scope:scopeKey}:null;},[selectedKey,scopeKey]);
 useLayoutEffect(()=>{
  const intent=pending.current;if(!intent)return;
  if(scopeKey!==intent.scope||!readableKeys?.includes(intent.key)){pending.current=null;return;}
  if(selectedKey){if(selectedKey!==intent.key)pending.current=null;return;}
  pending.current=null;
  const button=buttons.current.get(intent.key);
  if(button?.isConnected&&!button.disabled&&(!document.activeElement||document.activeElement===document.body))button.focus({preventScroll:true});
 },[selectedKey,scopeKey,readableKeys]);
 return {register,prepareReturn};
}
