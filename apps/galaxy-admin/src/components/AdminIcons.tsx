import type {ReactNode,SVGProps} from 'react';

export type AdminIconName = 'workspace'|'users'|'user'|'governance'|'content'|'messages'|'analytics'|'strategy'|'permissions'|'settings'|'maintenance'|'search'|'close'|'refresh'|'plus'|'check'|'logout'|'clock'|'logs'|'activity'|'file'|'briefcase'|'sparkles'|'calendar'|'filter'|'info'|'warning'|'history'|'mail'|'identity'|'link'|'edit'|'bookmark'|'comment'|'send'|'down'|'copy';

type Props = Omit<SVGProps<SVGSVGElement>, 'name'> & {name:AdminIconName;size?:number};

/** Decorative symbols; the surrounding label supplies the accessible name. */
export function AdminIcon({name,size=20,className,...props}:Props){
  let drawing:ReactNode;
  switch(name){
    case 'workspace':drawing=<><path d="M4 20h16M6 16V9h3v7M11 16V5h3v11M16 16v-5h3v5"/></>;break;
    case 'users':drawing=<><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-3.5-5.45"/></>;break;
    case 'user':drawing=<><circle cx="12" cy="8" r="3.5"/><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2"/></>;break;
    case 'governance':drawing=<><path d="M5 3h14v13H9l-4 4V3Z"/><path d="M8 8h8M8 12h5"/></>;break;
    case 'content':case 'file':drawing=<><path d="M6 3h8l4 4v14H6V3ZM14 3v5h4M9 12h6M9 16h6"/></>;break;
    case 'messages':drawing=<><path d="M4 4h16v12H9l-5 4V4Z"/><path d="m8 10 2.5 2 5-5"/></>;break;
    case 'analytics':drawing=<><path d="M4 3v17h17M8 16v-3M13 16V8M18 16v-6M8 8l5-4 5 2"/></>;break;
    case 'strategy':case 'settings':drawing=<><path d="m9 3-.8 2.2-2.3.3-1.5 2.6 1.1 2-.9 2.1.9 2.1-1.1 2 1.5 2.6 2.3.3L9 21h6l.8-2.2 2.3-.3 1.5-2.6-1.1-2 .9-2.1-.9-2.1 1.1-2-1.5-2.6-2.3-.3L15 3H9Z"/><circle cx="12" cy="12" r="3"/></>;break;
    case 'permissions':drawing=<><path d="m12 3 8 3v6c0 4.2-3.6 7.4-8 9-4.4-1.6-8-4.8-8-9V6l8-3Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/></>;break;
    case 'maintenance':drawing=<><path d="M14.5 4a5.5 5.5 0 0 0-7 7L3 15.5a3.2 3.2 0 0 0 4.5 4.5l4.5-4.5a5.5 5.5 0 0 0 7-7l-3.5 3.5-4-4L15 4.5Z"/></>;break;
    case 'search':drawing=<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>;break;
    case 'copy':drawing=<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/></>;break;
    case 'send':drawing=<path d="M12 20V4m-6 6 6-6 6 6"/>;break;
    case 'down':drawing=<path d="M12 4v16m-6-6 6 6 6-6"/>;break;
    case 'close':drawing=<path d="m6 6 12 12M18 6 6 18"/>;break;
    case 'refresh':drawing=<><path d="M19.2 7.8a8 8 0 0 0-13.8-.6M4.8 16.2a8 8 0 0 0 13.8.6"/><circle cx="20" cy="11" r=".8"/><circle cx="4" cy="13" r=".8"/></>;break;
    case 'plus':drawing=<path d="M12 5v14M5 12h14"/>;break;
    case 'check':drawing=<path d="m5 12 4.5 4.5L19 7"/>;break;
    case 'logout':drawing=<><path d="M12 3v9M6.3 5.7a8 8 0 1 0 11.4 0"/></>;break;
    case 'clock':case 'history':drawing=<><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>;break;
    case 'logs':drawing=<><path d="M6 3h12v18H6V3ZM9 7h6M9 11h6M9 15h4"/></>;break;
    case 'activity':drawing=<path d="M3 12h4l3-7 4 14 3-7h4"/>;break;
    case 'briefcase':drawing=<><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12a27 27 0 0 0 18 0M10 14h4"/></>;break;
    case 'sparkles':drawing=<><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3ZM20 2v4M18 4h4"/></>;break;
    case 'calendar':drawing=<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 17h3"/></>;break;
    case 'filter':drawing=<><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--admin-surface,#fff)"/><circle cx="16" cy="12" r="2" fill="var(--admin-surface,#fff)"/><circle cx="10" cy="18" r="2" fill="var(--admin-surface,#fff)"/></>;break;
    case 'info':drawing=<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>;break;
    case 'warning':drawing=<><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></>;break;
    case 'mail':drawing=<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>;break;
    case 'bookmark':drawing=<path d="M6 3h12v18l-6-4-6 4V3Z"/>;break;
    case 'comment':drawing=<><path d="M4 4h16v12H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/></>;break;
    case 'identity':drawing=<><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M5 16a3 3 0 0 1 6 0M14 9h4M14 13h4M14 16h3"/></>;break;
    case 'link':drawing=<><path d="m10 8 2-2a5 5 0 0 1 7 7l-2 2M14 16l-2 2a5 5 0 0 1-7-7l2-2M8 16l8-8"/></>;break;
    case 'edit':drawing=<><path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L10 19l-6 1Z"/></>;break;
  }
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={['galaxy-admin-icon',className].filter(Boolean).join(' ')} {...props}>{drawing}</svg>;
}
