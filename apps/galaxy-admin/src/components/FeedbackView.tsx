import type {AdminViewServerProps} from 'payload';
import {Feedback} from './BusinessViewClients';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {uuidPattern} from './operations-task-types';
import {feedbackModules,feedbackStates} from "./feedback/feedback-types";
import type {FeedbackCategoryFilter,FeedbackDays,FeedbackModule,FeedbackState} from "./feedback/feedback-types";
import {hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';

export async function FeedbackView(props:AdminViewServerProps){
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/feedback');
  if(!hasOperatorPermission(session.operator,'feedback.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="feedback.read"/></OperationsPage>;
  const text=(key:string)=>operationsSearch(searchParams,key),selected=text('id'),after=text('after');
  const category:FeedbackCategoryFilter=['unclassified','problem','suggestion'].includes(text('category'))?text('category') as FeedbackCategoryFilter:'';
  const state=feedbackStates.includes(text('state') as FeedbackState)?text('state') as FeedbackState:'';
  const module=feedbackModules.includes(text('module') as FeedbackModule)?text('module') as FeedbackModule:'';
  const days:FeedbackDays=['7','28','all'].includes(text('days'))?text('days') as FeedbackDays:'7';
  const query=Array.from(text('query').trim()).slice(0,160).join('');
  const cursor=/^[1-9][0-9]{0,18}$/.test(after)&&BigInt(after)<=9223372036854775807n?after:'';
  return <OperationsPage page={props}><Feedback key={session.operator.id} selected={uuidPattern.test(selected)?selected:''} after={cursor} query={query} category={category} state={state} module={module} days={days} csrfToken={session.csrfToken} canManage={hasOperatorPermission(session.operator,'feedback.update')}/></OperationsPage>;
}
