import type {AdminViewServerProps} from 'payload';
import {OperationsPage,operationsPageContext,operationsSearch} from './OperationsPage';
import {Community} from './BusinessViewClients';
import {CasesView} from './CasesView';
import {uuidPattern} from './operations-task-types';
import type {PublicContentFilters,PublicContentTab,PublicContentTopic} from "./content-governance/public-content-types";
import {publicContentTopics,publicContentTabs} from "./content-governance/public-content-types";
import {hasAnyOperatorPermission,hasOperatorPermission} from '../lib/access';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
export async function CommunityView(props:AdminViewServerProps){
  if(operationsSearch(props.searchParams,'tab')==='reports')return <CasesView {...props}/>;
  const {session,searchParams}=await operationsPageContext(props,'/admin/operations/community'),text=(key:string)=>operationsSearch(searchParams,key),id=text('id'),after=text('after');
  const tab=text('tab')==='reports'?'reports':text('tab')==='posts'?'posts':'sections';
  const readPermission=tab==='posts'?'content.read':'sections.read';
  if(!hasOperatorPermission(session.operator,readPermission))return <OperationsPage page={props}><OperationsPermissionNotice permission={readPermission}/></OperationsPage>;
  const state=(tab==='reports'?['pending','appealed','resolved','withdrawn']:tab==='sections'?['active','archived']:[]).includes(text('state'))?text('state'):'';
  const category=['technology','arts','learning','life','galaxy','unclassified'].includes(text('category'))?text('category'):'';
  const selectedKind=text('contentKind')==='reply'?'reply':'post';
  const contentTab:PublicContentTab=publicContentTabs.some(item=>item.id===text('view'))?text('view') as PublicContentTab:'content';
  const boolean=(key:string):''|'true'|'false'=>['true','false'].includes(text(key))?text(key) as 'true'|'false':'';
  const contentAfter=/^(post|reply):[0-9a-f-]+$/i.test(after)&&uuidPattern.test(after.slice(after.indexOf(':')+1))?after.toLowerCase():'';
  const filters:PublicContentFilters={query:text('query').trim().slice(0,160),kind:text('kind')==='post'?'post':text('kind')==='reply'?'reply':'',topic:Object.hasOwn(publicContentTopics,text('topic'))?text('topic') as PublicContentTopic:'',visibility:text('visibility')==='visible'?'visible':text('visibility')==='hidden'?'hidden':text('visibility')==='unavailable'?'unavailable':'',pinned:boolean('pinned'),featured:boolean('featured'),days:text('days')==='7'?'7':text('days')==='28'?'28':'all',after:contentAfter};
  return <OperationsPage page={props}><Community key={session.operator.id+':'+tab+(tab==='posts'||tab==='sections'?'':':'+id)} tab={tab} selected={uuidPattern.test(id)?tab==='posts'?id.toLowerCase():id:''} after={uuidPattern.test(after)?after:''} state={state} category={category} publicContent={{selectedKind,contentTab,filters}} csrfToken={session.csrfToken} canManage={hasAnyOperatorPermission(session.operator,tab==='posts'?['content.hide','content.restore','content.curate','content.batch.hide','content.batch.restore','content.tags.manage']:['sections.classify','sections.hide','sections.restore'])}/></OperationsPage>;
}
