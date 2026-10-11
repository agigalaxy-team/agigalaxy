import {showExactChoice} from './exact-choice.mjs';
import {nativeStateLabel} from '../../../packages/galaxy-edge-mcp/src/native-v2/presentation.mjs';
export function createIdentityMenu({ controller, select, prompt, info, language, isCurrent, onBack }) {
  const label = (zh,en) => language === 'en-US' ? en : zh;
  let generation = 0;
  const current = version => isCurrent() && version === generation;
  function message(text, back = open) {
    if (!isCurrent()) return; const version = ++generation;
    info('Galaxy', text, () => { if(current(version)){generation++;back();} });
  }
  function menu(title, entries, back = open) {
    if (!isCurrent()) return; const version=++generation, routes={};
    const once=fn=>()=>{if(current(version)){generation++;fn();}};
    const options=entries.map(([title,action,description=''],index)=>{routes[index+1]=once(action);return {number:String(index+1),title,description};});
    select({title,options,routes,onBack:once(back)});
  }
  async function run(work, done, back = open) {
    if(!isCurrent())return;const version=++generation;
    info('Galaxy',label('正在处理；Esc返回。','Working; Esc returns.'),()=>{if(current(version)){generation++;controller.cancel();back();}});
    try { const result=await work();if(current(version))done(result); }
    catch(error){if(current(version))message(String(error.message),back);}
  }
  function open() {
    menu(label('外部账户关联','External accounts'),[
      [label('关联一个外部账户','Link an external account'),providers,label('完成外部登录后，由当前Galaxy身份确认关联','Confirm with this Galaxy identity after external login')],
      [label('查看与撤销已有关联','View or unlink accounts'),()=>list()],
    ],onBack);
  }
  function providers() {
    void run(()=>controller.readIdentity('providers',{}),result=>{
      if(!result.providers.length)return message(label('此端点尚未配置外部登录服务。','This endpoint has no external login provider configured.'));
      menu(label('选择登录服务','Choose a login provider'),result.providers.map(provider=>[
        provider.name,()=>void run(()=>controller.readIdentity('begin',{providerId:provider.id}),login=>awaitLogin(login)),provider.issuer,
      ]));
    });
  }
  function awaitLogin(login) {
    menu(`${label('在浏览器中打开以下登录地址，完成后返回这里。','Open this login address in your browser, then return here.')}\n${login.issuer}\n${login.authorizationUrl}\n${label('有效至','Expires')}: ${new Date(login.expiresAt*1000).toISOString()}`, [
      [label('已完成登录，查看关联内容','Login finished; review association'),()=>confirm('link',{id:login.loginId},()=>awaitLogin(login))],
      [label('取消这次登录','Cancel this login'),()=>void run(()=>controller.readIdentity('cancel',{id:login.loginId}),()=>open())],
    ],open);
  }
  function list(input={}, previous=[]) {
    const back=()=>previous.length?list(previous.at(-1),previous.slice(0,-1)):open();
    void run(()=>controller.readIdentity('query',{...input,limit:8}),page=>menu(label('已有账户关联','Account associations'),[
      ...page.items.map(item=>[`${item.providerId} · ${item.externalSubject}`,()=>menu(
        `${item.issuer}\n${item.externalSubject}\n${item.subjectId}\n${item.state}\n${label('关联本身不授予业务资料访问权。','Association alone does not grant access to business data.')}`, [
          ...(item.state!=='revoked'?[[label('撤销关联','Unlink account'),()=>confirm('unlink',{id:item.id},()=>list(input,previous))]]:[]),
          [label('返回列表','Back to list'),()=>list(input,previous)],
        ],()=>list(input,previous)),item.state]),
      ...(page.nextAfter?[[label('下一页','Next page'),()=>list({after:page.nextAfter},[...previous,input])]]:[]),
    ],back),back);
  }
  function confirm(action,input,back) {
    void run(()=>controller.prepareIdentity(action,input),preview=>{
      const version=++generation;
      const leave=()=>{if(current(version)){generation++;controller.cancel();back();}};
      showExactChoice({preview,title:label(action==='link'?'关联这个外部账户':'撤销这个账户关联',action==='link'?'Link this external account':'Unlink this account'),select,info,language,isCurrent:()=>current(version),onCancel:leave,
        onConfirm:text=>{if(!current(version))return;generation++;
          void run(()=>controller.executeIdentity(preview,text),result=>message(nativeStateLabel(result.state)??label('账户关联已更新。','Account association updated.'),()=>list()),back);}});
    },back);
  }
  return Object.freeze({open});
}
