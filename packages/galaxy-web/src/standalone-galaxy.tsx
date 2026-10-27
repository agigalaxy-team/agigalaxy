import React,{useMemo,useSyncExternalStore} from "react";
import {GalaxySessionProvider} from "./application/galaxy-session";
import {GalaxyWorkspace} from "./application/galaxy-shell";
import {GalaxyRouteContent,type GalaxyPage} from "./application/galaxy-pages";
import {PublicReadingWorkspace,isPublicReadingRoute} from "./features/public-reading/workspace";
import "@/app/globals.css";
import "./features/tasks/task-help-continuation.css";
import "./workspace.css";
import "./porcelain-theme.css";
import "./full-width-layout.css";
const routes:Record<string,GalaxyPage>={"":"start",community:"community",bookmarks:"bookmarks",feedback:"feedback",account:"account",accounts:"public-account",work:"work",tasks:"task",match:"match",find:"find",search:"search","qualification-permissions":"qualification-permissions",capsules:"capsules",participate:"participate",publish:"publish",rooms:"rooms",notifications:"notifications",projects:"projects",configurations:"configurations",builders:"builders","worker-packs":"worker-packs","worker-pack-uses":"worker-packs",hubs:"hubs",information:"information",reviews:"reviews",governance:"governance",history:"history",people:"person"};
const subscribe=(listener:()=>void)=>{addEventListener('popstate',listener);addEventListener('galaxy:route-view-changed',listener);return()=>{removeEventListener('popstate',listener);removeEventListener('galaxy:route-view-changed',listener);};};
const snapshot=()=>location.pathname+location.search+location.hash;
export function StandaloneGalaxy(){
 const route=useSyncExternalStore(subscribe,snapshot,snapshot),url=new URL(route,location.origin);
 const navigation=useMemo(()=>({pathname:url.pathname,search:url.search,push:(target:string)=>{history.pushState(history.state,'',target);dispatchEvent(new PopStateEvent('popstate'));},replace:(target:string)=>{history.replaceState(history.state,'',target);dispatchEvent(new PopStateEvent('popstate'));}}),[url.pathname,url.search]);
 const segments=url.pathname.replace(/^\/app\/?/,'').split('/');
 const page=segments[0]==='settings'?({'trust-package':'trust-package',identity:'identity',privacy:'privacy',summaries:'rooms'} as Record<string,GalaxyPage>)[segments[1]]:segments[0]==='projects'&&segments[1]?'project':routes[segments[0]];
 return <GalaxySessionProvider navigation={navigation}><GalaxyWorkspace>{isPublicReadingRoute(url.pathname)?<PublicReadingWorkspace path={url.pathname} search={url.search} hash={url.hash} navigate={navigation.push}/>:page?<GalaxyRouteContent page={page}/>:<section><h1>找不到这个页面</h1><a href="/app/">回到发现</a></section>}</GalaxyWorkspace></GalaxySessionProvider>;
}
