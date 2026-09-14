import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function AccountSettings({ runtime, connected }: { runtime: any; connected: boolean }) {
  const [providers, setProviders] = useState<any[]>([]), [links, setLinks] = useState<any[]>([]), [login, setLogin] = useState<any>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [preview, setPreview] = useState<any>(null), [revoke, setRevoke] = useState<string | null>(null);
  async function refresh() {
    const [known, linked] = await Promise.all([runtime.api.call('/v1/identity/providers', {}), runtime.api.call('/v1/identity/query', {})]);
    setProviders(known.providers); setLinks(linked.items);
  }
  async function run(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (e: any) { setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '账号设置操作暂未完成，请稍后重试。'); } finally { setBusy(false); } }
  useEffect(() => {
    let active = true; setProviders([]); setLinks([]); setPreview(null); setLogin(null);
    if (runtime && connected) {
      const reload=()=>refresh().catch(reason => { if (active && document.visibilityState==='visible') setError(reason.message); });
      reload();
      runtime.getLocal('account-login').then((value: any) => { if (active) setLogin(value); });
      const onVisible=()=>{if(document.visibilityState==='visible') reload();};
      const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!busy) reload();},15000);
      document.addEventListener('visibilitychange',onVisible);
      return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange',onVisible); };
    }
    return () => { active = false; };
  }, [runtime, connected]);
  return <section className="account-settings"><h2>账号验证</h2><p className="muted">登录所示验证服务，再用本机银河身份确认关联。账号关联不提供银河身份接管，也不会公开你的联系方式。公开发布、评论与房间参与按验证状态执行。</p>
    {error && <div className="message error" role="alert">{error}</div>}
    {!connected ? <p className="muted">先连接当前银河身份，再查询可用验证服务。</p> : <>
      {providers.length === 0 && <p className="message">当前服务没有可用的账号验证入口。身份仍可使用；依赖账号验证的公开操作暂不能完成。</p>}
      <div className="button-row">{providers.map(provider => <Button key={provider.id} disabled={busy || !!login} variant="outline" onClick={() => run(async () => {
        const result = await runtime.api.call('/v1/identity/begin', { providerId: provider.id });
        const url = new URL(result.authorizationUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('验证服务地址无效。');
        const saved = { id: result.loginId, authorizationUrl: url.href, issuer: provider.issuer, expiresAt: result.expiresAt, bindingId: result.bindingId };
        await runtime.putLocal('account-login', saved); setLogin(saved);
      })}>使用 {provider.name ?? provider.id} 验证</Button>)}</div>
      {login && <div className="message"><p>验证方：{login.issuer}。先打开登录页，完成后回来查询。本次流程有期限，重新连接后可能需要重新开始。</p>
        <div className="button-row"><a className="text-link" href={login.authorizationUrl} target="_blank" rel="noopener noreferrer">打开账号验证页 ↗</a>
          <Button disabled={busy} onClick={() => run(async () => { const result = await runtime.api.call('/v1/identity/status', { id: login.id });
            if (result.state === 'linked') { await runtime.putLocal('account-login', null); setLogin(null); setPreview(null); }
            else if (result.state === 'awaiting-local-signature') setPreview(result);
            else throw new Error(`账号验证状态：${result.state}。完成外部登录后再次查询。`);
          })}>我已完成登录，查询结果</Button>
          <Button variant="ghost" disabled={busy} onClick={() => run(async () => { try { await runtime.api.call('/v1/identity/cancel', { id: login.id }); } catch (e: any) { if (!['identity_login_unavailable', 'connection_required'].includes(e.code)) throw e; }
            await runtime.putLocal('account-login', null); setLogin(null); setPreview(null); })}>取消本次验证</Button></div>
        {preview && <div><p>准备关联到：{preview.intent.subjectId}</p><p>验证服务：{preview.intent.issuer}</p><p>该服务中的账号标识：{preview.intent.externalSubject}</p><Button disabled={busy} onClick={() => run(async () => {
          await runtime.confirmAccountLink(login.id, { confirmed: true }); await runtime.putLocal('account-login', null); setLogin(null); setPreview(null);
        })}>确认关联这个账号</Button></div>}
      </div>}
      <div className="result-list">{links.map(link => <article key={link.id} className="task-card"><h3>{link.providerId}</h3><p>{link.issuer}</p><p className="muted">{link.state === 'linked' ? '账号关联已记录' : link.state} · 关联状态与公开操作资格分别核对。</p><Button variant="ghost" disabled={busy || !!link.revokedAt} onClick={() => setRevoke(link.id)}>解除此关联</Button></article>)}</div>
      {revoke && <div className="message">解除后可能影响公开操作资格，不删除银河身份或其他已验证关联。<div className="button-row"><Button disabled={busy} onClick={() => run(async () => { await runtime.api.call('/v1/identity/revoke', { id: revoke }); setRevoke(null); })}>确认解除</Button><Button variant="ghost" onClick={() => setRevoke(null)}>取消</Button></div></div>}
    </>}
  </section>;
}
