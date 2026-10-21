'use client';
import {useState} from 'react';
export function SignOut(){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function logout(){if(busy)return;setBusy(true);setError('');try{
    const response=await fetch('/v1/operations/session',{cache:'no-store'});if(!response.ok)throw Error();const session=await response.json();
    if(session.state==='signed-in'){const result=await fetch('/v1/operations/logout',{method:'POST',headers:{'X-Galaxy-Operator-CSRF':session.csrfToken}});if(!result.ok)throw Error();}
    location.assign('/admin/login');
  }catch{setError('退出暂未完成，请重试。');setBusy(false);}}
  return <div className="galaxy-operator-logout"><button type="button" disabled={busy} onClick={()=>void logout()}>{busy?'正在退出…':'退出'}</button>{error&&<p role="alert">{error}</p>}</div>;
}
