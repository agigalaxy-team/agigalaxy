/** The same presentational chrome is rendered by Web, public builds and Keycloak. */
import React from 'react';
import {Bell,BriefcaseBusiness,Compass,Home,MessageCircle,MessagesSquare,Plus,Search,UserRound} from 'lucide-react';
import navigation from '../../../apps/galaxy-site/workspace-navigation.json' with {type:'json'};
const h=React.createElement;
const icons={home:Home,discover:Compass,community:MessagesSquare,messages:MessageCircle,work:BriefcaseBusiness,account:UserRound};
export const siteChromeStyles=['site-foundation.css','selected-shell.css'];
export const primaryNavigation=navigation.primary;
export const websiteHref=(origin,target)=>origin?new URL(target,origin).href:target;
export function GalaxyMark({bare=false,className=''}={}){
 const svg=h('svg',{className:bare?className:undefined,width:31,height:31,viewBox:'0 0 32 32',fill:'none','aria-hidden':bare?true:undefined},
  h('ellipse',{cx:16,cy:16,rx:13,ry:6,transform:'rotate(-36 16 16)',stroke:'currentColor',strokeWidth:1.65}),
  h('ellipse',{cx:16,cy:16,rx:6,ry:13,transform:'rotate(-36 16 16)',stroke:'currentColor',strokeWidth:1.65}),
  h('circle',{cx:16,cy:16,r:3.2,fill:'currentColor'}),
  h('circle',{cx:26,cy:7,r:2.2,fill:'#d8a9be',stroke:'#ffffff',strokeWidth:1.5}));
 return bare?svg:h('span',{className:'galaxy-mark','aria-hidden':true},svg);
}
/** @param {{origin?:string,activeHref?:string,isCurrent?:(href:string)=>boolean,onFollow?:(event:import('react').MouseEvent<HTMLAnchorElement>,href:string)=>void,labels?:Record<string,string>}} props */
export function GlobalRail({origin='',activeHref='',isCurrent,onFollow,labels={}}={}){
 return h('aside',{className:'selected-global-rail','aria-label':labels.globalNavigationLabel??'银河全局导航'},
  h('nav',{className:'selected-rail-primary','aria-label':labels.navigationLabel??'主要功能'},primaryNavigation.map(({href,label,icon})=>
   h('a',{key:href,href:websiteHref(origin,href),'aria-current':(isCurrent?isCurrent(href):href===activeHref)?'page':undefined,onClick:onFollow?event=>onFollow(event,href):undefined},
    h(icons[icon],{size:22,'aria-hidden':true}),h('span',null,labels[icon]??label)))));
}
/** @param {{origin?:string,placeholder?:string,onSubmit?:(event:import('react').SubmitEvent<HTMLFormElement>)=>void,defaultValue?:string,inputKey?:string,labels?:Record<string,string>}} props */
export function ShellSearch({origin='',placeholder,onSubmit,defaultValue='',inputKey='public-search',labels={}}={}){
 return h('search',{className:'selected-header-search'},h('form',{action:websiteHref(origin,'/app/find'),method:'get',onSubmit},
  h(Search,{size:18,'aria-hidden':true}),h('input',{key:inputKey,name:'q',type:'search',maxLength:160,defaultValue,placeholder:placeholder??labels.searchPlaceholder??'搜索公开内容','aria-label':labels.searchLabel??'搜索银河公开内容'})));
}
/** @param {{origin?:string,directoryNode?:import('react').ReactNode,publishTarget?:string,publishLabel?:string,onFollow?:(event:import('react').MouseEvent<HTMLAnchorElement>,href:string)=>void,labels?:Record<string,string>}} props */
export function StandardHeaderActions({origin='',directoryNode,publishTarget='/app/publish',publishLabel,onFollow,labels={}}={}){
 const link=(href,props,...children)=>h('a',{...props,href:websiteHref(origin,href),onClick:onFollow?event=>onFollow(event,href):undefined},...children);
 return h('div',{className:'selected-header-actions'},
  directoryNode===undefined?link('/docs/',{className:'selected-public-help'},labels.directory??'文档'):directoryNode,
  link('/app/notifications',{className:'selected-notifications','aria-label':labels.notifications??'通知'},h(Bell,{size:20,'aria-hidden':true})),
  link(publishTarget,{className:'site-create','aria-label':publishLabel??labels.publish??'发起求助'},h(Plus,{size:17,'aria-hidden':true}),h('span',null,publishLabel??labels.publish??'发起求助')),
  link('/app/account',{className:'selected-account-entry','aria-label':labels.accountLabel??'账户中心'},h(UserRound,{size:20,'aria-hidden':true}),h('span',null,labels.account??'账户')));
}
/** @param {{location?:string,origin?:string,searchNode?:import('react').ReactNode,actionsNode?:import('react').ReactNode,labels?:Record<string,string>}} props */
export function SiteHeader({location='账户',origin='',searchNode,actionsNode,labels={}}={}){
 return h('header',{className:'site-app-header selected-app-header'},h('div',{className:'site-header-inner'},
  h('a',{href:websiteHref(origin,'/'),className:'selected-header-brand','aria-label':labels.home??'银河首页'},h(GalaxyMark)),
  h('p',{className:'selected-context-title','aria-label':(labels.locationLabel??'当前位置：银河 · ')+location},h('span',null,'银河'),h('span',{className:'selected-context-divider','aria-hidden':true},'·'),h('span',null,location)),
  searchNode===undefined?h(ShellSearch,{origin,labels}):searchNode,
  actionsNode===undefined?h(StandardHeaderActions,{origin,labels}):actionsNode));
}

