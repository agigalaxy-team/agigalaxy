'use client';

import Link from 'next/link';
import { demoStorageKey as storageKey, createDemoNode, encodeDemoState, decodeDemoState, exportDemoState } from '@/lib/browser-demo.mjs';
import { useEffect, useMemo, useState } from 'react';
import type { SyntheticEvent } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Code2,
  Copy,
  Database,
  Eye,
  FileDown,
  FileKey2,
  Fingerprint,
  History,
  KeyRound,
  Laptop,
  LockKeyhole,
  Network,
  Plus,
  ShieldCheck,
  Sparkles,
  Terminal,
  Upload,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type BrowserNode = { id: string; fingerprint: string; createdAt: string };
type LocalCase = { id: string; title: string; failureSummary: string; createdAt: string; status: 'draft' | 'local-proof-draft' };
type DisclosurePlan = { id: string; caseId: string; recipient: string; purpose: string; include: string[]; exclude: string[]; expiresAt: string; status: 'preview' | 'confirmed' };
type ConsentGrant = { id: string; disclosurePlanId: string; caseId: string; issuedAt: string; status: 'active' | 'revoked' };
type LocalProof = { id: string; caseId: string; consentGrantId: string; createdAt: string; status: 'draft' };
type LocalState = { node: BrowserNode | null; cases: LocalCase[]; plans: DisclosurePlan[]; grants: ConsentGrant[]; proofs: LocalProof[] };

const emptyState: LocalState = { node: null, cases: [], plans: [], grants: [], proofs: [] };
const alwaysExcluded = ['Secret / API Key', '.env 与 Token', '未选择源代码', '浏览器凭据'];
const disclosureOptions = [
  { id: 'failure_summary', label: '失败摘要', detail: '当前问题的最小化说明' },
  { id: 'attempt_metadata', label: '尝试记录', detail: '已尝试方案的名称与次数' },
  { id: 'verification_note', label: '验证说明', detail: '由你填写的最小化结果说明' },
];
const mcpSurface = [
  'profiles: minimal | coding-case | agent-workspace',
  '  → choose only the local scope you need',
  'galaxy_integration_list_modules',
  '  → available modules + profiles',
  'galaxy_integration_preview_initialization',
  '  → dependency plan, local effects only',
  'galaxy_integration_initialize',
  '  → explicit confirmation required',
  'galaxy_identity_status',
  '  → local Galaxy ID + draft count',
  'galaxy_identity_describe_guid',
  '  → limited GUID-32 format metadata',
  'galaxy_command',
  '  → /Galaxy: first-run setup or active service',
  'galaxy_case_create_escalation_draft',
  '  → local Case Draft only',
  'galaxy_case_preview_disclosure',
  '  → always excludes Secret / env / Token',
  'galaxy_case_confirm_local_proof_draft',
  '  → Consent Grant + Local Proof Draft',
  '  → no publish, no remote transfer',
].join('\n\n');

function recordId(prefix: string) {
  return `demo_${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function truncate(value: string, length = 30) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function scrollToId(target: string) {
  document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function Home() {
  const [state, setState] = useState<LocalState>(emptyState);
  const [hydrated, setHydrated] = useState(false);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [failureSummary, setFailureSummary] = useState('');
  const [recipient, setRecipient] = useState('未来由我选择的 Resolver');
  const [purpose, setPurpose] = useState('仅用于审阅这一条本地 AI Coding Case');
  const [include, setInclude] = useState<string[]>(['failure_summary', 'attempt_metadata']);
  const [verificationNote, setVerificationNote] = useState('我确认这只是本地 Proof Draft，仍未获得独立验证。');
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState('');

  useEffect(() => {
    const hydrationTimer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const parsed = decodeDemoState(saved) as LocalState;
          setState({ ...emptyState, ...parsed });
          setActiveCaseId(parsed.cases.at(-1)?.id ?? null);
        }
      } catch {
        setMessage('演示缓存无法读取，已保留原内容；本次从空白演示开始。');
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(hydrationTimer);
  }, []);

  function commit(nextState: LocalState) {
    setState(nextState);
    try { window.localStorage.setItem(storageKey, encodeDemoState(nextState)); }
    catch { setStorageError('当前演示保留在页面内，但浏览器存储失败；刷新后可能丢失。'); }
  }

  function activateNode() {
    if (state.node) {
      scrollToId('console');
      return;
    }
    const node = createDemoNode();
    commit({ ...state, node });
    setMessage('DEMO 编号已创建，仅用于浏览器模拟。真实 Galaxy ID 仍由本机集成包在明确确认后初始化。');
    window.setTimeout(() => scrollToId('console'), 0);
  }

  const activeCase = useMemo(
    () => state.cases.find((item) => item.id === activeCaseId) ?? state.cases.at(-1) ?? null,
    [activeCaseId, state.cases],
  );
  const activePlan = useMemo(
    () => [...state.plans].reverse().find((plan) => plan.caseId === activeCase?.id) ?? null,
    [activeCase?.id, state.plans],
  );
  const activeGrant = useMemo(
    () => state.grants.find((grant) => grant.caseId === activeCase?.id && grant.status === 'active') ?? null,
    [activeCase?.id, state.grants],
  );
  const activeProof = useMemo(
    () => state.proofs.find((proof) => proof.caseId === activeCase?.id) ?? null,
    [activeCase?.id, state.proofs],
  );

  function createCase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state.node) {
      activateNode();
      setMessage('先创建了浏览器本地预览 ID。现在填写 Case 后再建立草稿。');
      return;
    }
    if (title.trim().length < 3 || failureSummary.trim().length < 8) {
      setMessage('请至少填写一个清晰的 Case 标题和失败摘要。');
      return;
    }
    const draft: LocalCase = {
      id: recordId('case'), title: title.trim(), failureSummary: failureSummary.trim(), createdAt: new Date().toISOString(), status: 'draft',
    };
    commit({ ...state, cases: [...state.cases, draft] });
    setActiveCaseId(draft.id);
    setTitle('');
    setFailureSummary('');
    setMessage('Case Draft 已本地创建。下一步请先查看披露预览。');
  }

  function toggleInclude(option: string, checked: boolean) {
    setInclude((current) => {
      if (checked) return [...new Set([...current, option])];
      return current.length === 1 ? current : current.filter((item) => item !== option);
    });
  }

  function createPreview() {
    if (!activeCase) {
      setMessage('先创建或选择一个 Case Draft。');
      return;
    }
    const plan: DisclosurePlan = {
      id: recordId('disclosure'), caseId: activeCase.id, recipient: recipient.trim() || '未来由我选择的 Resolver', purpose: purpose.trim() || '仅用于审阅这一条本地 AI Coding Case', include, exclude: alwaysExcluded,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), status: 'preview',
    };
    commit({ ...state, plans: [...state.plans, plan] });
    setMessage('披露预览已生成。现在仍然没有任何内容离开此浏览器。');
  }

  function confirmLocalProof() {
    if (!activeCase || !activePlan) {
      setMessage('请先为当前 Case 创建披露预览。');
      return;
    }
    if (verificationNote.trim().length < 8) {
      setMessage('请写一条最小化的验证说明。');
      return;
    }
    const grant: ConsentGrant = { id: recordId('grant'), disclosurePlanId: activePlan.id, caseId: activeCase.id, issuedAt: new Date().toISOString(), status: 'active' };
    const proof: LocalProof = { id: recordId('proof'), caseId: activeCase.id, consentGrantId: grant.id, createdAt: new Date().toISOString(), status: 'draft' };
    const cases = state.cases.map((item) => item.id === activeCase.id ? { ...item, status: 'local-proof-draft' as const } : item);
    const plans = state.plans.map((item) => item.id === activePlan.id ? { ...item, status: 'confirmed' as const } : item);
    commit({ ...state, cases, plans, grants: [...state.grants, grant], proofs: [...state.proofs, proof] });
    setMessage('本地 Consent Grant 与 Local Proof Draft 已创建；没有发布、没有传输、没有独立验证。');
  }

  function revokeActiveGrant() {
    if (!activeGrant) return;
    commit({ ...state, grants: state.grants.map((grant) => grant.id === activeGrant.id ? { ...grant, status: 'revoked' } : grant) });
    setMessage('本地 Consent Grant 已撤销。该授权不再可用于后续可分享 Draft。');
  }

  function downloadExport() {
    const exportData = exportDemoState(state);
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'galaxy-browser-demo-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('已导出演示数据，文件明确标为未签名、非权威记录；你填写的内容会原样包含在内。');
  }

  async function copyIntegrationPrompt() {
    const prompt = '请处理 /Galaxy：先读取 Galaxy 当前状态。如果尚未初始化，请按当前原生流程预览默认 L3 本地能力包、接入与可见性，以及本地影响。在我明确确认前不要初始化；不要上传、发布或创建远程账户。如果已初始化，请直接进入可用的 Galaxy 服务，不要重复设置。';
    await navigator.clipboard.writeText(prompt);
    setMessage('给 AI 的 /Galaxy 请求已复制：请在本机 Agent 中使用；本网页只复制文字，不执行初始化。');
  }

  const steps = [
    { label: '本地预览 ID', done: Boolean(state.node) },
    { label: 'Case Draft', done: Boolean(activeCase) },
    { label: '披露预览', done: Boolean(activePlan) },
    { label: 'Local Proof', done: Boolean(activeProof) },
  ];

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_18%_0%,rgba(82,102,255,0.20),transparent_31rem),radial-gradient(circle_at_86%_12%,rgba(46,213,177,0.15),transparent_26rem),linear-gradient(180deg,#07111f_0%,#081220_45%,#050a12_100%)] text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-35 [background-image:linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] [background-size:56px_56px]" />
      <header className="sticky top-0 z-30 border-b border-white/8 bg-[#07111f]/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 lg:px-8">
          <button className="flex items-center gap-3 text-left" onClick={() => scrollToId('top')}>
            <span className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-indigo-400 to-emerald-300 text-[#07111f] shadow-[0_0_28px_rgba(99,102,241,0.5)]"><Sparkles className="size-4" /></span>
            <span><span className="block text-sm font-semibold tracking-[0.18em] text-white">GALAXY</span><span className="block text-[10px] tracking-[0.16em] text-slate-400">FOUNDING BETA</span></span>
          </button>
          <nav aria-label="主导航" className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
            <button className="transition hover:text-white" onClick={() => scrollToId('how-it-works')}>如何工作</button>
            <button className="transition hover:text-white" onClick={() => scrollToId('privacy')}>隐私边界</button>
            <button className="transition hover:text-white" onClick={() => scrollToId('mcp')}>集成包</button>
          </nav>
          <Button className="bg-white text-[#081220] hover:bg-slate-100" onClick={activateNode}><Fingerprint />{state.node ? '查看本地预览 ID' : '创建本地预览 ID'}</Button>
        </div>
      </header>

      <div id="top" className="relative mx-auto max-w-7xl px-5 pb-24 pt-14 lg:px-8 lg:pt-20">
        <aside aria-label="演示边界" className="mb-8 rounded-xl border border-amber-300/30 bg-amber-200/10 p-4 text-sm leading-6 text-amber-100">
          <strong>浏览器演示 · 非正式服务</strong>：数据仅存于当前浏览器，不接入本机 Core、Official 或 Hub；模拟 Consent 和 Proof 不带签名。本页不会执行 /galaxy 初始化，请仅使用示例内容。
        </aside>
        <section className="grid items-center gap-12 lg:grid-cols-[1.04fr_.96fr]">
          <div>
            <div className="mb-6 flex items-center gap-3 text-xs font-medium uppercase tracking-[0.16em] text-emerald-200"><span className="h-px w-8 bg-emerald-300/70" />AI Coding 流程演示</div>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] text-white sm:text-6xl lg:text-7xl">让 AI 工作，<br />预览披露与验证流程。</h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">Galaxy 从一个本地 Galaxy ID 开始：由 AI 集成包引导你选择所需模块、审阅最小披露范围，再逐步记录困难的 AI Coding 工作。</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" className="h-11 bg-indigo-300 px-4 text-[#07111f] hover:bg-indigo-200" onClick={activateNode}>开始本地体验 <ArrowRight /></Button>
              <Button size="lg" variant="outline" className="h-11 border-white/15 bg-white/4 px-4 text-white hover:bg-white/10 hover:text-white" onClick={() => scrollToId('mcp')}><Terminal /> 了解集成包</Button>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-xs text-slate-400">
              <span className="inline-flex items-center gap-2"><CloudOff className="size-3.5 text-emerald-300" />默认不上传 Case 内容</span>
              <span className="inline-flex items-center gap-2"><KeyRound className="size-3.5 text-indigo-300" />先有本地 Galaxy ID，再决定绑定</span>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="size-3.5 text-sky-300" />Proof 不等于自我声明</span>
            </div>
          </div>

          <Card className="border border-white/10 bg-[#0d1b2d]/78 py-0 shadow-[0_28px_90px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <div className="border-b border-white/8 px-5 py-4 sm:px-6"><div className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-indigo-400/15 text-indigo-200 ring-1 ring-indigo-300/30"><Network className="size-4" /></span><div><p className="text-sm font-medium text-white">Galaxy ID Console</p><p className="text-xs text-slate-400">浏览器本地预览 · Founding Beta</p></div></div><Badge className="border border-emerald-300/25 bg-emerald-300/10 text-emerald-100" variant="outline"><CloudOff /> 外发 0</Badge></div></div>
            <CardContent className="p-5 sm:p-6">
              <div className="rounded-2xl border border-white/10 bg-black/15 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.14em] text-slate-500">Browser demo ID</p><p className="mt-2 font-mono text-sm text-white">{state.node ? truncate(state.node.id, 34) : '等待本地创建'}</p></div><span className={`mt-1 size-2 rounded-full ${state.node ? 'bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,.8)]' : 'bg-slate-600'}`} /></div><p className="mt-3 text-xs leading-5 text-slate-400">{state.node ? '仅存于本浏览器预览；不是已注册账号、实名身份或公开履历。真实 GUID-32 的承诺值会与初始本地公钥绑定。' : '点击创建后会生成浏览器 DEMO 编号，不会自动上传任何工作内容。'}</p></div>
              <div className="mt-5 grid grid-cols-4 gap-2">{steps.map((step, index) => <div key={step.label} className="min-w-0"><div className={`h-1 rounded-full ${step.done ? 'bg-emerald-300' : 'bg-white/10'}`} /><p className="mt-2 text-[10px] font-medium leading-4 text-slate-400"><span className="mr-1 text-slate-500">0{index + 1}</span>{step.label}</p></div>)}</div>
              <div className="mt-5 rounded-2xl border border-indigo-300/14 bg-indigo-300/7 p-4"><div className="flex gap-3"><Bot className="mt-0.5 size-4 shrink-0 text-indigo-200" /><div><p className="text-sm font-medium text-indigo-50">第一个真实闭环</p><p className="mt-1 text-xs leading-5 text-indigo-100/65">创建 Case → 审阅披露 → 生成 Local Proof Draft。真正的网络同步与第三方验证尚未开启。</p></div></div></div>
            </CardContent>
          </Card>
        </section>

        <section id="console" className="scroll-mt-24 mt-24">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-[0.16em] text-indigo-200">Working surface</p><h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-white">Galaxy ID 控制台</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">这一页的 Case、授权和 Proof Draft 都只保存在当前浏览器。真实本地流程由 Galaxy Integration Pack 的 MCP/Skill 引导，不要求用户手动运行 CLI。</p></div><div className="flex gap-2"><Button variant="outline" className="border-white/12 bg-white/4 text-slate-200 hover:bg-white/10 hover:text-white" onClick={downloadExport} disabled={!hydrated}><FileDown />导出本地数据</Button><Button variant="outline" className="border-white/12 bg-white/4 text-slate-200 hover:bg-white/10 hover:text-white" onClick={activateNode}><Fingerprint />{state.node ? '预览 ID 已就绪' : '创建预览 ID'}</Button></div></div>
          {storageError && <p role="alert" className="mb-4 text-sm text-amber-200">{storageError}</p>}
          {message && <output aria-live="polite" className="mb-5 flex items-start gap-3 rounded-xl border border-emerald-300/18 bg-emerald-300/8 px-4 py-3 text-sm text-emerald-50"><CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-300" /><span>{message}</span></output>}
          <div className="grid gap-5 xl:grid-cols-[.9fr_1.1fr]">
            <div className="space-y-5">
              <Card className="border border-white/10 bg-[#0d1b2d]/72 py-0"><CardHeader className="border-b border-white/8 py-5"><CardTitle className="flex items-center gap-2 text-white"><Fingerprint className="size-4 text-indigo-200" />浏览器演示编号</CardTitle><CardDescription className="text-slate-400">DEMO 编号和随机标记仅区分本次演示，不包含密钥或持钥证明。</CardDescription></CardHeader><CardContent className="p-5">{state.node ? <div className="space-y-4"><div className="rounded-xl bg-black/20 p-3"><p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Browser demo ID</p><p className="mt-1 break-all font-mono text-xs text-slate-100">{state.node.id}</p></div><div className="grid grid-cols-2 gap-3 text-xs"><div className="rounded-xl border border-white/8 p-3"><p className="text-slate-500">随机演示标记</p><p className="mt-1 font-mono text-slate-200">{truncate(state.node.fingerprint, 18)}</p></div><div className="rounded-xl border border-white/8 p-3"><p className="text-slate-500">创建时间</p><p className="mt-1 text-slate-200">{formatTime(state.node.createdAt)}</p></div></div><p className="rounded-xl border border-amber-300/15 bg-amber-200/5 px-3 py-2 text-xs leading-5 text-amber-100/75">DEMO 编号和随机标记不是 Galaxy ID、公钥指纹或持钥证明。此处的授权与 Proof 均为未签名模拟数据，不会导入本机 Core。</p></div> : <div className="rounded-xl border border-dashed border-white/15 bg-black/10 px-4 py-6 text-center"><Laptop className="mx-auto size-5 text-slate-500" /><p className="mt-3 text-sm text-slate-300">先创建一个浏览器 DEMO 编号</p><p className="mt-1 text-xs leading-5 text-slate-500">无需填写资料；不会自动上传源码、Prompt 或日志。</p><Button className="mt-4 bg-indigo-300 text-[#07111f] hover:bg-indigo-200" onClick={activateNode}><Plus />创建本地预览 ID</Button></div>}</CardContent></Card>
              <Card className="border border-white/10 bg-[#0d1b2d]/72 py-0"><CardHeader className="border-b border-white/8 py-5"><CardTitle className="flex items-center gap-2 text-white"><Code2 className="size-4 text-emerald-200" />创建 Coding Case</CardTitle><CardDescription className="text-slate-400">记录真实困难的最小化摘要，而不是建立个人简历。</CardDescription></CardHeader><CardContent className="p-5"><form className="space-y-3" onSubmit={createCase}><label className="block text-xs font-medium text-slate-300" htmlFor="case-title">Case 标题</label><Input id="case-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：依赖升级后 TypeScript 构建失败" className="border-white/10 bg-black/15 text-white placeholder:text-slate-600" /><label className="block pt-1 text-xs font-medium text-slate-300" htmlFor="case-summary">失败摘要</label><Textarea id="case-summary" value={failureSummary} onChange={(event) => setFailureSummary(event.target.value)} placeholder="写清楚已尝试什么、为什么仍然卡住。这里不会自动发送。" className="min-h-27 border-white/10 bg-black/15 text-white placeholder:text-slate-600" /><Button type="submit" className="w-full bg-white text-[#07111f] hover:bg-slate-100"><Plus />创建本地 Case Draft</Button></form>{state.cases.length > 0 && <div className="mt-5 border-t border-white/8 pt-4"><p className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">Local drafts</p><div className="space-y-2">{state.cases.slice().reverse().slice(0, 3).map((item) => <button key={item.id} className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-xs transition ${item.id === activeCase?.id ? 'bg-indigo-300/12 text-white' : 'bg-white/3 text-slate-400 hover:bg-white/7'}`} onClick={() => setActiveCaseId(item.id)}><span className="min-w-0 truncate">{item.title}</span><span className="shrink-0 text-[10px] text-slate-500">{item.status === 'local-proof-draft' ? 'Proof Draft' : 'Draft'}</span></button>)}</div></div>}</CardContent></Card>
            </div>

            <div id="privacy" className="scroll-mt-24 space-y-5">
              <Card className="border border-indigo-300/22 bg-[#101c33]/82 py-0 shadow-[0_20px_70px_rgba(15,23,42,0.25)]"><CardHeader className="border-b border-white/8 py-5"><div className="flex items-start justify-between gap-4"><div><CardTitle className="flex items-center gap-2 text-white"><Eye className="size-4 text-indigo-200" />Disclosure & Consent Preview</CardTitle><CardDescription className="mt-1 text-slate-400">先看清边界，再确认授权。协议文本不能替代技术控制。</CardDescription></div><Badge className="border border-emerald-300/20 bg-emerald-300/10 text-emerald-100" variant="outline"><CloudOff />本地</Badge></div></CardHeader><CardContent className="p-5 sm:p-6">{activeCase ? <div className="space-y-6"><div className="rounded-xl border border-white/8 bg-black/15 p-4"><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">当前 Case</p><p className="mt-1 text-sm font-medium text-white">{activeCase.title}</p><p className="mt-2 text-xs leading-5 text-slate-400">{activeCase.failureSummary}</p></div><div className="grid gap-4 sm:grid-cols-2"><div><label className="mb-2 block text-xs font-medium text-slate-300" htmlFor="recipient">计划接收方</label><Input id="recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} className="border-white/10 bg-black/15 text-white" /></div><div><label className="mb-2 block text-xs font-medium text-slate-300" htmlFor="purpose">使用目的</label><Input id="purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} className="border-white/10 bg-black/15 text-white" /></div></div><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-emerald-300/18 bg-emerald-300/6 p-4"><div className="flex items-center gap-2"><Upload className="size-4 text-emerald-200" /><p className="text-sm font-medium text-emerald-50">将来可以发送</p></div><div className="mt-3 space-y-3">{disclosureOptions.map((option) => <label key={option.id} htmlFor={`disclosure-${option.id}`} className="flex cursor-pointer items-start gap-3 text-xs text-emerald-50/85"><Checkbox id={`disclosure-${option.id}`} checked={include.includes(option.id)} onCheckedChange={(checked) => toggleInclude(option.id, Boolean(checked))} /><span><span className="block font-medium">{option.label}</span><span className="mt-0.5 block text-emerald-100/55">{option.detail}</span></span></label>)}</div></div><div className="rounded-xl border border-rose-300/18 bg-rose-300/6 p-4"><div className="flex items-center gap-2"><LockKeyhole className="size-4 text-rose-200" /><p className="text-sm font-medium text-rose-50">永不自动发送</p></div><div className="mt-3 space-y-2">{alwaysExcluded.map((item) => <p key={item} className="flex items-center gap-2 text-xs text-rose-100/75"><CircleAlert className="size-3.5" />{item}</p>)}</div></div></div><div className="flex flex-wrap gap-3"><Button variant="outline" className="border-white/12 bg-white/4 text-white hover:bg-white/10 hover:text-white" onClick={createPreview}><Eye />生成披露预览</Button>{activePlan && <span className="inline-flex items-center gap-2 self-center text-xs text-emerald-200"><Check className="size-3.5" />预览存在 · 到期 {formatTime(activePlan.expiresAt)}</span>}</div>{activePlan && <div className="rounded-xl border border-white/10 bg-black/15 p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-white">确认本地授权回执</p><Badge variant="outline" className="border-white/10 bg-white/5 text-slate-300">{activePlan.status}</Badge></div><p className="mt-2 text-xs leading-5 text-slate-400">确认后只会在此浏览器建立 Consent Grant 和 Local Proof Draft。不会传输给 {activePlan.recipient}，也不会公开。</p><Textarea value={verificationNote} onChange={(event) => setVerificationNote(event.target.value)} className="mt-3 min-h-20 border-white/10 bg-black/15 text-white placeholder:text-slate-600" aria-label="最小化验证说明" /><div className="mt-3 flex flex-wrap gap-3"><Button className="bg-indigo-300 text-[#07111f] hover:bg-indigo-200" onClick={confirmLocalProof} disabled={Boolean(activeProof)}><FileKey2 />{activeProof ? 'Local Proof Draft 已存在' : '确认并创建 Local Proof Draft'}</Button>{activeGrant?.status === 'active' && <Button variant="outline" className="border-rose-300/22 bg-rose-300/7 text-rose-100 hover:bg-rose-300/15 hover:text-rose-50" onClick={revokeActiveGrant}>撤销本地授权</Button>}</div></div>}</div> : <div className="rounded-xl border border-dashed border-white/15 bg-black/10 px-5 py-12 text-center"><Eye className="mx-auto size-5 text-slate-500" /><p className="mt-3 text-sm text-slate-300">创建 Case 后才会出现披露预览</p><p className="mt-1 text-xs leading-5 text-slate-500">这里不会把“同意隐私政策”变成无限期的数据授权。</p></div>}</CardContent></Card>
              <Card className="border border-white/10 bg-[#0d1b2d]/72 py-0"><CardHeader className="border-b border-white/8 py-5"><CardTitle className="flex items-center gap-2 text-white"><History className="size-4 text-sky-200" />Local Proof 状态</CardTitle></CardHeader><CardContent className="p-5">{activeProof ? <div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/8 p-3"><p className="text-[11px] text-slate-500">可见性</p><p className="mt-1 text-sm font-medium text-sky-100">仅本地</p></div><div className="rounded-xl border border-white/8 p-3"><p className="text-[11px] text-slate-500">独立验证</p><p className="mt-1 text-sm font-medium text-amber-100">尚未发生</p></div><div className="rounded-xl border border-white/8 p-3"><p className="text-[11px] text-slate-500">公开状态</p><p className="mt-1 text-sm font-medium text-slate-300">未发布</p></div></div> : <p className="text-sm leading-6 text-slate-400">Local Proof Draft 会保留“同意过什么”的上下文，但不会把它升级为 Evidence、履历或公开声誉。</p>}</CardContent></Card>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 mt-24 grid gap-5 lg:grid-cols-3">{[
          { icon: Laptop, label: '01 · Personal Galaxy', title: '我用 Galaxy 工作', copy: '当前可用的本地启动形态：创建 Galaxy ID、记录 AI Coding Case、审阅披露并管理本地授权。首次 /Galaxy 设置后，日常使用不再重复初始化。' },
          { icon: Bot, label: '02 · Galaxy Worker', title: '我的 Agent 持续服务', copy: '面向专业 Agent 作者的 7×24 Worker 形态：将来会带来受控 Runtime、Worker Pack、版本化配置和运行 Policy。当前仅展示架构路径，尚不可启用。' },
          { icon: Network, label: '03 · Galaxy Hub', title: '我的社区拥有星系', copy: '面向组织与社区的本地 Galaxy Core、Policy 和 Evidence Network。Hub 可有自己的规则与数据边界，但不能占有成员 ID 或改写基础事实。当前尚未实现。' },
        ].map((item) => <Card key={item.label} className="border border-white/10 bg-white/[0.035] py-0"><CardContent className="p-6"><span className="grid size-10 place-items-center rounded-xl bg-white/7 text-indigo-200"><item.icon className="size-5" /></span><p className="mt-7 text-[11px] font-medium uppercase tracking-[0.15em] text-slate-500">{item.label}</p><h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-white">{item.title}</h3><p className="mt-3 text-sm leading-6 text-slate-400">{item.copy}</p></CardContent></Card>)}</section>

        <section id="mcp" className="scroll-mt-24 mt-24 grid gap-8 rounded-3xl border border-white/10 bg-[#0d1b2d]/70 p-6 lg:grid-cols-[.86fr_1.14fr] lg:p-10"><div><div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-emerald-200"><Terminal className="size-3.5" />Galaxy Integration Pack</div><h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-white">让 Agent 引导设置，而不是让用户记命令。</h2><p className="mt-4 text-sm leading-7 text-slate-400">集成包把 MCP 与 Skill 放在同一入口：从只创建 Galaxy ID 的 minimal，到 Case / 授权工作流，再到完整 agent-workspace，AI 先读取状态、列出可用模块并预览依赖；只有在你明确确认后，才在本机启用所选范围。新生成的 ID 为 32 位 GUID-32：它携带有限的格式与出生信息，不携带账户、能力、Hub 归属或信任结论。它不发布、不联网、不把 Tool 调用伪装成 Evidence。</p><div className="mt-6 flex flex-wrap gap-3"><Button className="bg-emerald-300 text-[#07111f] hover:bg-emerald-200" onClick={copyIntegrationPrompt}><Copy />复制给 AI 的初始化请求</Button><Button variant="outline" className="border-white/12 bg-white/4 text-white hover:bg-white/10 hover:text-white" onClick={() => scrollToId('console')}><ArrowRight />回到控制台</Button></div></div><div className="overflow-hidden rounded-2xl border border-black/30 bg-[#050b14] shadow-inner"><div className="flex items-center gap-2 border-b border-white/8 px-4 py-3 text-xs text-slate-500"><span className="size-2 rounded-full bg-rose-300/80" /><span className="size-2 rounded-full bg-amber-300/80" /><span className="size-2 rounded-full bg-emerald-300/80" /><span className="ml-2 font-mono">galaxy-integration.local</span></div><pre className="overflow-x-auto p-5 text-xs leading-6 text-slate-300"><code>{mcpSurface}</code></pre></div></section>

        <section className="mt-16 rounded-3xl border border-amber-300/16 bg-amber-200/[0.045] p-6 sm:p-8"><div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between"><div className="flex max-w-3xl gap-4"><CircleAlert className="mt-0.5 size-5 shrink-0 text-amber-200" /><div><h2 className="font-medium text-amber-50">Founding Beta 的诚实边界</h2><p className="mt-2 text-sm leading-6 text-amber-100/65">当前工程只实现本地原型：没有生产账号、没有远程同步、没有公开 Proof、没有 Hub、没有第三方验证。集成包已可在源码开发环境中验证，但尚未发布到插件目录或面向公众安装。</p></div></div><Badge variant="outline" className="shrink-0 border border-amber-300/22 bg-amber-300/8 text-amber-100"><Database />local-first</Badge></div></section>
      </div>
      <footer className="relative border-t border-white/8 px-5 py-8 text-xs text-slate-500 lg:px-8"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3"><span>Galaxy Founding Beta · 本地开发切片</span><span className="flex flex-wrap items-center gap-x-3 gap-y-1"><Link className="transition hover:text-slate-300" href="/agent.md">agent.md</Link><Link className="transition hover:text-slate-300" href="/llms.txt">llms.txt</Link><span>默认本地 · 跨边界逐案授权 · 公开发布逐次确认</span></span></div></footer>
    </main>
  );
}
