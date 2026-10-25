import {profileSubject} from "../../profile-navigation.mjs";

export function browseReturnPath(fallback:string){
 const value=history.state?.browseReturn;if(typeof value!=='string')return fallback;
  try{const url=new URL(value,location.origin);return url.origin===location.origin&&(['/app/','/app/work','/app/find','/app/search','/app/match','/app/history','/app/participate','/app/capsules','/app/projects','/app/community','/app/rooms','/app/notifications','/app/information','/app/bookmarks'].includes(url.pathname)||!!profileSubject(url.pathname))?url.pathname+url.search+url.hash:fallback;}catch{return fallback;}
}
export function browseReturnLabel(fallback:string){const url=new URL(browseReturnPath(fallback),location.origin),path=url.pathname;if(profileSubject(path))return url.searchParams.get('section')==='experience'?'人物完整经历':'人物资料';if(path==='/app/participate'&&url.searchParams.get('view')==='requested')return '我发布的求助';if(path==='/app/participate'&&url.searchParams.get('view')==='participating')return '我参与的工作';return ({'/app/':'发现','/app/work':'我的工作','/app/find':'查找结果','/app/search':'方法与工具','/app/match':'寻找同行','/app/history':'经历与贡献','/app/participate':'求助目录','/app/capsules':'方法目录','/app/projects':'项目目录','/app/community':'社区','/app/rooms':'对话列表','/app/notifications':'通知','/app/information':'资料与关注','/app/bookmarks':'我的收藏'} as Record<string,string>)[path]??'上一页';}
