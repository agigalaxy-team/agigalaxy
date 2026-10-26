import React from 'react';
import {BookOpen, Code2, Leaf, MessageCircle, Palette, Grid2X2} from 'lucide-react';
import {forumTopics} from "../../../../galaxy-official/src/shared/community-forum-topics-v1.mjs";
import {forumBrowsePath, forumBrowseSelection} from './community-forum-browse.mjs';
import './community-navigation.css';
import './selected-community.css';

export type CommunitySource = 'galaxy' | 'external';
export type CommunityFormat = 'all' | 'work' | 'method' | 'article';
type Navigate = (path: string) => void;
type BrowseOptions = {section?: string; topic?: string; query?: string; compose?: boolean; source?: CommunitySource; format?: CommunityFormat};

export const communityDomains = [
  {id: 'technology', label: '技术与工具', icon: Code2, children: ['编程', 'AI与模型', '硬件']},
  {id: 'arts', label: '艺术与创作', icon: Palette, children: ['摄影', '设计', '影像']},
  {id: 'learning', label: '阅读与学习', icon: BookOpen, children: ['文学', '科学', '学习方法']},
  {id: 'life', label: '生活与兴趣', icon: Leaf, children: ['生活记录', '兴趣交流']},
  {id: 'galaxy', label: '银河反馈', icon: MessageCircle, children: []},
] as const;

export function communitySelection(search = '') {
  const params = new URLSearchParams(search);
  const selected = forumBrowseSelection(search, forumTopics.map(topic => topic.id));
  const source: CommunitySource = params.get('source') === 'external' ? 'external' : 'galaxy';
  const requested = params.get('format');
  const format: CommunityFormat = source === 'external' && ['work', 'method', 'article'].includes(requested ?? '') ? requested as CommunityFormat : 'all';
  return {...selected, source, format};
}

export function communityBrowsePath({section = 'all', topic = '', query = '', compose = false, source = 'galaxy', format = 'all'}: BrowseOptions = {}) {
  const route = new URL(forumBrowsePath({section, topic, query, compose}), 'https://galaxy.invalid');
  if (source === 'external' && section === 'all' && !compose) {
    route.searchParams.set('source', 'external');
    if (format !== 'all') route.searchParams.set('format', format);
  }
  return route.pathname + route.search;
}

function CommunityLink({target, navigate, children, ...props}: {target: string; navigate: Navigate; children: React.ReactNode} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href' | 'onClick'>) {
  return <a {...props} href={target} onClick={event => {
    if (target.startsWith('/app/') && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); navigate(target);
    }
  }}>{children}</a>;
}

function CommunityNavigation({path, search, navigate}: {path: string; search: string; navigate: Navigate}) {
  const selected = communitySelection(search);
  const params = new URLSearchParams(search), feed = path === '/app/community' && !params.has('compose');
  const topicPath = (topic: string, query = '') => communityBrowsePath({topic, query, source: selected.source, format: selected.format});
  return <nav className="community-domain-links forum-topic-links" aria-label="社区频道">
    <h2 className="community-rail-title">社区</h2>
    <CommunityLink className="community-all-topics" target={topicPath('')} navigate={navigate} aria-current={feed && !selected.topic && !params.has('section') ? 'page' : undefined}><Grid2X2 size={19} aria-hidden/>全部频道</CommunityLink>
    <CommunityLink className="community-all-topics" target="/app/community?section=sections" navigate={navigate} aria-current={path.includes('/community/sections/')||params.get('section')==='sections'?'page':undefined}>成员版块</CommunityLink>
    <CommunityLink className="community-all-topics" target="/app/community?section=notifications" navigate={navigate} aria-current={params.get('section')==='notifications'?'page':undefined}>回复提醒</CommunityLink>
    <p className="community-nav-label">领域分区</p>
    {communityDomains.map(domain => {
      const current = selected.topic === domain.id;
      return <section className="community-domain" key={domain.id} data-current={current || undefined}>
        <div className="community-domain-heading"><CommunityLink target={topicPath(domain.id)} navigate={navigate} aria-current={feed && current && !selected.query ? 'page' : undefined}><domain.icon size={18} aria-hidden/>{domain.label}</CommunityLink></div>
        {domain.children.length > 0 && <div className="community-child-links">{domain.children.map(child => <CommunityLink key={child} target={topicPath(domain.id, child)} navigate={navigate} aria-label={'在' + domain.label + '中搜索“' + child + '”'} title={'频道内关键词：' + child} aria-current={feed && current && selected.query === child ? 'page' : undefined}>{child}</CommunityLink>)}</div>}
      </section>;
    })}
    <CommunityLink className="community-unclassified" target={topicPath('unclassified')} navigate={navigate} aria-current={feed && selected.topic === 'unclassified' ? 'page' : undefined}>未分类帖子</CommunityLink>
  </nav>;
}

/** Global navigation belongs to SiteShell; these are visible community channels. */
export function CommunityLayout({path, search = '', navigate, children}: {path: string; search?: string; navigate: Navigate; children: React.ReactNode}) {
  const selected=communitySelection(search), currentDomain=communityDomains.find(domain=>domain.id===selected.topic);
  const topicPath=(topic:string,query='')=>communityBrowsePath({topic,query,source:selected.source,format:selected.format});
  return <div className="community-layout">
    <aside className="community-navigation"><CommunityNavigation path={path} search={search} navigate={navigate}/></aside>
    <div className="community-layout-content">
      <nav className="community-mobile-topics" aria-label="社区频道">
        <div className="community-mobile-topic-row"><CommunityLink target={topicPath('')} navigate={navigate} aria-current={!selected.topic&&!new URLSearchParams(search).has('section')?'page':undefined}>全部</CommunityLink><CommunityLink target="/app/community?section=sections" navigate={navigate} aria-current={path.includes('/community/sections/')||new URLSearchParams(search).get('section')==='sections'?'page':undefined}>成员版块</CommunityLink><CommunityLink target="/app/community?section=notifications" navigate={navigate} aria-current={new URLSearchParams(search).get('section')==='notifications'?'page':undefined}>回复提醒</CommunityLink>{communityDomains.map(domain=><CommunityLink key={domain.id} target={topicPath(domain.id)} navigate={navigate} aria-current={selected.topic===domain.id?'page':undefined}>{domain.label}</CommunityLink>)}<CommunityLink target={topicPath('unclassified')} navigate={navigate} aria-current={selected.topic==='unclassified'?'page':undefined}>未分类</CommunityLink></div>
        {!!currentDomain?.children.length&&<div className="community-mobile-child-row">{currentDomain.children.map(child=><CommunityLink key={child} target={topicPath(currentDomain.id,child)} navigate={navigate} aria-current={selected.query===child?'page':undefined}>{child}</CommunityLink>)}</div>}
      </nav>
      {children}
    </div>
  </div>;
}
