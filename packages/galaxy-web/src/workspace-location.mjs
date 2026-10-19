import navigation from '../../../apps/galaxy-site/workspace-navigation.json' with {type: 'json'};

export const primaryNavigation = navigation.primary;

const sections = new Map([
  ['/app', '发现'], ['/app/find', '内容搜索'], ['/app/match', '寻找同行'],
  ['/app/search', '找帮助'], ['/app/work', '我的工作'],
  ['/app/participate', '求助与工作'], ['/app/publish', '求助与工作'],
  ['/app/projects', '项目'], ['/app/capsules', '方法与经验'],
  ['/app/configurations', '工具配置'], ['/app/qualification-permissions', '材料许可'],
  ['/app/builders', '建设者与接入'], ['/app/worker-packs', '工具与使用'],
  ['/app/hubs', 'Hub 社区'], ['/app/information', '资料与关注'],
  ['/app/reviews', '内容复核'], ['/app/governance', '举报与处理'],
  ['/app/history', '账户'], ['/app/bookmarks', '账户'],
]);

/** The shell identifies the current section; the content names the actual page. */
export function workspaceLocation(path) {
  const pathname = path.replace(/\/$/, '');
  const publicPage = navigation.publicPages.find(page => pathname === page.href.replace(/\/$/, '')
    || pathname.startsWith(page.href));
  if (publicPage) return publicPage.location;
  if (pathname === '/404') return '页面';
  if (pathname === '/app/account' || /^\/app\/settings(?:\/|$)/.test(pathname)) return '账户';
  if (/^\/app\/community(?:\/|$)/.test(pathname)) return '社区';
  if (/^\/app\/rooms(?:\/|$)/.test(pathname) || pathname === '/app/notifications') return '消息';
  if (pathname.startsWith('/app/people/')) return '个人主页';
  if (pathname.startsWith('/app/tasks/')) return '求助与工作';
  if (pathname.startsWith('/app/worker-pack-uses/')) return '工具与使用';
  const exact = sections.get(pathname);
  if (exact) return exact;
  const section = [...sections].find(([route]) => route !== '/app' && pathname.startsWith(route + '/'));
  return section?.[1] ?? '工作区';
}
