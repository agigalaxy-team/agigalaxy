import type {AdminViewServerProps} from 'payload';
import {operatorLoginTarget} from '../lib/operator-login-target.mjs';
import {OperatorLoginNavigation} from './OperatorLoginNavigation';
export function Login({searchParams}:Partial<AdminViewServerProps>){
 const returnTo=operatorLoginTarget(searchParams?.redirect),target='/v1/operations/login?returnTo='+encodeURIComponent(returnTo);
 const reason=typeof searchParams?.reason==='string'&&['denied','stale'].includes(searchParams.reason)?searchParams.reason:null;
 return <OperatorLoginNavigation target={target} reason={reason}/>;
}
