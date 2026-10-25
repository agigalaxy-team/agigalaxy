import type {AdminViewServerProps} from 'payload';
import {Brand} from './Brand';
import {operatorLoginTarget} from '../lib/operator-login-target.mjs';
export function Login({searchParams}:Partial<AdminViewServerProps>){
  const returnTo=operatorLoginTarget(searchParams?.redirect);
  return <main className="galaxy-operator-login"><Brand/><h1>登录运营后台</h1><p>使用已获授权的银河管理账户。</p><a className="galaxy-primary-action" href={'/v1/operations/login?returnTo='+encodeURIComponent(returnTo)}>登录</a></main>;
}
