import {ReadingDetails,ReadingSummary} from './reading-details';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from '@/components/ui/button';
import type {createAccountVerificationClient} from './account-verification-client.mjs';
import type {z} from 'zod';
import type {identityIntentSchema} from '../../galaxy-official/src/shared/identity-link-schema.mjs';

type Provider = {id: string; name?: string; issuer: string};
type Login = {id: string; bindingId: string; subjectId?: string; endpoint?: string; issuer: string | null; authorizationUrl?: string | null; expiresAt?: number | null; localRetryStopped?: boolean};
type Link = {id: string; providerId: string; issuer: string; state: string; revokedAt?: string | null};
type Intent = z.output<typeof identityIntentSchema>;
type Result = {id: string; state: string; outcome?: string; intent?: Intent; payloadJson?: string; payloadHash?: string};
type Lease = {subjectId: string; deviceId: string; endpoint: string; bindingId: string | null; generation: number | null; assertCurrent: () => void};
type Accounts = ReturnType<typeof createAccountVerificationClient>;
type Runtime = {accounts: Accounts};
type Scope = {runtime: Runtime; accounts: Accounts; lease: Lease};
type Preview = {result: Result & {intent: Intent; payloadJson: string}; scope: Scope};
const emptyView = () => ({providers: [] as Provider[], links: [] as Link[], login: null as Login | null, originals: [] as Login[], quota: null as {accountVerified: boolean} | null,
  providersLoaded: false, linksLoaded: false, quotaLoaded: false, loading: true});
const message = (error: unknown) => { const reason = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return ({
  connection_required: '请先连接当前银河身份，再读取账号验证。',
  identity_login_unavailable: '服务暂时无法确认这个原登录流程。请保留原记录并查询结果。',
  identity_provider_unavailable: '这个验证服务目前不可用，可以稍后重新读取可用入口。',
  account_verification_preview_changed: '这次账号确认的内容已经变化，请重新查询并核对。',
} as Record<string, string>)[typeof reason.code === 'string' ? reason.code : ''] ?? (typeof reason.message === 'string' && reason.message.trim() ? reason.message : '账号设置操作暂未完成，请稍后重试。'); };
const leaseCurrent = (scope: Scope | null, runtime: Runtime | null) => { if (!scope || scope.runtime !== runtime) return false; try { scope.lease.assertCurrent(); return true; } catch { return false; } };

export function AccountSettings({runtime, connected}: {runtime: Runtime | null; connected: boolean}) {
  const [view, setView] = useState(emptyView), [preview, setPreview] = useState<Preview | null>(null), [revoke, setRevoke] = useState<string | null>(null);
  const [displayScope, setDisplayScope] = useState<Scope | null>(null), [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [scopeChanged, setScopeChanged] = useState(false);
  const state = useRef<{active: boolean; effect: number; read: number; operation: number; busy: boolean; scope: Scope | null}>({active: false, effect: 0, read: 0, operation: 0, busy: false, scope: null});
  const current = useCallback((scope: Scope | null): scope is Scope => {
    if (!scope || !state.current.active || state.current.scope !== scope || scope.runtime !== runtime) return false;
    try { scope.lease.assertCurrent(); return true; } catch { return false; }
  }, [runtime]);
  const invalidate = useCallback((scope: Scope | null) => {
    if (!scope || !state.current.active || state.current.scope !== scope) return;
    state.current.scope = null; state.current.read++; state.current.operation++; state.current.busy = false;
    setDisplayScope(null); setView({...emptyView(), loading: false}); setPreview(null); setRevoke(null); setBusy(false); setError(''); setReadError(''); setNotice(''); setScopeChanged(true);
  }, []);
  const refresh = useCallback(async (scope: Scope | null = state.current.scope) => {
    if (!current(scope)) { invalidate(scope); return; }
    const ticket = ++state.current.read;
    const recovered = await scope.accounts.resumePending().catch(() => null);
    if (!current(scope)) { invalidate(scope); return; }
    const readers: Array<() => Promise<unknown>> = [() => scope.accounts.providers(), () => scope.accounts.query({}), () => scope.accounts.pending(), () => scope.accounts.originals(), () => scope.accounts.quotas()];
    const results = await Promise.allSettled(readers.map(action => Promise.resolve().then(action)));
    if (!current(scope)) { invalidate(scope); return; }
    if (ticket !== state.current.read) return;
    const value = <T,>(index: number, fallback: T): T => results[index].status === 'fulfilled' ? (results[index] as PromiseFulfilledResult<unknown>).value as T : fallback;
    const names = ['验证入口', '已有账号关联', '本机验证流程', '待核对原记录', '当前参与资格'];
    setReadError(results.map((result, index) => result.status === 'rejected' ? names[index] + '：' + message(result.reason) : '').filter(Boolean).join(' '));
    setView({providers: value<{providers: Provider[]} | null>(0, null)?.providers ?? [], links: value<{items: Link[]} | null>(1, null)?.items ?? [], login: value<Login | null>(2, null), originals: value<Login[]>(3, []), quota: value<{accountVerified: boolean} | null>(4, null),
      providersLoaded: results[0].status === 'fulfilled', linksLoaded: results[1].status === 'fulfilled', quotaLoaded: results[4].status === 'fulfilled', loading: false});
    const activeLogin=value<Login|null>(2,null);
    if(recovered?.state==='awaiting-local-signature'&&recovered.intent&&typeof recovered.payloadJson==='string'&&activeLogin&&activeLogin.id===recovered.id&&activeLogin.bindingId===scope.lease.bindingId&&!activeLogin.localRetryStopped)
      setPreview({result:{...recovered,intent:recovered.intent,payloadJson:recovered.payloadJson} as Preview['result'],scope});
    else if(recovered&&['linked','revoked','canceled','cancelled'].includes(recovered.state))setPreview(null);
  }, [current, invalidate]);
  const start = useCallback(() => {
    if (!runtime || !connected || !state.current.active) return;
    state.current.read++; state.current.operation++; state.current.busy = false;
    setView(emptyView()); setPreview(null); setRevoke(null); setBusy(false); setError(''); setReadError(''); setNotice(''); setScopeChanged(false);
    try { const accounts = runtime.accounts; const scope = {runtime, accounts, lease: accounts.captureLease()}; state.current.scope = scope; setDisplayScope(scope); void refresh(scope); }
    catch (reason) { state.current.scope = null; setDisplayScope(null); setView({...emptyView(), loading: false}); setError(message(reason)); }
  }, [runtime, connected, refresh]);
  async function run(action: (scope: Scope) => Promise<void>) {
    const scope = state.current.scope;
    if (state.current.busy) return;
    if (!current(scope)) { invalidate(scope); return; }
    const operation = ++state.current.operation;
    state.current.busy = true; setBusy(true); setError(''); setNotice('');
    try { await action(scope); }
    catch (reason) {
      if (!current(scope)) { invalidate(scope); return; }
      if (operation === state.current.operation) { setPreview(null); setError(message(reason)); }
    } finally {
      if (current(scope) && operation === state.current.operation) await refresh(scope);
      if (!current(scope)) invalidate(scope);
      else if (operation === state.current.operation) { state.current.busy = false; setBusy(false); }
    }
  }
  function showResult(result: Result, scope: Scope, allowPreview = false) {
    if (!current(scope)) { invalidate(scope); return; }
    setPreview(null);
    if (result.state === 'awaiting-local-signature') {
      if (allowPreview && result.intent && typeof result.payloadJson === 'string') { setPreview({result: {...result, intent: result.intent, payloadJson: result.payloadJson}, scope}); setNotice('账号已登录，请确认关联。'); }
      else setNotice('原流程正在等待本机确认，但它已停止或不属于当前连接。这里仅查询原记录，不会重新签署。');
      return;
    }
    const known: Record<string, string> = {
      linked: '账号已关联，可以继续原来的事情。',
      revoked: '账号关联已解除。',
      'binding-inactive': '已查到原关联，但它的原连接当前已失效。请分别核对当前关联和参与资格。',
      'provider-unavailable': '已查到原关联，但对应验证服务当前不可用。请分别核对当前关联和参与资格。',
      'awaiting-login': '请在所选服务中完成登录，回来后会继续。',
      pending: '请在所选服务中完成登录，回来后会继续。',
      exchanging: '正在完成验证，请稍候。',
      expired: '此次登录期限已到。请先核对原记录，再决定是否重新开始。',
      canceled: '服务已确认取消此次验证。', cancelled: '服务已确认取消此次验证。',
      failed: '验证服务未完成此次登录。可以先核对原记录，再停止本机流程。',
    };
    setNotice(result.state === 'unavailable'
      ? result.outcome === 'unknown' ? '这次确认的结果尚未核实。已保留原操作，请继续查询同一记录，不要重新提交。' : '原登录流程当前不可用，尚未查到关联记录。可以继续查询，或停止本机流程后重新选择验证服务。'
      : known[result.state] ?? '服务返回了尚未确认的状态。已保留原记录，请稍后继续查询。');
  }
  const queryOriginal = (id: string) => run(async scope => { const result = await scope.accounts.status(id); if (current(scope)) showResult(result, scope, view.login?.id === id && view.login.bindingId === scope.lease.bindingId && !view.login.localRetryStopped); });
  useEffect(() => {
    const lifecycle = state.current, effect = ++lifecycle.effect; lifecycle.active = true;
    queueMicrotask(() => { if (!lifecycle.active || lifecycle.effect !== effect) return;
      if (runtime && connected) start(); else { lifecycle.scope = null; setDisplayScope(null); setView({...emptyView(), loading: false}); } });
    const onVisible = () => { const scope = state.current.scope; if (document.visibilityState !== 'visible') return; if (!current(scope)) invalidate(scope); else if (!state.current.busy) void refresh(scope); };
    const watcher = window.setInterval(() => { const scope = state.current.scope; if (scope && !current(scope)) invalidate(scope); setClock(Math.floor(Date.now() / 1000)); }, 1000);
    const poll = window.setInterval(onVisible, 15000); document.addEventListener('visibilitychange', onVisible);
    return () => { lifecycle.active = false; lifecycle.scope = null; lifecycle.effect++; lifecycle.read++; lifecycle.operation++; window.clearInterval(watcher); window.clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [runtime, connected, start, current, invalidate, refresh]);

  const scope = displayScope, visible = connected && leaseCurrent(scope, runtime);
  const login = visible ? view.login : null;
  const sameBinding = !!login && login.bindingId === scope?.lease.bindingId && (!login.subjectId || login.subjectId === scope?.lease.subjectId) && (!login.endpoint || login.endpoint === scope?.lease.endpoint);
  const shownPreview = visible && sameBinding && preview?.scope === scope && preview.result.id === login.id ? preview.result : null;
  const authorizationUrl = (() => { if (!sameBinding || !login?.authorizationUrl || !login.expiresAt || login.expiresAt <= clock) return null;
    try { const url = new URL(login.authorizationUrl); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } })();
  const originals = visible ? view.originals.filter(record => record.id !== login?.id) : [];

  return <section className="account-settings account-verification"><header className="history-heading"><div><h2>账号验证</h2><p>使用已有账号完成验证，继续发布和交流。</p></div>{visible&&view.quota?.accountVerified&&<span className="verification-done">已完成验证</span>}</header>
    {error&&(visible||!scope&&!scopeChanged)&&<p className="message error" role="alert">{error}</p>}
    {visible&&readError&&<p className="message error" role="alert">部分账号资料暂时没有读到。<Button variant="ghost" disabled={busy} onClick={()=>void refresh()}>重试</Button></p>}
    {visible&&notice&&<output className="privacy-notice">{notice}</output>}
    {!connected?<p className="muted">使用自己的银河身份后，可以继续验证。</p>:scopeChanged?<div className="message"><p>当前身份已变化。</p><Button onClick={start}>继续</Button></div>:!visible&&!view.loading?<Button variant="outline" onClick={start}>重新连接</Button>:!visible||view.loading?<output>正在读取账号…</output>:<>
      {view.providersLoaded&&!view.providers.length&&<p className="message">暂时没有可用的验证服务，稍后可以再试。</p>}
      {!login&&!!view.providers.length&&<section className="verification-providers"><h3>{view.links.some(link=>link.state==='linked'&&!link.revokedAt)?'关联其他账号':'选择验证方式'}</h3><div className="button-row">{view.providers.map(provider=><Button key={provider.id} disabled={busy} variant="outline" onClick={()=>run(async owner=>{const result=await owner.accounts.begin(provider.id,{confirmed:true});if(!current(owner))return;setPreview(null);setView(value=>({...value,login:result}));})}>使用 {provider.name??provider.id}</Button>)}</div></section>}
      {login&&<section className="verification-login"><h3>{shownPreview?'关联刚刚登录的账号':sameBinding?'继续账号验证':'上次的账号验证'}</h3>
        <p>{shownPreview?'你在验证服务中选中的账号，将关联到当前银河身份。':sameBinding?'打开所选服务完成登录，回来后会继续这次验证。':'这次验证属于先前的连接，可以查看它的当前结果。'}</p>
        {shownPreview?<><p className="verification-provider-name">{view.providers.find(provider=>provider.issuer===shownPreview.intent.issuer)?.name??shownPreview.intent.issuer}</p><Button disabled={busy} onClick={()=>run(async owner=>{const result=await owner.accounts.confirm(login.id,{confirmed:true,preview:shownPreview});if(current(owner))showResult(result,owner);})}>关联这个账号</Button><ReadingDetails className="verification-source"><ReadingSummary>核对账号与身份</ReadingSummary><dl><dt>服务提供的账号标识</dt><dd>{shownPreview.intent.externalSubject}</dd><dt>当前银河身份</dt><dd>{shownPreview.intent.subjectId}</dd></dl></ReadingDetails></>:<div className="button-row">{authorizationUrl&&<a className="primary-action" href={authorizationUrl} target="_blank" rel="noopener noreferrer">继续登录</a>}<Button variant="ghost" disabled={busy} onClick={()=>queryOriginal(login.id)}>重新检查</Button></div>}
        <div className="button-row">{sameBinding&&<Button variant="ghost" disabled={busy} onClick={()=>run(async owner=>{const result=await owner.accounts.cancel(login.id,{confirmed:true});if(current(owner))showResult(result,owner);})}>取消验证</Button>}</div>
        {!sameBinding&&<Button variant="outline" disabled={busy} onClick={()=>run(async owner=>{await owner.accounts.stop(login.id,{confirmed:true});if(current(owner)){setPreview(null);setNotice('已停止在本机继续这次验证。');}})}>暂不继续这次验证</Button>}
      </section>}
      <section className="verification-linked"><h3>已关联的账号</h3>{view.linksLoaded&&!view.links.length&&<p className="muted">还没有关联账号。</p>}{view.links.map(link=><article key={link.id}><div><h4>{view.providers.find(provider=>provider.id===link.providerId)?.name??link.providerId}</h4><p>{link.revokedAt?'已解除':({linked:'已关联',revoked:'已解除','binding-inactive':'需要重新连接','provider-unavailable':'验证服务暂不可用'} as Record<string,string>)[link.state]??'状态暂不可确认'}</p></div><Button variant="ghost" disabled={busy||!!link.revokedAt||link.state==='revoked'} onClick={()=>setRevoke(link.id)}>解除关联</Button></article>)}</section>
      {revoke&&<div className="verification-login"><h3>解除这条账号关联？</h3><p>可能影响需要验证的公开参与。银河身份和其他关联账号保留。</p><div className="button-row"><Button disabled={busy} onClick={()=>run(async owner=>{const result=await owner.accounts.revoke(revoke,{confirmed:true});if(current(owner)){setRevoke(null);showResult(result,owner);}})}>解除关联</Button><Button variant="ghost" disabled={busy} onClick={()=>setRevoke(null)}>保留关联</Button></div></div>}
      {!!originals.length&&<ReadingDetails className="verification-source"><ReadingSummary>之前的验证记录</ReadingSummary>{originals.map(record=><article key={record.id}><p>{view.providers.find(provider=>provider.issuer===record.issuer)?.name??record.issuer??'此前的账号验证'}</p><Button variant="outline" disabled={busy} onClick={()=>queryOriginal(record.id)}>查看结果</Button></article>)}</ReadingDetails>}
      <p className="privacy-footnote">账号验证不会公开联系方式，也不会自动分享工作资料。</p>
    </>}
  </section>;
}
