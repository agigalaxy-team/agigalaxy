'use client';
import {Brand} from '../../components/Brand';
export default function AdminError({reset}:{error:Error&{digest?:string};reset:()=>void}){return <main className="galaxy-operator-login"><Brand/><h1>暂时无法打开后台</h1><p>请稍后重试，或重新登录。</p><button type="button" className="galaxy-primary-action" onClick={reset}>重新打开</button><p><a href="/admin/login">返回登录</a></p></main>;}
