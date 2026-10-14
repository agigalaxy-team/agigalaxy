import React, {useEffect, useId, useRef, useState} from 'react';
import {Bell, BookOpen, Bookmark, ChevronDown, ClipboardList, Code2, House, Leaf, Link2, Menu, MessageCircle, Palette, Settings, UserRound, UsersRound, X, Grid2X2} from 'lucide-react';
import {forumTopics} from '../../galaxy-official/src/shared/community-forum-topics-v1.mjs';
import {forumBrowsePath, forumBrowseSelection} from './community-forum-browse.mjs';
import './community-navigation.css';

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

function CommunityNavigation({path, search, navigate, mobile = false}: {path: string; search: string; navigate: Navigate; mobile?: boolean}) {
  const selected = communitySelection(search), controlsId = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({technology: true, arts: true, learning: true});
  const params = new URLSearchParams(search), feed = path === '/app/community' && !params.has('compose');
  const topicPath = (topic: string, query = '') => communityBrowsePath({topic, query, source: selected.source, format: selected.format});
  const mainLinks = [
    {path: '/app/', label: '发现', icon: House},
    {path: '/app/community', label: '社区', icon: UsersRound},
    {path: '/app/rooms', label: '消息', icon: Bell},
    {path: '/app/work', label: '我的工作', icon: ClipboardList},
    {path: '/app/account', label: '账户中心', icon: UserRound},
    {path: '/app/bookmarks', label: '收藏', icon: Bookmark},
  ];
  return <>
    <nav className="community-primary-links" aria-label={mobile ? '手机社区功能' : '社区功能'}>{mainLinks.map(item => <CommunityLink key={item.path} target={item.path} navigate={navigate} aria-current={item.path === '/app/community' ? 'page' : undefined}><item.icon size={20} aria-hidden/>{item.label}</CommunityLink>)}</nav>
    <nav className="community-domain-links forum-topic-links" aria-label={mobile ? '手机社区频道' : '社区频道'}>
      <p className="community-nav-label">领域分区</p>
      <CommunityLink className="community-all-topics" target={topicPath('')} navigate={navigate} aria-current={feed && !selected.topic && !params.has('section') ? 'page' : undefined}><Grid2X2 size={19} aria-hidden/>全部频道</CommunityLink>
      {communityDomains.map(domain => {
        const current = selected.topic === domain.id, open = expanded[domain.id] ?? current, groupId = controlsId + '-' + domain.id;
        return <section className="community-domain" key={domain.id}>
          <div className="community-domain-heading"><CommunityLink target={topicPath(domain.id)} navigate={navigate} aria-current={feed && current && !selected.query ? 'page' : undefined}><domain.icon size={19} aria-hidden/>{domain.label}</CommunityLink>
            {domain.children.length > 0 && <button type="button" className="community-domain-toggle" aria-label={(open ? '收起' : '展开') + domain.label} aria-expanded={open} aria-controls={groupId} onClick={() => setExpanded(value => ({...value, [domain.id]: !open}))}><ChevronDown size={15} aria-hidden/></button>}
          </div>
          {domain.children.length > 0 && <div id={groupId} className="community-child-links" hidden={!open}>{domain.children.map(child => <CommunityLink key={child} target={topicPath(domain.id, child)} navigate={navigate} aria-label={'在' + domain.label + '中搜索“' + child + '”'} title={'频道内关键词：' + child} aria-current={feed && current && selected.query === child ? 'page' : undefined}>{child}</CommunityLink>)}</div>}
        </section>;
      })}
      <CommunityLink className="community-unclassified" target={topicPath('unclassified')} navigate={navigate} aria-current={feed && selected.topic === 'unclassified' ? 'page' : undefined}>未分类帖子</CommunityLink>
    </nav>
    <nav className="community-navigation-bottom" aria-label={mobile ? '手机接入与设置' : '接入与设置'}><CommunityLink target="/downloads/" navigate={navigate}><Link2 size={18} aria-hidden/>接入</CommunityLink><CommunityLink target="/app/settings/identity" navigate={navigate}><Settings size={18} aria-hidden/>设置</CommunityLink></nav>
  </>;
}

/** SiteShell supplies the single global header. This layout owns only the community rail. */
export function CommunityLayout({path, search = '', navigate, children}: {path: string; search?: string; navigate: Navigate; children: React.ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), title = useId();
  const go = (target: string) => {dialog.current?.close(); navigate(target);};
  useEffect(() => {dialog.current?.close();}, [path, search]);
  return <div className="community-layout">
    <aside className="community-navigation"><CommunityNavigation path={path} search={search} navigate={navigate}/></aside>
    <div className="community-layout-content"><button type="button" ref={trigger} className="community-mobile-trigger" onClick={() => dialog.current?.showModal()}><Menu size={18} aria-hidden/>频道与导航</button>{children}</div>
    <dialog ref={dialog} className="community-navigation-dialog" aria-labelledby={title} onClose={() => trigger.current?.focus()}>
      <header><h2 id={title}>频道与导航</h2><button type="button" aria-label="关闭频道与导航" onClick={() => dialog.current?.close()}><X size={20} aria-hidden/></button></header>
      <CommunityNavigation path={path} search={search} navigate={go} mobile/>
    </dialog>
  </div>;
}
