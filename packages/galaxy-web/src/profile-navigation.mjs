const subjectPattern = /^GUID[A-Z0-9]{28}$/;

export function profilePath(subjectId) {
  return typeof subjectId === 'string' && subjectPattern.test(subjectId) ? '/app/people/' + subjectId : null;
}

export function profileSubject(pathname) {
  return /^\/app\/people\/(GUID[A-Z0-9]{28})$/.exec(pathname)?.[1] ?? null;
}

function localReadingPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/app/') || value.startsWith('//')) return null;
  const url = new URL(value, 'https://galaxy.invalid');
  if (url.origin !== 'https://galaxy.invalid' || !url.pathname.startsWith('/app/') || /^\/app\/settings(?:\/|$)/.test(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}
function contentPath(value) {
  const path=localReadingPath(value);
  return path&&!profileSubject(new URL(path,'https://galaxy.invalid').pathname)?path:null;
}

const readingObject = pathname => /^\/app\/(projects|capsules|tasks|community|rooms)\/[^/]+/.test(pathname);

// Keep the original reading context through a person's details and selected
// works. Nothing in this state grants access to their records.
export function profileNavigationState(from, target, previous = {}) {
  const source = new URL(from, 'https://galaxy.invalid');
  const destination = new URL(target, 'https://galaxy.invalid');
  const fromSubject=profileSubject(source.pathname),toSubject = profileSubject(destination.pathname);
  const viaSettings=source.pathname.startsWith('/app/settings/')&&subjectPattern.test(previous.profileSubject??'');
  const viaReading=readingObject(source.pathname)&&subjectPattern.test(previous.profileSubject??'');
  if(!toSubject){
    const origin=contentPath(previous.profileReturn);
    if(!(destination.pathname.startsWith('/app/settings/')||readingObject(destination.pathname)&&contentPath(target))||!fromSubject&&!viaSettings&&!viaReading)return {};
    const parent=localReadingPath(previous.profileBrowseReturn);
    return {profileSubject:fromSubject??previous.profileSubject,...(origin?{profileReturn:origin}:{}),...(parent?{profileBrowseReturn:parent}:{})};
  }
  const continued = fromSubject===previous.profileSubject||(viaSettings||viaReading)&&previous.profileSubject===toSubject;
  const origin = contentPath(continued ? previous.profileReturn : from);
  const parent=localReadingPath(continued?previous.profileBrowseReturn:previous.browseReturn);
  return {profileSubject: toSubject, ...(origin ? {profileReturn: origin} : {}),...(origin&&parent?{profileBrowseReturn:parent}:{})};
}

// Explicitly returning to the original content finishes the profile detour.
// Selecting that same work from a portfolio still uses normal navigation.
export function profileReturnNavigationState(previous = {}) {
  const parent=localReadingPath(previous.profileBrowseReturn);
  return parent?{browseReturn:parent}:{};
}

export function profileReturn(state) {
  return contentPath(state?.profileReturn) ?? '/app/';
}

export function profileReturnLabel(path) {
  const pathname = new URL(path, 'https://galaxy.invalid').pathname;
  if (pathname.startsWith('/app/community/')) return '返回原讨论';
  if (pathname.startsWith('/app/rooms/')) return '返回原对话';
  if (pathname.startsWith('/app/projects/')) return '返回原项目';
  if (pathname.startsWith('/app/tasks/')) return '返回原工作';
  if (pathname.startsWith('/app/capsules/')) return '返回原方法';
  return ({'/app/community':'返回社区','/app/bookmarks':'返回我的收藏','/app/match':'返回查找结果','/app/search':'返回查找结果','/app/find':'返回查找结果','/app/account':'返回我的银河','/app/history':'返回经历','/app/rooms':'返回消息'})[pathname] ?? '返回发现';
}

/** @param {string} subjectId @param {string|null} [recordKey] */
export function profileExperiencePath(subjectId,recordKey=null) {
  const path=profilePath(subjectId);
  if(!path)return null;
  const params=new URLSearchParams({section:'experience'});
  if(typeof recordKey==='string'&&/^(case|task):[0-9a-f-]{36}$/.test(recordKey))params.set('record',recordKey);
  return path+'?'+params;
}
