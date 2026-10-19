import React from 'react';
import {Button} from '@/components/ui/button';

export function needsAccountVerification(reason:unknown){
  const code=reason!==null&&(typeof reason==='object'||typeof reason==='function')?Reflect.get(reason,'code')??Reflect.get(reason,'message')??reason:reason;
  return typeof code==='string'&&['account_verification_required','verified_account_required'].includes(code);
}
export function AccountVerificationPrompt({required,navigate}:{required:boolean;navigate:(path:string)=>void}){
  if(!required)return null;
  return <div className="button-row"><Button type="button" variant="outline" onClick={()=>navigate('/app/settings/identity?section=account')}>关联银河账户</Button></div>;
}
