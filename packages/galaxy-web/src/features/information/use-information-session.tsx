import { independentMaterialLabel } from "../tasks/materials/task-material-client.mjs";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { createInformationClientV2 } from "./client.mjs";
import { memberName, useMemberNames } from "../../shared/people/conversation-ui";

import { informationField, informationError as errorText, informationLocalTime as localTime, restoredInformationSearch, informationSelections } from "./state";
import type { InformationQuery, InformationSelection, InformationScope, InformationItem, InformationPage, InformationWatch, InformationEvents, InformationOperation, InformationPrepared, InformationCommand, InformationDetail, InformationEditing, InformationClient, HonorRule, ComposerKind, ComposerValues, ComposerDraft, QueryComposer, WatchComposer } from "./state";
import { actionNames, scopeTitle, itemLink, exactSelection, download } from "./presentation";
import type { InformationWorkspaceProps } from "./state";
// Completed queries are re-read under the current permission lease.
const recentSearches = new WeakMap<object, Map<string, InformationQuery>>();
export function useInformationSession({runtime,subjectId,connected,navigate,onNeedIdentity,watchId}:InformationWorkspaceProps) {
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
      setDetail({ selection, page: value, title: independentMaterialLabel(item,'资料内容') });
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
  return {
    client,
    tab,
    query,
    setQuery,
    types,
    setTypes,
    windowKind,
    setWindowKind,
    environment,
    setEnvironment,
    functions,
    setFunctions,
    technologies,
    setTechnologies,
    searchLoading,
    page,
    setPage,
    detail,
    setDetail,
    selected,
    setSelected,
    selectionLabels,
    watchPurpose,
    setWatchPurpose,
    expires,
    setExpires,
    report,
    setReport,
    reportTime,
    setReportTime,
    editing,
    watchOpen,
    setWatchOpen,
    preview,
    watches,
    watchAfter,
    events,
    setEvents,
    pending,
    honorOpen,
    setHonorOpen,
    rules,
    setRules,
    rule,
    setRule,
    honorSubject,
    setHonorSubject,
    busy,
    loaded,
    error,
    notice,
    setNotice,
    composeReady,
    watchDraftPresent,
    composeDialog,
    detailDialog,
    inputId,
    minimumExpiry,
    visibleSubjects,
    person,
    showTab,
    chooseIdentity,
    draftProblem,
    refresh,
    run,
    search,
    openItem,
    selectScope,
    prepareAction,
    commitPrepared,
    saveWatchAction,
    prepareWatch,
    closeComposer,
    discardWatchDraft,
    editPreview,
    editWatch,
    showEvents,
    loadMore,
    runtime,
    subjectId,
    connected,
    navigate,
    watchId,
  };
}
export type InformationSessionModel=ReturnType<typeof useInformationSession>;
