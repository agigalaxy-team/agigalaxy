import {operatorPermissionLabel} from '../lib/access';

export function OperationsPermissionNotice({permission}:{permission:string}){
 return <section className="galaxy-business-users"><header><h1>当前没有此项权限</h1></header><p role="alert">需要“{operatorPermissionLabel(permission)}”授权。</p></section>;
}
