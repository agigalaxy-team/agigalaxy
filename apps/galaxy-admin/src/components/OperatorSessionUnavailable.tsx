'use client';
import {useRouter} from 'next/navigation';
export function OperatorSessionUnavailable(){const router=useRouter();return <main id="galaxy-admin-main" className="galaxy-operations"><h1>暂时无法核对管理会话</h1><output>当前登录状态尚未确认，页面位置已保留。重新核对后可继续。</output><button type="button" onClick={()=>router.refresh()}>重新核对</button></main>;}
