import {forumTopics,forumUnclassifiedTopic} from '../../../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
const topicLabel=id=>[...forumTopics,forumUnclassifiedTopic].find(topic=>topic.id===id)?.label;
const unavailable={withdrawn:'作者已撤回这份内容。',expired:'这份内容的公开期限已结束。',unavailable:'这份内容目前不可读。'};
const excerpt=value=>typeof value==='string'?value.replace(/\s+/gu,' ').trim().slice(0,240):'';
const date=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?new Date(value*1000).toLocaleString('zh-CN'):null;

// The structured result retains exact source/permission references. Ordinary
// reading presents one post at a time, rather than flattening several payloads
// and management records into a single transport transcript.
export function communityResultLines(name,data){
 if(!name.startsWith('galaxy_community_'))return null;
 if(name==='galaxy_community_topics')return ['选择一个主题浏览',...data.items.map(item=>item.label+'：'+item.description),'已有未分类的帖子也可以单独浏览。'];
 if(data?.availability&&data.availability!=='available')return[unavailable[data.availability]??unavailable.unavailable];
 if(name==='galaxy_community_read'){
  const payload=data?.payload;
  if(!payload)return[unavailable.unavailable];
  const lines=[payload.title,payload.body];
  if(topicLabel(data.topic))lines.push('主题：'+topicLabel(data.topic));
  if(date(data.createdAt))lines.push('发表：'+date(data.createdAt));
  if(date(data.versionCreatedAt)&&data.versionCreatedAt!==data.createdAt)lines.push('本版发表：'+date(data.versionCreatedAt));
  if(payload.links?.length)lines.push('相关资料：\n'+payload.links.join('\n'));
  return lines.filter(Boolean);
 }
 if(!Array.isArray(data?.items))return null;
 const lines=[name==='galaxy_community_owned'?'我发表的帖子':name==='galaxy_community_replies'?'这篇帖子中的回复':name==='galaxy_community_versions'?'这篇帖子的版本':'社区帖子'];
 for(const item of data.items){
  if(item.availability&&item.availability!=='available'){lines.push(unavailable[item.availability]??unavailable.unavailable);continue;}
  const payload=item.payload;
  if(name==='galaxy_community_versions'){lines.push('第 '+item.locator.versionNumber+' 版'+(item.availability==='available'?' · 当前可读':''));continue;}
  const title=payload?.title??(name==='galaxy_community_replies'?'回复':'帖子内容目前不可读');
  lines.push([title,topicLabel(item.topic),date(item.createdAt),excerpt(payload?.body)].filter(Boolean).join('\n'));
 }
 if(!data.items.length)lines.push(data.nextCursor||data.nextAfter?'这部分范围暂未找到可读内容，可以继续读取。':'当前范围没有可读内容。');
 else if(data.nextCursor||data.nextAfter)lines.push('还有内容可继续浏览。');
 return lines;
}

export function bookmarkResultLines(name,data){
 if(!name.startsWith('galaxy_bookmark'))return null;
 if(data.bookmark||typeof data.saved==='boolean'){
  const bookmark=data.bookmark??data;
  return [bookmark.saved?'已收藏，可在“我的收藏”继续阅读。':'当前未收藏。',
   ...(data.state==='changed'?['收藏状态已在其他操作中变化，这里已显示当前结果。']:[])];
 }
 if(name==='galaxy_bookmarks'&&Array.isArray(data.items)){
  const kinds={'forum-post':'帖子',capsule:'方法',project:'项目',person:'人物'};
  const lines=['我的收藏'];
  for(const item of data.items){
   const source=item.source;
   lines.push(source?.state==='available'?[source.title,kinds[item.reference.kind],source.summary].filter(Boolean).join('\n'):
    kinds[item.reference.kind]+' · '+(source?.state==='temporarily-unavailable'?'暂时无法读取，可稍后重试。':'内容目前不可读，仍可以取消收藏。'));
  }
  if(!data.items.length)lines.push('当前没有收藏内容。');
  if(data.nextAfter)lines.push('还有收藏可以继续查看。');
  return lines;
 }
 return null;
}
