import type {AdminViewServerProps} from 'payload';
import {redirect} from 'next/navigation';
import {hasOperatorPermission} from '../lib/access';
import {operationsRead} from '../lib/operations.mjs';
import {readGeneralSettings} from "../lib/system-settings/system-settings-general.mjs";
import {systemSettingsBase,systemSettingsHref,systemSettingsLocation,systemSettingsReadLease,systemSettingsRoute} from "../lib/system-settings/system-settings-view-model";
import type {SystemSettingsGeneral,SystemSettingsOverview} from "./system-settings/system-settings-types";
import {OperationsPage,operationsPageContext} from './OperationsPage';
import {OperationsPermissionNotice} from './OperationsPermissionNotice';
import {SystemSettings} from './BusinessViewClients';

export async function SystemSettingsView(props:AdminViewServerProps){
 const {session,requestHeaders,searchParams}=await operationsPageContext(props,systemSettingsRoute);
 if(!hasOperatorPermission(session.operator,'system.settings.read'))return <OperationsPage page={props}><OperationsPermissionNotice permission="system.settings.read"/></OperationsPage>;
 const location=systemSettingsLocation(searchParams??{});
 let initial:SystemSettingsOverview|null=null,initialGeneral:SystemSettingsGeneral|null=null,initialError='',initialGeneralError='',login=false,systemDenied=false,generalDenied=false;
 const failure=(error:unknown,fallback:string)=>{const status=(error as {status?:number})?.status;login ||= status===401;return status===403?'当前没有读取这项设置的权限。':fallback;};
 await Promise.all([
  operationsRead(requestHeaders,systemSettingsBase+'/overview').then((value:SystemSettingsOverview)=>{initial=value;}).catch(error=>{systemDenied=(error as {status?:number})?.status===403;initialError=failure(error,'系统设置暂时无法读取。');}),
  readGeneralSettings(requestHeaders).then(value=>{
   const lease=systemSettingsReadLease(value);
   if(value.section!=='general'||value.capabilities.canReplaceLogo!==false||value.logo.source!=='fixed-brand-asset'||value.logo.canReplace!==false
    ||value.favicon.source!=='fixed-brand-asset'||value.favicon.canReplace!==false)throw Error('Invalid General settings source');
   initialGeneral={...value,...lease,section:'general',capabilities:{...value.capabilities,canReplaceLogo:false},
    logo:{...value.logo,source:'fixed-brand-asset',canReplace:false},favicon:{...value.favicon,source:'fixed-brand-asset',canReplace:false}};
  }).catch((error:unknown)=>{generalDenied=(error as {status?:number})?.status===403;initialGeneralError=failure(error,'站点设置暂时无法读取。');}),
 ]);
 if(login)redirect('/admin/login?redirect='+encodeURIComponent(systemSettingsHref(location)));
 if(systemDenied&&generalDenied)return <OperationsPage page={props}><OperationsPermissionNotice permission="system.settings.read"/></OperationsPage>;
 return <OperationsPage page={props}><SystemSettings key={session.operator.id} location={location} csrfToken={session.csrfToken} initial={initial} initialError={initialError} initialGeneral={initialGeneral} initialGeneralError={initialGeneralError} canReadSmtp={hasOperatorPermission(session.operator,'smtp.read')} canReadAutonomy={hasOperatorPermission(session.operator,'autonomy.read')} canConfigureAutonomy={hasOperatorPermission(session.operator,'autonomy.configure')}/></OperationsPage>;
}
