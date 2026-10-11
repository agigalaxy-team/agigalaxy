import React, { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Bell, ArrowRight, X, Plus } from 'lucide-react';
import { createInformationClientV2 } from './information-client-v2.mjs';
import { memberName, useMemberNames } from './conversation-ui';
import { PageLoading } from './site-shell';
import { HistoryFacts } from './history-facts';
import {useChoiceViewLease} from './choice-retained-operations';
import {informationField,informationText as readable,informationError as errorText,informationLocalTime as localTime,restoredInformationSearch,informationOperationActive,informationSelections} from './information-workspace-state';
import type {InformationRuntime,InformationQuery,InformationSelection,InformationScope,InformationItem,InformationPage,InformationWatch,InformationEvents,InformationOperation,InformationPrepared,InformationCommand,InformationDetail,InformationEditing,InformationClient,HonorRule,ComposerKind,ComposerValues,ComposerDraft,QueryComposer,WatchComposer} from './information-workspace-state';
import './profile-settings.css';
import './information-workspace.css';

type Props = {
  runtime: InformationRuntime|null;
  subjectId?: string;
  connected: boolean;
  navigate: (path: string) => void;
  onNeedIdentity?: () => void;
  watchId?: string;
};
// Keep only a completed search request. Returning to the directory re-reads it
// with current permissions; unsent form input and source bodies are not reused.
const recentSearches = new WeakMap<object, Map<string, InformationQuery>>();
const sourceNames: Record<string, string> = {
  history: '工作经历',
  capsule: '方法',
  proof: '验证记录',
  task: '求助',
  opportunity: '项目与交流',
  honor: '荣誉依据',
};
const stateNames: Record<string, string> = {
  active: '关注中',
  paused: '已暂停',
  ended: '已结束',
  expired: '已到期',
};
const actionNames: Record<string, string> = {
  start: '开启关注',
  revise: '保存关注范围',
  pause: '暂停关注',
  resume: '恢复关注',
  end: '结束关注',
};
const time = (value: unknown) =>
  (typeof value === 'number'||typeof value === 'string')&&value
    ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(
        'zh-CN',
      )
    : '尚无记录';
const ruleKey = (rule: HonorRule) =>
  (rule.id ?? rule.ruleId) + '@' + (rule.version ?? rule.ruleVersion);
const sourceType = (source: InformationSelection['source']) =>
  source?.kind === 'honor'
    ? 'honor'
    : source?.kind === 'reference'
      ? source.request.search.type
      : source?.request?.type;
const scopeTitle = (selection: InformationSelection) => {
  const source = selection.source,
    type = sourceType(source);
  return source?.kind === 'reference'
    ? '所选' + (sourceNames[type] ?? '资料')
    : source?.kind === 'honor'
      ? '所选荣誉的适用依据'
      : (sourceNames[type] ?? '所选资料');
};
function itemLink(item: InformationItem) {
  const r = item.record,
    type = item.type ?? item.recordKind,
    id =
      type === 'capsule' ? (informationField(r,'capsuleId') ?? informationField(r,'id') ?? item.ref.id) : item.ref.id;
  if (typeof id !== 'string' || !id) return null;
  if (type === 'task') return '/app/tasks/' + encodeURIComponent(id);
  if (type === 'capsule')
    return (
      '/app/capsules/' +
      encodeURIComponent(id) +
      (typeof informationField(r,'versionId')==='string' ? '/versions/' + encodeURIComponent(String(informationField(r,'versionId'))) : '')
    );
  return null;
}
function exactSelection(scope: InformationScope, item: InformationItem):InformationSelection {
  return {
    key: scope.key,
    source:
      scope.source.kind === 'honor'
        ? scope.source
        : {
            kind: 'reference',
            request: {
              search:
                scope.source.kind === 'reference'
                  ? scope.source.request.search
                  : scope.source.request,
              ref: item.ref,
            },
          },
  };
}
function download(value: unknown, name = 'galaxy-source.json') {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function FactSummary({ item, full = false }: { item: InformationItem; full?: boolean }) {
  const r = item.record ?? {},
    fact = informationField(r,'record') ?? r,
    request = informationField(r,'request');
  const body = [
    item.summary,
    informationField(fact,'summary'),
    informationField(request,'summary'),
    informationField(fact,'description'),
    informationField(fact,'strategy'),
    informationField(request,'expectedOutcome'),
  ]
    .map(readable)
    .find(Boolean);
  const pairs: [string,unknown][] = [
    ['做过的事', informationField(fact,'description') ?? informationField(fact,'strategy')],
    [
      '观察到的结果',
      informationField(fact,'observedEffect') ?? informationField(informationField(fact,'outcome'),'summary') ?? informationField(informationField(fact,'resolution'),'summary'),
    ],
    ['适用范围', informationField(r,'applicableScope') ?? informationField(informationField(r,'rule'),'scope') ?? informationField(request,'expectedOutcome')],
    ['适用限制', informationField(fact,'limitations')],
    ['使用环境', informationField(fact,'environment') ?? informationField(informationField(fact,'conditions'),'environment')],
  ];
  const sections=pairs
    .map(([label, value]) => ({
      label,
      text: readable(value),
    }))
    .filter((value) => value.text && value.text !== body);
  return (
    <div className="information-body">
      {body && (
        <p className={full ? 'reading-prose' : 'information-excerpt'}>{body}</p>
      )}
      {full &&
        sections.map((value) => (
          <section key={value.label}>
            <h4>{value.label}</h4>
            <p className="reading-prose">{value.text}</p>
          </section>
        ))}
      {full && (
        <details className="information-source-details">
          <summary>来源与版本</summary>
          <dl>
            <dt>类型</dt>
            <dd>{sourceNames[item.type ?? item.recordKind ?? ''] ?? '工作资料'}</dd>
            {(informationField(fact,'at') ?? informationField(fact,'createdAt') ?? informationField(r,'createdAt'))!=null && (
              <>
                <dt>记录时间</dt>
                <dd>{time(informationField(fact,'at') ?? informationField(fact,'createdAt') ?? informationField(r,'createdAt'))}</dd>
              </>
            )}
            {item.sourceVersion != null && (
              <>
                <dt>来源版本</dt>
                <dd>{String(item.sourceVersion)}</dd>
              </>
            )}
            {item.ref?.id && (
              <>
                <dt>原记录</dt>
                <dd>{item.ref.id}</dd>
              </>
            )}
          </dl>
          <button className="text-action" onClick={() => download(item)}>
            保存完整来源文件
          </button>
        </details>
      )}
    </div>
  );
}
export function InformationWorkspace(props: Props) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  return <InformationSession key={scope.key+':'+props.connected+':'+(props.watchId??'')} {...props} />;
}
function InformationSession({
  runtime,
  subjectId,
  connected,
  navigate,
  onNeedIdentity,
  watchId,
}: Props) {
  const client = useMemo<InformationClient|null>(
    () => (runtime ? createInformationClientV2({ runtime, subjectId }) : null),
    [runtime, subjectId],
  );
  const searchOwner = JSON.stringify([
    runtime?.api?.endpoint,
    subjectId ?? null,
  ]);
  const [tab, setTab] = useState(
      watchId ||
        new URLSearchParams(window.location.search).get('view') === 'watches'
        ? 'watches'
        : 'search',
    ),
    [query, setQuery] = useState(''),
    [types, setTypes] = useState(['history', 'capsule', 'task']);
  const [windowKind, setWindowKind] = useState('all-visible'),
    [environment, setEnvironment] = useState(''),
    [functions, setFunctions] = useState(''),
    [technologies, setTechnologies] = useState('');
  const [searchLoading, setSearchLoading] = useState(()=>!!(restoredInformationSearch(window.history.state,searchOwner)??(runtime?recentSearches.get(runtime)?.get(searchOwner):null)));
  const [page, setPage] = useState<InformationPage|null>(null),
    [detail, setDetail] = useState<InformationDetail|null>(null),
    [selected, setSelected] = useState<InformationSelection[]>([]),
    [selectionLabels, setSelectionLabels] = useState<Record<string, string>>(
      {},
    );
  const [watchPurpose, setWatchPurpose] = useState(''),
    [expires, setExpires] = useState(''),
    [report, setReport] = useState<'changes'|'daily'>('changes'),
    [reportTime, setReportTime] = useState('09:00'),
    [editing, setEditing] = useState<InformationEditing|null>(null);
  const [watchOpen, setWatchOpen] = useState(false),
    [preview, setPreview] = useState<InformationPrepared|null>(null),
    [watches, setWatches] = useState<InformationWatch[]>([]),
    [watchAfter, setWatchAfter] = useState<string | null>(null),
    [events, setEvents] = useState<InformationEvents|null>(null),
    [pending, setPending] = useState<InformationOperation[]>([]);
  const [honorOpen, setHonorOpen] = useState(false),
    [rules, setRules] = useState<HonorRule[] | null>(null),
    [rule, setRule] = useState(''),
    [honorSubject, setHonorSubject] = useState(subjectId ?? '');
  const [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(!connected),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [composeReady, setComposeReady] = useState(false),
    [composeErrors, setComposeErrors] = useState<Record<string, string>>({}),
    [watchDraftPresent, setWatchDraftPresent] = useState(false);
  const draftHeads = useRef<Record<ComposerKind, string | null>>({
      query: null,
      watch: null,
    }),
    draftBaselines = useRef<Record<ComposerKind, string>>({ query: '', watch: '' }),
    draftQueues = useRef<Record<ComposerKind, Promise<void>>>({
      query: Promise.resolve(),
      watch: Promise.resolve(),
    }),
    draftBlocked = useRef<Record<string, boolean>>({});
  const generation = useRef(0),
    working = useRef(false),
    composeDialog = useRef<HTMLDialogElement>(null),
    detailDialog = useRef<HTMLDialogElement>(null);
  useEffect(()=>{const owner=generation;return()=>{owner.current++;};},[]);
  const previewRef = useRef(preview),
    watchesRef = useRef(watches),
    watchCursor = useRef(watchAfter),
    watchesExpanded = useRef(false);
  useLayoutEffect(()=>{previewRef.current=preview;watchesRef.current=watches;watchCursor.current=watchAfter;});
  const inputId=useId();
  const [minimumExpiry]=useState(()=>localTime(Math.floor(Date.now()/1000)+60));
  const visibleSubjects = useMemo(
    () => [
      ...new Set(
        [
          subjectId,
          ...(page?.items ?? []).flatMap((scope) =>
            (scope.items ?? []).flatMap((item) => [
              informationField(item.record,'subjectId'),
              informationField(item.record,'actorId'),
              informationField(item.record,'requesterId'),
              informationField(item.record,'authorId'),
              informationField(item.record,'ownerId'),
            ]),
          ),
        ].filter(
          (value):value is string =>
            typeof value === 'string' && /^GUID[0-9A-Z]{28}$/.test(value),
        ),
      ),
    ],
    [page, subjectId],
  );
  const displayNames = useMemberNames(
      runtime,
      subjectId,
      connected,
      visibleSubjects,
    ),
    person = (id: string) =>
      memberName(id, subjectId, displayNames[id] ?? undefined);
  function showTab(value: string) {
    setTab(value);
    const url = new URL(window.location.href);
    if (value === 'watches') url.searchParams.set('view', 'watches');
    else url.searchParams.delete('view');
    window.history.replaceState(
      window.history.state,
      '',
      url.pathname + url.search + url.hash,
    );
    window.dispatchEvent(new Event('galaxy:route-view-changed'));
  }
  const chooseIdentity = () =>
    onNeedIdentity ? onNeedIdentity() : navigate('/app/settings/identity');
  const queryValue = ():QueryComposer => ({
    query,
    types,
    windowKind,
    environment,
    functions,
    technologies,
  });
  const searchRead = useRef(0);
  const watchValue = ():WatchComposer => ({
    selected,
    selectionLabels,
    watchPurpose,
    expires,
    report,
    reportTime,
    editing: editing
      ? { watchId: editing.watchId, revision: editing.revision }
      : null,
  });
  function applyDraft(kind: ComposerKind, value: QueryComposer & WatchComposer) {
    if (kind === 'query') {
      setQuery(value.query ?? '');
      setTypes(value.types ?? ['history', 'capsule', 'task']);
      setWindowKind(value.windowKind ?? 'all-visible');
      setEnvironment(value.environment ?? '');
      setFunctions(value.functions ?? '');
      setTechnologies(value.technologies ?? '');
    } else {
      setSelected(value.selected ?? []);
      setSelectionLabels(value.selectionLabels ?? {});
      setWatchPurpose(value.watchPurpose ?? '');
      setExpires(value.expires ?? '');
      setReport(value.report ?? 'changes');
      setReportTime(value.reportTime ?? '09:00');
      setEditing(value.editing ?? null);
    }
  }
  function acceptDraft(kind:ComposerKind,saved:ComposerDraft|null) {
    draftHeads.current[kind] = saved?.revision ?? null;
    draftBlocked.current[kind] = false;
    const value =
      saved?.value ??
      (kind === 'query'
        ? {
            query: '',
            types: ['history', 'capsule', 'task'],
            windowKind: 'all-visible',
            environment: '',
            functions: '',
            technologies: '',
          }
        : {
            selected: [],
            selectionLabels: {},
            watchPurpose: '',
            expires: '',
            report: 'changes',
            reportTime: '09:00',
            editing: null,
          });
    draftBaselines.current[kind] = JSON.stringify(value);
    applyDraft(kind, value);
    if (kind === 'watch') setWatchDraftPresent(!!saved);
    setComposeErrors((old) => ({ ...old, [kind]: '' }));
  }
  async function readDraft(kind: ComposerKind) {
    const epoch=generation.current,saved=await client!.readComposerDraft(kind);
    if(epoch===generation.current)acceptDraft(kind,saved);
  }
  function persistDraft<K extends ComposerKind>(kind: K, value: ComposerValues[K]) {
    const epoch = generation.current;
    draftBaselines.current[kind] = JSON.stringify(value);
    const task = draftQueues.current[kind].then(async () => {
      if (epoch !== generation.current) throw Error('当前身份已变化。');
      if (draftBlocked.current[kind])
        throw Error('另一页面已保存不同的输入，请先处理当前草稿。');
      const saved = await client!.saveComposerDraft(kind, value, {
        expectedRevision: draftHeads.current[kind],
      });
      if (!saved) throw Error('本机输入尚未保存，请保留本页输入。');
      if (epoch !== generation.current) return saved;
      draftHeads.current[kind] = saved.revision;
      if (kind === 'watch') setWatchDraftPresent(true);
      setComposeErrors((old) => ({ ...old, [kind]: '' }));
      return saved;
    });
    draftQueues.current[kind] = task.then(
      () => undefined,
      () => undefined,
    );
    return task.catch((e) => {
      if (epoch === generation.current) {
        draftBlocked.current[kind] = true;
        setComposeErrors((old) => ({
          ...old,
          [kind]:
            '本机草稿尚未保存。本页输入仍在，请保存一份文件或读取另一页面已保存的输入。',
        }));
      }
      throw e;
    });
  }
  const acceptCurrentDraft=useEffectEvent(acceptDraft);
  useEffect(() => {
    if (!client) return;
    const epoch = generation.current;
    Promise.all([client.readComposerDraft('query'), client.readComposerDraft('watch')])
      .then(([queryDraft,watchDraft]) => {
        if (epoch === generation.current) {acceptCurrentDraft('query',queryDraft);acceptCurrentDraft('watch',watchDraft);setComposeReady(true);}
      })
      .catch((e) => {
        if (epoch === generation.current) setError(errorText(e));
      });
  }, [client]);
  useEffect(() => {
    if (!client || !runtime) return;
    const epoch = generation.current,
      read = ++searchRead.current,
      saved = restoredInformationSearch(window.history.state,searchOwner),
      request =
        saved
          ? saved
          : recentSearches.get(runtime)?.get(searchOwner);
    if (!request) return;
    client
      .query(request)
      .then((value) => {
        if (epoch === generation.current && read === searchRead.current)
          setPage(value);
      })
      .catch((e:unknown) => {
        if (epoch === generation.current && read === searchRead.current)
          setError(errorText(e));
      })
      .finally(() => {
        if (epoch === generation.current && read === searchRead.current)
          setSearchLoading(false);
      });
  }, [client, runtime, searchOwner]);
  const saveCurrentDraft=useEffectEvent((kind:ComposerKind)=>{
    const value=kind==='query'?queryValue():watchValue();
    if(composeReady&&(kind==='query'||!preview&&(selected.length>0||watchDraftPresent))&&JSON.stringify(value)!==draftBaselines.current[kind])void persistDraft(kind,value).catch(()=>{});
  });
  useEffect(() => {saveCurrentDraft('query');
  }, [
    query,
    types,
    windowKind,
    environment,
    functions,
    technologies,
    composeReady,
  ]);
  useEffect(() => {saveCurrentDraft('watch');
  }, [
    selected,
    selectionLabels,
    watchPurpose,
    expires,
    report,
    reportTime,
    editing,
    composeReady,
    preview,
    watchDraftPresent,
  ]);
  function draftProblem(kind: ComposerKind) {
    return (
      composeErrors[kind] && (
        <div className="message error" role="alert">
          <p>{composeErrors[kind]}</p>
          <button
            className="text-action"
            type="button"
            onClick={() =>
              download(
                kind === 'query' ? queryValue() : watchValue(),
                'galaxy-information-draft.json',
              )
            }
          >
            保存本页输入
          </button>
          <button
            className="text-action"
            type="button"
            onClick={() =>
              void run(async () => {
                await draftQueues.current[kind];
                await readDraft(kind);
              })
            }
          >
            读取已保存的输入
          </button>
        </div>
      )
    );
  }
  useEffect(() => {
    if (watchOpen || preview) composeDialog.current?.showModal();
    else composeDialog.current?.close();
  }, [watchOpen, preview]);
  useEffect(() => {
    if (detail) detailDialog.current?.showModal();
    else detailDialog.current?.close();
  }, [detail]);
  const refresh=async(valid: () => boolean, after?: string)=> {
    if (!client || !connected) return;
    const originals = await client.pending();
    if (!valid()) return;
    for (const operation of originals.filter((value) =>
      ['result-unknown', 'stopped-local'].includes(value.state),
    )) {
      try {
        const result = await client.reconcile(
          operation.command?.operationId ?? (operation.state==='stopped-local'?operation.operationId:''),
        );
        if (
          valid() &&
          result.state === 'acknowledged' &&
          operation.state === 'result-unknown' &&
          previewRef.current?.command.operationId ===
            operation.command.operationId
        ) {
          setPreview(null);
          setWatchOpen(false);
          showTab('watches');
          setNotice(
            (actionNames[operation.command.action] ?? '这次选择') + '已保存。',
          );
          await readDraft('watch');
        }
      } catch {}
      if (!valid()) return;
    }
    const [list, remaining] = await Promise.all([
      client.watches({ limit: 20, ...(after ? { after } : {}) }),
      client.pending(),
    ]);
    const previous =
      !after && watchesExpanded.current
        ? watchesRef.current.filter(
            (row) =>
              !list.items.some(
                (current) => current.watchId === row.watchId,
              ),
          )
        : [];
    const older = await Promise.allSettled(
      previous.map((row) => client.watches({ watchId: row.watchId })),
    );
    if (valid()) {
      setWatches((old) =>
        (after
          ? [...old, ...list.items]
          : [
              ...list.items,
              ...older.flatMap((result) =>
                result.status === 'fulfilled' ? result.value.items : [],
              ),
            ]
        ).filter(
          (row, index, all) =>
            all.findIndex((current) => current.watchId === row.watchId) ===
            index,
        ),
      );
      if (after) watchesExpanded.current = true;
      setWatchAfter(
        !after && watchesExpanded.current
          ? watchCursor.current
          : list.nextAfter,
      );
      setPending(remaining);
      setLoaded(true);
    }
  };
  async function run(fn: (valid: () => boolean) => Promise<unknown>) {
    if (working.current || !client) return;
    const epoch = generation.current,
      valid = () => epoch === generation.current;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn(valid);
    } catch (e) {
      if (valid()) setError(errorText(e));
    } finally {
      if (valid()) {
        if (connected)
          try {
            const value = await client.pending();
            if (valid()) setPending(value);
          } catch {}
        if (valid()) {
          working.current = false;
          setBusy(false);
        }
      }
    }
  }
  const initializeWatches=useEffectEvent(async(valid:()=>boolean)=>{
    await refresh(valid);
    if(watchId&&client){const value=await client.events(watchId);if(valid())setEvents(value);}
  });
  useEffect(() => {
    const epoch = generation.current,
      valid = () => generation.current === epoch;
    if (connected)
      initializeWatches(valid)
        .catch((e) => {
          if (valid()) {
            setLoaded(true);
            setError(errorText(e));
          }
        });
  }, [client, connected, watchId]);
  const detailRef = useRef(detail),
    eventsRef = useRef(events);
  useLayoutEffect(()=>{detailRef.current=detail;eventsRef.current=events;});
  const refreshLatest = useEffectEvent(refresh);
  useEffect(() => {
    if (!client || !connected) return;
    const epoch = generation.current,
      valid = () => generation.current === epoch;
    let checking = false,
      lastCheck = 0;
    const update = async () => {
      if (document.hidden || working.current || checking || !valid()) return;
      checking = true;
      try {
        const original = eventsRef.current;
        if (original) {
          try {
            const value = await client.events(original.watch.watchId);
            if (valid() && eventsRef.current === original) setEvents(value);
          } catch (e) {
            if (valid() && eventsRef.current === original) {
              setEvents(null);
              setError(errorText(e));
            }
          }
        }
        const opened = detailRef.current;
        if (opened?.selection) {
          try {
            const value = await client.query({
              purpose: '阅读当前选中的资料',
              sources: [opened.selection],
            });
            if (valid() && detailRef.current === opened)
              setDetail({ ...opened, page: value, unavailable: false });
          } catch {
            if (valid() && detailRef.current === opened)
              setDetail({ ...opened, page: null, unavailable: true });
          }
        }
        await refreshLatest(valid);
        if (Date.now() - lastCheck >= 60000) {
          const outcome = await client.checkDue();
          lastCheck = Date.now();
          if (
            valid() &&
            outcome.items.some((item) => item.state === 'check-failed')
          )
            setError('部分关注暂时无法读取，稍后会继续。');
        }
      } catch (e) {
        if (valid()) setError(errorText(e));
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void update(), 20000),
      visible = () => void update();
    document.addEventListener('visibilitychange', visible);
    void update();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client, connected]);
  function inputSources() {
    return informationSelections(types.map((type) => {
      const request:{query:string;limit:number;timeWindow?:{kind:string};context?:{environment:string}} = { query: query.trim(), limit: 8 };
      if (type === 'history') {
        request.timeWindow = { kind: windowKind };
        if (environment.trim())
          request.context = { environment: environment.trim() };
      }
      if (type === 'opportunity') {
        const tags = functions
            .split(/[,，\n]/)
            .map((value) => value.trim())
            .filter(Boolean),
          tech = technologies
            .split(/[,，\n]/)
            .map((value) => value.trim())
            .filter(Boolean);
        if (!tags.length) throw Error('请在筛选中填写想找的功能。');
        return {
          key: type,
          source: {
            kind: 'search',
            request: {
              type,
              query: {
                context: {
                  kind: 'ephemeral',
                  title: query.trim() || '查找相关项目',
                  functions: tags,
                  technologies: tech,
                },
                purposes: [
                  'conversation',
                  'reuse',
                  'collaboration',
                  'recruitment',
                ],
                limit: 8,
              },
            },
          },
        };
      }
      return {
        key: type,
        source: { kind: 'search', request: { type, query: request } },
      };
    }));
  }
  async function search(valid: () => boolean) {
    const read = ++searchRead.current;
    setSearchLoading(false);
    if (!types.length) throw Error('请至少保留一种资料。');
    await persistDraft('query', queryValue());
    if (!valid()) return;
    const request = {
        purpose: query.trim() || '查找可用资料',
        sources: inputSources(),
      },
      value = await client!.query(request);
    if (valid() && read === searchRead.current && runtime) {
      let saved = recentSearches.get(runtime);
      if (!saved) recentSearches.set(runtime, (saved = new Map()));
      saved.set(searchOwner, structuredClone(request));
      window.history.replaceState(
        {
          ...window.history.state,
          informationSearch: { owner: searchOwner, request },
        },
        '',
        window.location.href,
      );
      setPage(value);
      showTab('search');
    }
  }
  async function openItem(scope: InformationScope, item: InformationItem, valid: () => boolean) {
    const destination = itemLink(item);
    if (destination) {
      navigate(destination);
      return;
    }
    const selection = exactSelection(scope, item),
      value = await client!.query({
        purpose: '阅读当前选中的资料',
        sources: [selection],
      });
    if (valid())
      setDetail({ selection, page: value, title: item.title ?? '资料内容' });
  }
  function selectScope(selection: InformationSelection, title: string) {
    if (!connected) {
      chooseIdentity();
      return;
    }
    const same = selected.find(
      (value) =>
        JSON.stringify(value.source) === JSON.stringify(selection.source),
    );
    if (!same && selected.length >= 4) {
      setError('一份关注最多选择四项范围，请先移除不需要的范围。');
      return;
    }
    const key =
      same?.key ??
      'source_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
    if (!same) setSelected((old) => [...old, { ...selection, key }]);
    setSelectionLabels((old) => ({ ...old, [key]: title }));
    if (!watchPurpose) setWatchPurpose(query.trim() || title);
    if (!expires)
      setExpires(()=>localTime(Math.floor(Date.now() / 1000) + 7 * 86400));
    setWatchOpen(true);
    setDetail(null);
  }
  async function prepareAction(command: InformationCommand, valid: () => boolean) {
    let labels: Record<string, string> | null = null;
    if (command.plan) {
      const current = await client!.query({
        purpose: '查看这次关注的资料范围',
        sources: command.plan.sources,
      });
      if (!valid()) return;
      labels = Object.fromEntries(
        current.items.map((scope) => [
          scope.key,
          scope.source.kind === 'reference'
            ? (scope.items[0]?.title ?? scopeTitle(scope) + '（当前不可读）')
            : scopeTitle(scope),
        ]),
      );
    }
    const value = await client!.prepare(command);
    if (valid()) {
      if (value.state === 'acknowledged') {
        setNotice('这次选择已经保存。');
        showTab('watches');
        await refresh(valid);
        return;
      }
      if (labels) setSelectionLabels(labels);
      setPreview(value);
      setWatchOpen(true);
    }
  }
  async function commitPrepared(original: InformationPrepared, valid: () => boolean) {
    setPreview(original);
    setWatchOpen(true);
    await client!.execute(original.command.operationId, { confirmed: true });
    if (!valid()) return;
    setPreview(null);
    setWatchOpen(false);
    await readDraft('watch');
    if (!valid()) return;
    showTab('watches');
    setNotice(
      (
        {
          start: '已开始关注。',
          revise: '已保存更改。',
          pause: '已暂停关注。',
          resume: '已恢复关注。',
          end: '已结束关注。',
        } as Record<string, string>
      )[original.command.action] ?? '已保存。',
    );
    await refresh(valid);
  }
  async function saveWatchAction(command: InformationCommand, valid: () => boolean) {
    const original = await client!.prepare(command);
    if (valid()) await commitPrepared(original, valid);
  }
  async function prepareWatch(valid: () => boolean) {
    const deadline = Math.floor(new Date(expires).getTime() / 1000);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() / 1000)
      throw Error('请选择未来的截止时间。');
    if (!watchPurpose.trim()) throw Error('请为这份关注写一个名称。');
    const saved = await persistDraft('watch', watchValue());
    if (!valid()) return;
    const [h, m] = reportTime.split(':').map(Number),
      date = new Date();
    date.setHours(h, m, 0, 0);
    const original = await client!.prepare({
      operationId: crypto.randomUUID(),
      watchId: editing?.watchId ?? crypto.randomUUID(),
      expectedRevision: editing?.revision ?? 0,
      action: editing ? 'revise' : 'start',
      plan: {
        purpose: watchPurpose.trim(),
        sources: selected,
        expiresAt: deadline,
        report:
          report === 'daily'
            ? {
                mode: 'daily',
                utcMinute: date.getUTCHours() * 60 + date.getUTCMinutes(),
              }
            : { mode: 'changes' },
      },
    });
    if (!valid()) return;
    const remaining = await client!.clearComposerDraft('watch', {
      revision: saved.revision,
    });
    if (valid()) {
      draftHeads.current.watch = remaining?.revision ?? null;
      setWatchDraftPresent(!!remaining);
      await commitPrepared(original, valid);
    }
  }
  async function closeComposer(keepSelection = false) {
    if (busy) return;
    if (preview) {
      setPreview(null);
      setWatchOpen(false);
      showTab('watches');
      return;
    }
    await run(async (valid) => {
      if (
        keepSelection ||
        watchDraftPresent ||
        JSON.stringify(watchValue()) !== draftBaselines.current.watch
      )
        await persistDraft('watch', watchValue());
      else await readDraft('watch');
      if (valid()) setWatchOpen(false);
    });
  }
  async function discardWatchDraft(valid: () => boolean) {
    await draftQueues.current.watch;
    const remaining = await client!.clearComposerDraft('watch', {
      revision: draftHeads.current.watch,
    });
    if (!valid()) return;
    await readDraft('watch');
    if (valid()) {
      setWatchOpen(false);
      if (remaining) setNotice('另一页面保存的关注草稿仍保留。');
    }
  }
  async function editPreview(valid: () => boolean) {
    const original = preview;
    if (!original?.command.plan) return;
    const outcome = await client!.stopLocal(original.command.operationId, {
      onlyPrepared: true,
    });
    if (!valid()) return;
    if (outcome.state === 'stopped-local') {
      const plan = original.command.plan,
        d = new Date();
      if (plan.report.mode === 'daily')
        d.setUTCHours(
          Math.floor(plan.report.utcMinute / 60),
          plan.report.utcMinute % 60,
          0,
          0,
        );
      const value:WatchComposer = {
        selected: plan.sources,
        selectionLabels,
        watchPurpose: plan.purpose,
        expires: localTime(plan.expiresAt),
        report: plan.report.mode,
        reportTime:
          plan.report.mode === 'daily'
            ? String(d.getHours()).padStart(2, '0') +
              ':' +
              String(d.getMinutes()).padStart(2, '0')
            : reportTime,
        editing:
          original.command.action === 'revise'
            ? {
                watchId: original.command.watchId,
                revision: original.command.expectedRevision,
              }
            : null,
      };
      await persistDraft('watch', value);
      if (valid()) {
        applyDraft('watch', value);
        setPreview(null);
      }
    } else if (outcome.state === 'acknowledged') {
      await readDraft('watch');
      if (valid()) {
        setPreview(null);
        setWatchOpen(false);
        showTab('watches');
        setNotice('这次关注已保存。');
        await refresh(valid);
      }
    } else {
      setError('这次提交的结果还在确认中，收到结果后会自动更新。');
    }
  }
  async function editWatch(row: InformationWatch, valid: () => boolean) {
    if (watchDraftPresent) {
      setWatchOpen(true);
      if (editing?.watchId !== row.watchId)
        setNotice('先继续或放弃尚未完成的关注，已填写的内容仍保留。');
      return;
    }
    const current = await client!.query({
      purpose: '查看这次关注的资料范围',
      sources: row.plan.sources,
    });
    if (!valid()) return;
    const labels = Object.fromEntries(
        current.items.map((scope) => [
          scope.key,
          scope.source.kind === 'reference'
            ? (scope.items[0]?.title ?? scopeTitle(scope) + '（当前不可读）')
            : scopeTitle(scope),
        ]),
      ),
      d = new Date();
    if (row.plan.report.mode === 'daily')
      d.setUTCHours(
        Math.floor(row.plan.report.utcMinute / 60),
        row.plan.report.utcMinute % 60,
        0,
        0,
      );
    const value:WatchComposer = {
      selected: row.plan.sources,
      selectionLabels: labels,
      watchPurpose: row.plan.purpose,
      expires: localTime(row.plan.expiresAt),
      report: row.plan.report.mode,
      reportTime:
        row.plan.report.mode === 'daily'
          ? String(d.getHours()).padStart(2, '0') +
            ':' +
            String(d.getMinutes()).padStart(2, '0')
          : reportTime,
      editing: { watchId: row.watchId, revision: row.revision },
    };
    draftBaselines.current.watch = JSON.stringify(value);
    applyDraft('watch', value);
    setWatchOpen(true);
  }
  async function showEvents(row: InformationWatch, valid: () => boolean) {
    const value = await client!.events(row.watchId);
    if (valid()) {
      setEvents(value);
      showTab('watches');
    }
  }
  async function loadMore(scope: InformationScope, valid: () => boolean) {
    if(!scope.nextCursor||!page||scope.source.kind==='reference')return;
    const source = structuredClone(scope.source);
    if (source.kind === 'honor') source.request.after = scope.nextCursor;
    else if('query'in source.request)source.request.query.after = scope.nextCursor;
    const value = await client!.query({
      purpose: page.purpose,
      sources: [{ key: scope.key, source }],
    });
    if (valid())
      setPage((old) => old?({
        ...old,
        items: old.items.map((current) =>
          current.key === scope.key
            ? {
                ...value.items[0],
                items: [...current.items, ...value.items[0].items].filter(
                  (item, index, all) =>
                    all.findIndex(
                      (candidate) =>
                        candidate.id === item.id &&
                        candidate.sourceVersion === item.sourceVersion,
                    ) === index,
                ),
              }
            : current,
        ),
      }):old);
  }
  function watchCard(row: InformationWatch) {
    return (
      <article className="information-watch" key={row.watchId}>
        <header>
          <button onClick={() => void run((valid) => showEvents(row, valid))}>
            {row.plan.purpose}
          </button>
          <span>{stateNames[row.state] ?? '当前状态未提供'}</span>
        </header>
        <p>{row.plan.sources.map(scopeTitle).join(' · ')}</p>
        <small>至 {time(row.plan.expiresAt)}</small>
        <footer>
          <button
            className="text-action"
            disabled={busy}
            onClick={() => void run((valid) => showEvents(row, valid))}
          >
            查看资料与变化
            <ArrowRight size={14} />
          </button>
          {['active', 'paused'].includes(row.state) && (
            <button
              className="text-action"
              disabled={busy}
              onClick={() =>
                void run((valid) =>
                  saveWatchAction(
                    {
                      operationId: crypto.randomUUID(),
                      watchId: row.watchId,
                      expectedRevision: row.revision,
                      action: row.state === 'active' ? 'pause' : 'resume',
                    },
                    valid,
                  ),
                )
              }
            >
              {row.state === 'active' ? '暂停' : '恢复'}
            </button>
          )}
          <details className="information-watch-options">
            <summary>设置</summary>
            {row.state !== 'ended' && (
              <>
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() => void run((valid) => editWatch(row, valid))}
                >
                  调整范围与期限
                </button>
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() =>
                    void run((valid) =>
                      saveWatchAction(
                        {
                          operationId: crypto.randomUUID(),
                          watchId: row.watchId,
                          expectedRevision: row.revision,
                          action: 'end',
                        },
                        valid,
                      ),
                    )
                  }
                >
                  结束关注
                </button>
              </>
            )}
            <p>上次检查：{time(row.lastCheckedAt)}</p>
            {row.sourceCoverage?.some(
              (source) =>
                source.state === 'temporarily-unavailable' || !source.complete,
            ) && <p>部分来源暂时不可用或尚未读完。</p>}
          </details>
        </footer>
      </article>
    );
  }
  function resultScope(scope: InformationScope, withFollow = true) {
    return (
      <section className="information-result-group" key={scope.key}>
        <header>
          <h2>{scopeTitle(scope)}</h2>
          {withFollow && (
            <button
              className="text-action"
              disabled={busy}
              onClick={() =>
                selectScope(
                  { key: scope.key, source: scope.source },
                  (page?.purpose ?? query.trim()) + ' · ' + scopeTitle(scope),
                )
              }
            >
              <Bell size={15} />
              关注此范围
            </button>
          )}
        </header>
        {!scope.items?.length && (
          <p className="information-empty">
            {scope.state === 'temporarily-unavailable'
              ? '暂时无法读取，其他资料仍可查看。'
              : '当前没有可读的相关资料。'}
          </p>
        )}
        {(scope.items ?? []).map((item) => (
          <article className="information-result" key={item.id}>
            <h3>
              <button
                disabled={busy}
                onClick={() =>
                  void run((valid) => openItem(scope, item, valid))
                }
              >
                {item.title ?? '查看资料'}
              </button>
            </h3>
            <FactSummary item={item} />
            <footer>
              <button
                className="text-action"
                disabled={busy}
                onClick={() =>
                  void run((valid) => openItem(scope, item, valid))
                }
              >
                查看内容
                <ArrowRight size={14} />
              </button>
              {withFollow && (
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() =>
                    selectScope(
                      exactSelection(scope, item),
                      item.title ?? scopeTitle(scope),
                    )
                  }
                >
                  关注这项资料
                </button>
              )}
            </footer>
          </article>
        ))}
        {scope.nextCursor && withFollow && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run((valid) => loadMore(scope, valid))}
          >
            更多{scopeTitle(scope)}
          </Button>
        )}
      </section>
    );
  }
  const activePending = pending.filter(informationOperationActive);
  return (
    <section className="information-workspace" aria-busy={busy}>
      <header className="information-heading">
        <div>
          <h1>资料与关注</h1>
          <p>查找有用的资料，留意与你有关的变化。</p>
        </div>
      </header>
      <nav className="information-tabs" aria-label="资料与关注">
        <button
          aria-current={tab === 'search' ? 'page' : undefined}
          onClick={() => showTab('search')}
        >
          <Search size={17} />
          查找资料
        </button>
        <button
          aria-current={tab === 'watches' ? 'page' : undefined}
          onClick={() => showTab('watches')}
        >
          <Bell size={17} />
          我的关注
        </button>
      </nav>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <output className="information-notice">
          {notice}
        </output>
      )}
      {watchDraftPresent && !watchOpen && !preview && (
        <p className="information-draft">
          <span>有一份尚未完成的关注</span>
          <button className="text-action" onClick={() => setWatchOpen(true)}>
            继续填写
          </button>
        </p>
      )}
      {tab === 'search' ? (
        <>
          <form
            className="information-search"
            aria-busy={!composeReady}
            onSubmit={(event) => {
              event.preventDefault();
              void run(search);
            }}
          >
            <label htmlFor={inputId+'-query'}>
                    想查找什么？
              <div>
                <Input id={inputId+'-query'}
                  disabled={!composeReady}
                  maxLength={200}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="输入问题、方法或相关关键词"
                />
                <Button
                  type="submit"
                  disabled={busy || !client || !composeReady}
                >
                  <Search size={17} />
                  查找
                </Button>
              </div>
            </label>
            <div className="information-types">
              {Object.entries(sourceNames)
                .filter(([key]) => key !== 'honor')
                .map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      disabled={!composeReady}
                      checked={types.includes(key)}
                      onChange={(event) =>
                        setTypes((old) =>
                          event.target.checked
                            ? [...old, key]
                            : old.filter((value) => value !== key),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
            </div>
            <details
              className="information-filters"
              open={types.includes('opportunity') ? true : undefined}
            >
              <summary>更多筛选</summary>
              {types.includes('history') && (
                <>
                  <label>
                    经历时间
                    <select
                      value={windowKind}
                      onChange={(event) => setWindowKind(event.target.value)}
                    >
                      <option value="all-visible">全部可读经历</option>
                      <option value="90-days">最近 90 天</option>
                      <option value="365-days">最近一年</option>
                    </select>
                  </label>
                  <label htmlFor={inputId+'-environment'}>
                    使用环境
                    <Input id={inputId+'-environment'}
                      maxLength={160}
                      value={environment}
                      onChange={(event) => setEnvironment(event.target.value)}
                      placeholder="可选"
                    />
                  </label>
                </>
              )}
              {types.includes('opportunity') && (
                <>
                  <label htmlFor={inputId+'-functions'}>
                    想找的功能
                    <Input id={inputId+'-functions'}
                      value={functions}
                      onChange={(event) => setFunctions(event.target.value)}
                      placeholder="用逗号分隔"
                    />
                  </label>
                  <label htmlFor={inputId+'-technologies'}>
                    相关技术
                    <Input id={inputId+'-technologies'}
                      value={technologies}
                      onChange={(event) => setTechnologies(event.target.value)}
                      placeholder="可选，用逗号分隔"
                    />
                  </label>
                </>
              )}
            </details>
          </form>
          {draftProblem('query')}
          {searchLoading && !page ? (
            <PageLoading label="正在读取资料…" />
          ) : page ? (
            <div className="information-results">
              {page.purpose && (
                <p className="information-query-caption">
                  {page.purpose === '查找可用资料'
                    ? '当前可读的资料'
                    : '“' + page.purpose + '”的相关资料'}
                </p>
              )}
              {page.items.map((scope) => resultScope(scope))}
            </div>
          ) : (
            <p className="information-empty">
              从一个问题或关键词开始。也可以直接查找所选类型的当前资料。
            </p>
          )}
          <details
            className="information-honor"
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setHonorOpen(open);
              if (open && rules === null)
                void run(async (valid) => {
                  const value = await client!.rules();
                  if (valid())
                    setRules(
                      value.rules.filter(
                        (item) => item.sourceProfile === 'facts-v2',
                      ),
                    );
                });
            }}
          >
            <summary>查看某个人的荣誉依据</summary>
            {honorOpen && (
              <div>
                <label>
                  选择人物
                  <select
                    value={honorSubject}
                    onChange={(event) => setHonorSubject(event.target.value)}
                  >
                    <option value="">从当前资料中的人物选择</option>
                    {visibleSubjects.map((id) => (
                      <option key={id} value={id}>
                        {person(id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  荣誉
                  <select
                    value={rule}
                    onChange={(event) => setRule(event.target.value)}
                  >
                    <option value="">选择一项荣誉</option>
                    {rules?.map((item) => (
                      <option key={ruleKey(item)} value={ruleKey(item)}>
                        {item.name ?? item.title ?? '荣誉'} · 第{' '}
                        {item.version ?? item.ruleVersion} 版
                      </option>
                    ))}
                  </select>
                </label>
                {rules && !rules.length && <p>当前没有可用的荣誉规则。</p>}
                <Button
                  disabled={busy || !rule || !honorSubject}
                  onClick={() =>
                    void run(async (valid) => {
                      const chosen=rules?.find(item=>ruleKey(item)===rule),ruleId=chosen?.id??chosen?.ruleId,ruleVersion=chosen?.version??chosen?.ruleVersion;
                      if(!ruleId||!ruleVersion)throw Error('这项荣誉的准确规则版本暂时不可用。');
                      const value = await client!.query({
                          purpose: query.trim() || '查看所选荣誉的依据',
                          sources: [
                            {
                              key: 'honor',
                              source: {
                                kind: 'honor',
                                request: {
                                  subjectId: honorSubject,
                                  ruleId,ruleVersion,
                                  limit: 8,
                                },
                              },
                            },
                          ],
                        });
                      if (valid()) setPage(value);
                    })
                  }
                >
                  查看依据
                </Button>
              </div>
            )}
          </details>
        </>
      ) : (
        <>
          {!connected ? (
            <div className="information-empty">
              <p>使用自己的身份，保存想关注的资料。</p>
              <Button onClick={chooseIdentity}>继续使用</Button>
            </div>
          ) : !loaded ? (
            <PageLoading label="正在读取关注…" />
          ) : (
            <>
              {events ? (
                <article className="information-watch-detail">
                  <button
                    className="text-action"
                    onClick={() => setEvents(null)}
                  >
                    ← 返回我的关注
                  </button>
                  <header>
                    <h2>{events.watch.plan.purpose}</h2>
                    <span>
                      {stateNames[events.watch.state] ?? '当前状态未提供'}
                    </span>
                  </header>
                  {events.current.items.map((scope) =>
                    resultScope(scope, false),
                  )}
                  <details className="information-source-details">
                    <summary>变化记录</summary>
                    {!events.events.length ? (
                      <p>还没有新的变化。</p>
                    ) : (
                      events.events.map((event) => (
                        <article key={event.id}>
                          <time>{time(event.at)}</time>
                          <p>
                            {event.changes
                              .map((change) =>
                                change.kind === 'no-longer-in-current-scope'
                                  ? '有资料不再出现在当前范围'
                                  : change.kind ===
                                      'current-source-recheck-required'
                                    ? '有资料需要按当前权限重新读取'
                                    : '资料内容或可见版本有变化',
                              )
                              .join('；')}
                          </p>
                        </article>
                      ))
                    )}
                  </details>
                </article>
              ) : (
                <>
                  <p className="information-footnote">
                    网页打开且可见时会检查变化；关闭网页后，这个页面不会继续运行。
                  </p>
                  {!watches.length && (
                    <div className="information-empty">
                      <h2>还没有关注</h2>
                      <p>找到有用的资料后，可以选择关注。</p>
                      <Button
                        variant="outline"
                        onClick={() => showTab('search')}
                      >
                        去查找资料
                      </Button>
                    </div>
                  )}
                  {watches
                    .filter((row) => !['ended', 'expired'].includes(row.state))
                    .map(watchCard)}
                  {watches.some((row) =>
                    ['ended', 'expired'].includes(row.state),
                  ) && (
                    <details className="information-previous-watches">
                      <summary>以前的关注</summary>
                      {watches
                        .filter((row) =>
                          ['ended', 'expired'].includes(row.state),
                        )
                        .map(watchCard)}
                    </details>
                  )}
                  {watchAfter && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run((valid) => refresh(valid, watchAfter))
                      }
                    >
                      更早的关注
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {!!activePending.length && (
            <section className="information-pending">
              {activePending.map((operation) => (
                <article key={operation.command.operationId}>
                  <p>
                    {operation.state === 'prepared'
                      ? '还有一份未确认的选择'
                      : '正在确认是否保存成功'}
                    {operation.command.plan?.purpose
                      ? '：' + operation.command.plan.purpose
                      : ''}
                  </p>
                  <button
                    className="text-action"
                    disabled={busy}
                    onClick={() =>
                      void run((valid) =>
                        prepareAction(operation.command, valid),
                      )
                    }
                  >
                    查看这次选择
                  </button>
                  {operation.state === 'prepared' && (
                    <button
                      className="text-action"
                      disabled={busy}
                      onClick={() =>
                        void run(async (valid) => {
                          const result = await client!.stopLocal(
                            operation.command.operationId,
                            { onlyPrepared: true },
                          );
                          if (valid())
                            setNotice(
                              result.state === 'stopped-local'
                                ? '这次选择已取消。'
                                : result.state === 'acknowledged'
                                  ? '这次选择已经保存。'
                                  : '这次选择已提交，正在确认保存结果。',
                            );
                          await refresh(valid);
                        })
                      }
                    >
                      取消这次选择
                    </button>
                  )}
                </article>
              ))}
            </section>
          )}
        </>
      )}
      <dialog
        ref={detailDialog}
        className="workspace-dialog information-dialog"
        onCancel={() => setDetail(null)}
      >
        {detail && (
          <>
            <header className="dialog-heading">
              <h2>{detail.title}</h2>
              <button
                className="icon-button"
                aria-label="关闭资料"
                onClick={() => setDetail(null)}
              >
                <X size={19} />
              </button>
            </header>
            {detail.unavailable ? (
              <p>这份资料暂时不可读。</p>
            ) : (
              detail.page?.items.map((scope) => (
                <section key={scope.key}>
                  {!scope.items.length && <p>当前无法读取这份资料。</p>}
                  {scope.items.map((item) => (
                    <article key={item.id}>
                      <FactSummary item={item} full />
                      {item.type === 'history' && (
                        <HistoryFacts
                          record={item.record}
                          navigate={navigate}
                        />
                      )}
                      {itemLink(item) && (
                        <Button
                          variant="outline"
                          onClick={() => navigate(itemLink(item)!)}
                        >
                          阅读全文
                          <ArrowRight size={15} />
                        </Button>
                      )}
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() =>
                          selectScope(
                            exactSelection(scope, item),
                            item.title ?? detail.title,
                          )
                        }
                      >
                        关注这项资料
                      </button>
                    </article>
                  ))}
                </section>
              ))
            )}
          </>
        )}
      </dialog>
      <dialog
        ref={composeDialog}
        className="workspace-dialog information-dialog"
        onCancel={(event) => {
          event.preventDefault();
          void closeComposer();
        }}
      >
        {(watchOpen || preview) && (
          <>
            <header className="dialog-heading">
              <h2>
                {preview
                  ? (actionNames[preview.command.action] ?? '确认选择')
                  : editing
                    ? '调整关注'
                    : '关注这些资料'}
              </h2>
              <button
                className="icon-button"
                disabled={busy}
                aria-label="关闭关注编辑"
                onClick={() => void closeComposer()}
              >
                <X size={19} />
              </button>
            </header>
            {error && (
              <p role="alert" className="message error">
                {error}
              </p>
            )}
            {preview ? (
              <div className="information-watch-preview">
                {preview.command.plan ? (
                  <>
                    <h3>{preview.command.plan.purpose}</h3>
                    <ul>
                      {preview.command.plan.sources.map((scope) => (
                        <li key={scope.key}>
                          {selectionLabels[scope.key] ?? scopeTitle(scope)}
                        </li>
                      ))}
                    </ul>
                    <p>至 {time(preview.command.plan.expiresAt)}</p>
                    <p>
                      {preview.command.plan.report.mode === 'daily'
                        ? '每天在所选时刻汇总实际变化'
                        : '发现变化时提醒'}
                    </p>
                  </>
                ) : (
                  <>
                    <h3>
                      {watches.find(
                        (row) => row.watchId === preview.command.watchId,
                      )?.plan.purpose ?? '这份关注'}
                    </h3>
                    <p>
                      {preview.command.action === 'pause'
                        ? '暂停后不再检查这个范围，已有记录保留。'
                        : preview.command.action === 'end'
                          ? '结束这份关注并保留已有记录。'
                          : '按原来选定的范围和期限继续。'}
                    </p>
                  </>
                )}
                <p className="information-footnote">
                  网页打开且可见时执行。没有变化时不提醒。
                </p>
                <div className="button-row">
                  <Button
                    disabled={busy || !connected}
                    onClick={() =>
                      void run((valid) => commitPrepared(preview, valid))
                    }
                  >
                    {actionNames[preview.command.action] ?? '确认'}
                  </Button>
                  {preview.command.plan && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run(editPreview)}
                    >
                      修改选择
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void closeComposer()}
                  >
                    稍后继续
                  </Button>
                </div>
              </div>
            ) : (
              <form
                className="information-watch-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(prepareWatch);
                }}
              >
                <fieldset disabled={busy || !composeReady}>
                  {notice && (
                    <output className="information-notice">
                      {notice}
                    </output>
                  )}
                  {draftProblem('watch')}
                  <label htmlFor={inputId+'-watchPurpose'}>
                    关注名称
                    <Input id={inputId+'-watchPurpose'}
                      required
                      maxLength={300}
                      value={watchPurpose}
                      onChange={(event) => setWatchPurpose(event.target.value)}
                    />
                  </label>
                  <section className="information-selected">
                    <h3>关注范围</h3>
                    {selected.map((scope, index) => (
                      <div key={scope.key}>
                        <span>
                          {selectionLabels[scope.key] ?? scopeTitle(scope)}
                        </span>
                        <button
                          className="text-action"
                          type="button"
                          onClick={() =>
                            setSelected((old) =>
                              old.filter((_, i) => i !== index),
                            )
                          }
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="text-action"
                      onClick={() =>
                        void closeComposer(true).then(() => showTab('search'))
                      }
                    >
                      <Plus size={14} />
                      再选一些资料
                    </button>
                  </section>
                  <label htmlFor={inputId+'-expires'}>
                    关注到什么时候
                    <Input id={inputId+'-expires'}
                      type="datetime-local"
                      required
                      min={minimumExpiry}
                      step={1}
                      value={expires}
                      onChange={(event) => setExpires(event.target.value)}
                    />
                  </label>
                  <label>
                    提醒方式
                    <select
                      value={report}
                      onChange={(event) => setReport(event.target.value==='daily'?'daily':'changes')}
                    >
                      <option value="changes">有变化时提醒</option>
                      <option value="daily">每天汇总变化</option>
                    </select>
                  </label>
                  {report === 'daily' && (
                    <label htmlFor={inputId+'-reportTime'}>
                    每天的汇总时间
                      <Input id={inputId+'-reportTime'}
                        required
                        type="time"
                        value={reportTime}
                        onChange={(event) => setReportTime(event.target.value)}
                      />
                      <small>按当前时区设置；没有变化时不发送。</small>
                    </label>
                  )}
                  <p className="information-footnote">
                    此页面关闭后不会继续检查。关注仅保存到你的私有空间。
                  </p>
                  <div className="button-row">
                    <Button type="submit" disabled={!selected.length || busy}>
                      {editing ? '保存更改' : '开启关注'}
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => void closeComposer()}
                    >
                      稍后继续
                    </Button>
                    <button
                      className="text-action"
                      type="button"
                      onClick={() => void run(discardWatchDraft)}
                    >
                      放弃这次编辑
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
          </>
        )}
      </dialog>
    </section>
  );
}
