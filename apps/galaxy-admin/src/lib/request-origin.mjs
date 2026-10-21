import {adminEnvironment} from './environment.mjs';
export function isAdminWrite(headers,publicOrigin=adminEnvironment().publicOrigin){return headers.get('origin')===publicOrigin;}
export function requireAdminWrite(headers,publicOrigin=adminEnvironment().publicOrigin){if(!isAdminWrite(headers,publicOrigin))throw Error('admin_origin_required');}
