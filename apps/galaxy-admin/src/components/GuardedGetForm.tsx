'use client';

import {useRef,useState} from 'react';
import type {FormHTMLAttributes,SubmitEvent as ReactSubmitEvent} from 'react';
import {flushSync} from 'react-dom';
import Link from 'next/link';
import {useSettingsDraftLinkActivation} from '../lib/settings-draft-link-activation';

type Props=Omit<FormHTMLAttributes<HTMLFormElement>,'action'>&{action:string;blocked?:boolean};

/** Native GET fallback; hydrated navigation still passes the existing anchor guard. */
export function GuardedGetForm({action,method='get',blocked=false,onSubmit,children,...props}:Props){
 const link=useRef<HTMLAnchorElement>(null),[destination,setDestination]=useState(action);
 const activate=useSettingsDraftLinkActivation();
 function submit(event:ReactSubmitEvent<HTMLFormElement>){
  if(blocked){event.preventDefault();return;}
  onSubmit?.(event);if(event.defaultPrevented||!link.current)return;
  const form=event.currentTarget,submitter=event.nativeEvent.submitter;
  const control=submitter instanceof HTMLButtonElement||submitter instanceof HTMLInputElement?submitter:null;
  const target=control?.getAttribute('formtarget')??form.target,requestMethod=control?.getAttribute('formmethod')??form.method;
  if(requestMethod.toLowerCase()!=='get'||target&&target!=='_self'||control instanceof HTMLInputElement&&control.type==='image')return;
  const url=new URL(control?.getAttribute('formaction')??form.action,document.baseURI);
  if(url.origin!==location.origin)return;
  const values=new FormData(form,control),query=new URLSearchParams();
  for(const [name,value] of values){if(typeof value!=='string')return;query.append(name,value);}
  url.search=query.toString();
  event.preventDefault();
  // Next Link's click closure must see this submission's href, not the prior render.
  flushSync(()=>setDestination(url.pathname+url.search+url.hash));
  activate(link.current);
 }
 return <form {...props} action={action} method={method} onSubmit={submit}>{children}<Link ref={link} href={destination} prefetch={false} hidden aria-hidden="true" tabIndex={-1}>应用筛选</Link></form>;
}
