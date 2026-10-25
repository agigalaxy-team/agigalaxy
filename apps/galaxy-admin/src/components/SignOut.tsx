'use client';
import {useState} from 'react';
import {useAuth} from '@payloadcms/ui';
import {settingsDraftMemory} from '../lib/settings-draft-memory';
import {useClientReady} from '../lib/use-client-ready';
import {beginOperationsLogout} from '../lib/operations-read-lifecycle';
export function SignOut(){
  const {setUser}=useAuth(),ready=useClientReady();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function logout(){if(busy)return;setBusy(true);setError('');const resumeReads=beginOperationsLogout();try{
    const response=await fetch('/v1/operations/session',{cache:'no-store'});if(!response.ok)throw Error();const session=await response.json();
    if(session.state==='signed-in'){const result=await fetch('/v1/operations/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Galaxy-Operator-CSRF':session.csrfToken},body:'{}'});if(!result.ok||(await result.json()).state!=='signed-out')throw Error();}
    settingsDraftMemory.clear();
    setUser(null);
    location.assign('/admin/login?signedOut=1');
  }catch{resumeReads();setError('退出暂未完成，请重试。');setBusy(false);}}
  return <div className="galaxy-operator-logout"><button type="button" disabled={!ready||busy} onClick={()=>void logout()}>{busy?'正在退出…':'退出'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
