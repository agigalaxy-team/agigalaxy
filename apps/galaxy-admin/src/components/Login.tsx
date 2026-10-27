import type {AdminViewServerProps} from 'payload';
import {Brand} from './Brand';
import {operatorLoginTarget} from '../lib/operator-login-target.mjs';
import {OperatorLoginNavigation} from './OperatorLoginNavigation';
export function Login({searchParams}:Partial<AdminViewServerProps>){
  const returnTo=operatorLoginTarget(searchParams?.redirect);
  const target='/v1/operations/login?returnTo='+encodeURIComponent(returnTo);
  return <main className="galaxy-operator-login"><OperatorLoginNavigation target={target} automatic={searchParams?.signedOut!=='1'}/><Brand/><h1>登录运营后台</h1><p>使用已获授权的银河管理账户。</p><a className="galaxy-primary-action" href={target}>登录</a></main>;
}
