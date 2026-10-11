const subjectPattern = /^GUID[A-Z0-9]{28}$/;

export function profilePath(subjectId) {
  return typeof subjectId === 'string' && subjectPattern.test(subjectId) ? '/app/people/' + subjectId : null;
}

export function profileSubject(pathname) {
  return /^\/app\/people\/(GUID[A-Z0-9]{28})$/.exec(pathname)?.[1] ?? null;
}

function contentPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/app/') || value.startsWith('//')) return null;
  const url = new URL(value, 'https://galaxy.invalid');
  if (url.origin !== 'https://galaxy.invalid' || !url.pathname.startsWith('/app/') || /^\/app\/settings(?:\/|$)/.test(url.pathname) || profileSubject(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}

// Keep the original reading context while moving between a person's overview
// and their experience. Nothing in this state grants access to their records.
export function profileNavigationState(from, target, previous = {}) {
  const source = new URL(from, 'https://galaxy.invalid');
  const destination = new URL(target, 'https://galaxy.invalid');
  const fromSubject=profileSubject(source.pathname),toSubject = profileSubject(destination.pathname);
  const viaSettings=source.pathname.startsWith('/app/settings/')&&subjectPattern.test(previous.profileSubject??'');
  if(!toSubject){
    if(!destination.pathname.startsWith('/app/settings/')||!fromSubject&&!viaSettings)return {};
    const origin=contentPath(previous.profileReturn);
    return {profileSubject:fromSubject??previous.profileSubject,...(origin?{profileReturn:origin}:{})};
  }
  const continued = fromSubject===previous.profileSubject||viaSettings&&previous.profileSubject===toSubject;
  const origin = contentPath(continued ? previous.profileReturn : from);
  return {profileSubject: toSubject, ...(origin ? {profileReturn: origin} : {})};
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
  return ({'/app/community':'返回社区','/app/match':'返回查找结果','/app/search':'返回查找结果','/app/account':'返回我的银河','/app/history':'返回经历','/app/rooms':'返回消息'})[pathname] ?? '返回发现';
}

/** @param {string} subjectId @param {string|null} [recordKey] */
export function profileExperiencePath(subjectId,recordKey=null) {
  const path=profilePath(subjectId);
  if(!path)return null;
  const params=new URLSearchParams({section:'experience'});
  if(typeof recordKey==='string'&&/^(case|task):[0-9a-f-]{36}$/.test(recordKey))params.set('record',recordKey);
  return path+'?'+params;
}
