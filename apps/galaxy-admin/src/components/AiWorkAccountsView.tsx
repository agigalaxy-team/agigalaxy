import type {AdminViewServerProps} from 'payload';
import {redirect} from 'next/navigation';
import {hasOperatorPermission,operatorBusinessAuthorization} from '../lib/access';
import {operationsRead} from '../lib/operations.mjs';
import {aiWorkBase,aiWorkHref,aiWorkLocation,aiWorkRoute} from '../lib/ai-work-accounts-view-model';
import type {AiWorkDetail,AiWorkHistory,AiWorkPage} from './ai-work-accounts-types';
import {AiWorkAccounts} from './AiWorkAccounts';
import {OperationsPage,operationsPageContext} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

function readFailure(value:unknown,fallback:string){
 const error=value as {code?:string;status?:number}|null;
 return {status:error?.status??503,message:error?.code==='operations_ai_work_not_initialized'?'AI工作账户尚待初始化。':fallback};
}

export async function AiWorkAccountsView(props:AdminViewServerProps){
 const {session,requestHeaders,searchParams}=await operationsPageContext(props,aiWorkRoute);
 if(!hasOperatorPermission(session.operator,'ai.accounts.read'))
  return <OperationsPage page={props} variant="accounts"><OperationsPermissionNotice permission="ai.accounts.read"/></OperationsPage>;
 const initialLocation=aiWorkLocation(Object.fromEntries(Object.entries(searchParams).filter((entry):entry is [string,string]=>typeof entry[1]==='string')));
 let initialPage:AiWorkPage|null=null,initialDetail:AiWorkDetail|null=null,initialHistory:AiWorkHistory|null=null;
 let initialError='',initialDetailError='',initialHistoryError='',loginRequired=false,denied=false;
 const failure=(error:unknown,fallback:string)=>{const value=readFailure(error,fallback);loginRequired ||= value.status===401;denied ||= value.status===403;return value.message;};
 await Promise.all([
  operationsRead(requestHeaders,aiWorkBase).then((value:AiWorkPage)=>{initialPage=value;}).catch(error=>{initialError=failure(error,'AI工作账户暂时无法读取。');}),
  operationsRead(requestHeaders,aiWorkBase+'/'+initialLocation.domain).then((value:AiWorkDetail)=>{initialDetail=value;}).catch(error=>{initialDetailError=failure(error,'当前岗位暂时无法读取。');}),
  initialLocation.tab==='history'&&initialLocation.after
   ?operationsRead(requestHeaders,aiWorkBase+'/'+initialLocation.domain+'/history?'+new URLSearchParams({after:initialLocation.after,limit:'30'}))
    .then((value:AiWorkHistory)=>{initialHistory=value;}).catch(error=>{initialHistoryError=failure(error,'变更记录暂时无法读取。');})
   :Promise.resolve(),
 ]);
 if(loginRequired)redirect('/admin/login?redirect='+encodeURIComponent(aiWorkHref(initialLocation)));
 if(denied)return <OperationsPage page={props} variant="accounts"><OperationsPermissionNotice permission="ai.accounts.read"/></OperationsPage>;
 return <OperationsPage page={props} variant="accounts"><AiWorkAccounts key={session.operator.id}
  operatorId={session.operator.id} csrfToken={session.csrfToken} businessAuthorization={operatorBusinessAuthorization(session.operator)??null}
  initialLocation={initialLocation} initialPage={initialPage} initialDetail={initialDetail} initialHistory={initialHistory}
  initialError={initialError} initialDetailError={initialDetailError} initialHistoryError={initialHistoryError}/></OperationsPage>;
}
