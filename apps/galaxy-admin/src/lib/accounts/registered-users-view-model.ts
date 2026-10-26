import type {RegisteredCommandKind,RegisteredCommandReceipt,RegisteredUser,RegisteredUserDetail,RegisteredUsersLocation,RegisteredUsersPage} from "../../components/accounts/registered-users-types";

const route='/admin/operations/users';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type LocationInput=Partial<Record<keyof RegisteredUsersLocation,string|number>>;
const text=(value:unknown)=>typeof value==='string'?value:'';
const oneOf=<T extends string>(value:unknown,values:readonly T[],fallback:T):T=>values.includes(value as T)?value as T:fallback;
function iso(value:unknown){const raw=text(value);return raw&&Number.isFinite(Date.parse(raw))&&/[Tt]/.test(raw)?new Date(raw).toISOString():'';}

export function registeredUsersLocation(input:LocationInput={}):RegisteredUsersLocation{
  const page=Number(input.page);
  return {page:Number.isSafeInteger(page)&&page>=1&&page<=1_000_000?page:1,pageSize:oneOf(String(input.pageSize),['20','50','100'] as const,'20')==='50'?50:String(input.pageSize)==='100'?100:20,
    query:text(input.query).trim().slice(0,320),source:oneOf(input.source,['all','registered','business-only'] as const,'all'),business:oneOf(input.business,['','formed','not-formed'] as const,''),subjectType:oneOf(input.subjectType,['','person','organization','agent','unknown'] as const,''),login:oneOf(input.login,['','enabled','disabled'] as const,''),emailVerified:oneOf(input.emailVerified,['','yes','no'] as const,''),participation:oneOf(input.participation,['','restricted','unrestricted'] as const,''),registeredFrom:iso(input.registeredFrom),registeredTo:iso(input.registeredTo),sort:oneOf(input.sort,['registered-desc','registered-asc'] as const,'registered-desc'),registration:uuid.test(text(input.registration))?text(input.registration).toLowerCase():'',view:input.view==='detail'?'detail':'directory',tab:oneOf(input.tab,['overview','profile','security','restrictions','history'] as const,'overview'),days:String(input.days)==='28'?28:7,historyAfter:/^[1-9][0-9]{0,18}$/.test(text(input.historyAfter))?text(input.historyAfter):'',linksAfter:text(input.linksAfter).slice(0,160),typeHistoryAfter:/^[1-9][0-9]{0,18}$/.test(text(input.typeHistoryAfter))?text(input.typeHistoryAfter):'',auditAfter:/^[1-9][0-9]{0,18}$/.test(text(input.auditAfter))?text(input.auditAfter):''};
}
export function registeredUsersQuery(location:RegisteredUsersLocation){
  const query=new URLSearchParams({page:String(location.page),pageSize:String(location.pageSize),source:location.source,sort:location.sort});
  for(const key of ['query','business','subjectType','login','emailVerified','participation','registeredFrom','registeredTo'] as const)if(location[key])query.set(key,location[key]);
  return query;
}
export function registeredUsersHref(location:RegisteredUsersLocation,patch:Partial<RegisteredUsersLocation>&{account?:string|null}={}){
  const next=registeredUsersLocation({...location,...patch}),params=registeredUsersQuery(next);
  if(next.registration)params.set('registration',next.registration);
  if(next.view==='detail')params.set('view','detail');
  if(next.tab!=='overview')params.set('tab',next.tab);
  if(next.days!==7)params.set('days',String(next.days));
  for(const key of ['historyAfter','linksAfter','typeHistoryAfter','auditAfter'] as const)if(next[key])params.set(key,next[key]);
  if(patch.account&&uuid.test(patch.account))params.set('account',patch.account.toLowerCase());
  return route+'?'+params;
}
export function registeredUserName(item:RegisteredUser){return item.business?.displayName?.trim()||(item.registrationProfile?.state==='preset'?item.registrationProfile.displayName.trim():'')||item.identity.displayName?.trim()||(item.identity.presence==='present'?'未提供姓名':'姓名未取得');}
export function registeredUserType(item:RegisteredUser){const type=item.business?.subjectType;return type==='person'?'个人':type==='organization'?'组织':type==='agent'?'Agent':'未设置';}
export function registeredLoginLabel(item:RegisteredUser){return item.identity.presence==='outside-configured-issuer'?'不在当前登录来源':item.identity.presence==='not-found'?'登录身份未找到':item.identity.presence==='not-configured'?'登录来源未配置':item.identity.presence==='unavailable'?'登录状态暂不可用':item.identity.enabled===true?'登录已启用':item.identity.enabled===false?'登录已停用':'登录状态未取得';}
export function registeredParticipationLabel(item:RegisteredUser){return !item.business?'尚无业务资料':item.business.restriction.active?'参与受限':'未限制参与';}
export function registeredEmailLabel(item:RegisteredUser){return item.identity.readState==='not-authorized'?'无权查看邮箱':item.identity.email||(item.identity.presence==='present'?'未提供邮箱':'邮箱未取得');}
export function registeredSourceMessage(value:RegisteredUsersPage|null){
  if(!value)return '尚未取得注册目录。';
  if(value.source.state==='syncing')return value.source.coverage==='complete-generation'?'正在更新注册目录，当前显示上次完整取得的目录。':'正在更新注册目录，完成后显示完整列表和匹配总数。';
  if(value.source.state==='not-configured')return '注册身份来源尚未配置。';
  if(value.source.state==='unavailable')return '注册身份来源暂时无法读取。';
  return '';
}
export function registeredDate(value:string|null|undefined){
  if(!value||!Number.isFinite(Date.parse(value)))return '未记录';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
export function registeredDateInput(value:string){
  if(!value||!Number.isFinite(Date.parse(value)))return '';
  const date=new Date(value),shifted=new Date(date.getTime()+8*3600000);
  return shifted.toISOString().slice(0,16);
}
export function registeredDateFromInput(value:string){const parsed=Date.parse(value+':00+08:00');return value&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)&&Number.isFinite(parsed)?new Date(parsed).toISOString():'';}
export const registeredCommandLabels:Record<RegisteredCommandKind,string>={'password-reset':'发送密码重置链接','login-disable':'停用登录','login-restore':'恢复登录','sessions-revoke':'撤销登录会话','profile-correct':'更正官网资料','profile-preset':'预置网站资料'};
export const registeredCommandImpacts:Record<RegisteredCommandKind,string>={'password-reset':'发送到该账户已验证的邮箱；用户通过链接自行设置密码，本次不会直接更改密码。','login-disable':'停止后续登录，并撤销认证与官网现有会话；社区参与限制保持原状。','login-restore':'解除登录停用；原有验证步骤仍需由本人完成，不会恢复旧会话或解除社区参与限制。','sessions-revoke':'结束认证与官网现有会话；本人仍可按当前登录条件重新登录。','profile-correct':'更正官网显示名、头像或简介，并记录说明与依据；不改变登录身份、邮箱、UID或公开范围。','profile-preset':'为这位注册用户准备昵称、头像和简介，首次正常登录官网后采用。预置资料不代表已登录，也不会更改登录权限或公开设置。'};
export function registeredCanCommand(detail:RegisteredUserDetail|null,kind:RegisteredCommandKind){
  const caps=detail?.capabilities;return Object.hasOwn(registeredCommandLabels,kind)&&!!caps&&(kind==='password-reset'?caps.canResetPassword:kind==='login-disable'?caps.canDisableLogin:kind==='login-restore'?caps.canRestoreLogin:kind==='sessions-revoke'?caps.canRevokeSessions:kind==='profile-preset'?!!caps.canPresetProfile:caps.canCorrectProfile);
}
export function registeredReceiptMatches(value:RegisteredCommandReceipt,operationId:string,registrationId:string,kind:RegisteredCommandKind){return Object.hasOwn(registeredCommandLabels,kind)&&uuid.test(operationId)&&value.operationId===operationId&&value.registrationId===registrationId&&value.kind===kind&&['accepted','submitted','completed','partial','failed','unknown'].includes(value.state);}
export function registeredReceiptLabel(value:RegisteredCommandReceipt){
  if(value.state==='submitted')return value.kind==='password-reset'?'密码重置链接发送请求已接收，邮件送达尚未确认。':'请求已提交，完成情况尚未确认。';
  if(value.state==='completed')return value.kind==='password-reset'?'密码重置链接请求已办理，用户密码尚未更改。':value.kind&&Object.hasOwn(registeredCommandLabels,value.kind)?registeredCommandLabels[value.kind]+'已完成。':'操作已完成。';
  if(value.state==='partial')return '部分处理已完成，其余结果见下方。';
  if(value.state==='failed')return '本次处理未完成，请查看各项结果。';
  return '正在读取这次处理的结果…';
}

export function registeredUserUid(item:RegisteredUser){return item.business?.uid??item.registrationProfile?.uid??null;}
export function registeredProfileDraftFields(current:RegisteredUserDetail){return{displayName:current.item.business?.displayName??current.item.registrationProfile?.displayName??'',avatarKey:current.websiteProfile?.avatarKey??null,bio:current.websiteProfile?.state==='available'?current.websiteProfile.bio??'':'',revision:current.item.business?.profileRevision??current.item.registrationProfile?.revision??0};}
