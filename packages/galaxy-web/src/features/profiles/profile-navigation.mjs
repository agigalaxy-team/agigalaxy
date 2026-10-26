const subjectPattern = /^GUID[A-Z0-9]{28}$/;

export function profilePath(subjectId) {
  return typeof subjectId === 'string' && subjectPattern.test(subjectId) ? '/app/people/' + subjectId : null;
}

export function profileSubject(pathname) {
  return /^\/app\/people\/(GUID[A-Z0-9]{28})$/.exec(pathname)?.[1] ?? null;
}
const accountProfile=pathname=>/^\/app\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(pathname)?.[1]??null;
const profileKey=pathname=>profileSubject(pathname)??(accountProfile(pathname)?'account:'+accountProfile(pathname):null);
const knownProfile=value=>subjectPattern.test(value??'')||typeof value==='string'&&/^account:[0-9a-f-]{36}$/i.test(value);

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
  const fromSubject=profileKey(source.pathname),toSubject = profileKey(destination.pathname);
  const viaSettings=source.pathname.startsWith('/app/settings/')&&knownProfile(previous.profileSubject);
  const viaReading=readingObject(source.pathname)&&knownProfile(previous.profileSubject);
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
export function publicAccountReturn(state) {
  return contentPath(state?.profileReturn)??localReadingPath(state?.browseReturn)??contentPath(state?.from)??'/app/community';
}

export function profileReturnLabel(path) {
  const pathname = new URL(path, 'https://galaxy.invalid').pathname;
  if(profileSubject(pathname))return '返回 ID 资料';
  if(accountProfile(pathname))return '返回账户资料';
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
