import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createTaskContactClient,
  contactCandidates,
} from './task-contact-client.mjs';

type Props = {
  task: any;
  runtime: any;
  subjectId: string;
  connected: boolean;
  navigate: (path: string) => void;
  refresh: () => Promise<any>;
  section?: 'contacts' | 'rooms';
};
const labels: Record<string, string> = {
  queued: '尚未发送',
  sending: '正在发送',
  acknowledged: '服务已记录',
  'result-unknown': '结果待核对',
  'stopped-unsent': '已取消未发送项',
  'stopped-local': '已停止本机重试，服务端取消未确认',
  creating: '房间创建待核对',
  'waiting-for-members': '等待已邀者回应后按当前成员继续',
};
export function TaskContactWorkspace({
  task,
  runtime,
  subjectId,
  connected,
  navigate,
  refresh,
  section = 'contacts',
}: Props) {
  const client = useMemo(
    () => createTaskContactClient(runtime, task.taskId),
    [runtime, task.taskId, subjectId],
  );
  const [pages, setPages] = useState<any[]>([]),
    [candidates, setCandidates] = useState<any[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState(''),
    [functions, setFunctions] = useState<string>(
      task.request.capabilityId ?? '',
    );
  const [batch, setBatch] = useState<any>(null),
    [roomBatch, setRoomBatch] = useState<any>(null);
  const [roomProgress, setRoomProgress] = useState<any[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [queried, setQueried] = useState(false);
  const [roomChoices, setRoomChoices] = useState<string[]>([]),
    [mode, setMode] = useState(''),
    [rooms, setRooms] = useState<any[]>([]);
  const [scan, setScan] = useState(0),
    [next, setNext] = useState<string | null>(null),
    [roomsLoaded, setRoomsLoaded] = useState(false);
  const active = useRef(0),
    working = useRef(false),
    lookedUp = useRef(false);
  const requester = task.requesterId === subjectId;
  const saved = task.contacts?.suggestions.items ?? [];
  const interested = [
    ...new Set<string>([
      ...(task.contacts?.responses.applications ?? [])
        .filter((a: any) => a.state === 'pending')
        .map((a: any) => a.subjectId),
      ...(task.contacts?.responses.invitations ?? [])
        .filter((i: any) => i.state === 'interested')
        .map((i: any) => i.recipientId),
      ...(task.participations ?? [])
        .filter((p: any) =>
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
        )
        .map((p: any) => p.subjectId),
      ...((task.participations ?? []).some(
        (p: any) =>
          p.subjectId === subjectId &&
          ['active', 'delivered', 'accepted', 'disputed'].includes(p.state),
      )
        ? [task.requesterId]
        : []),
    ]),
  ].filter((id) => id !== subjectId);
  const toggled = (items: string[], id: string) =>
    items.includes(id) ? items.filter((value) => value !== id) : [...items, id];
  async function reloadLocal(lease = active.current) {
    const [a, b] = await Promise.all([client.pending(), client.pendingRooms()]);
    if (lease === active.current) {
      setBatch(a);
      setRoomBatch(b);
    }
  }
  async function run(fn: (lease: number) => Promise<any>) {
    if (working.current) return;
    const lease = active.current;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn(lease);
      if (lease === active.current) {
        await reloadLocal(lease);
        await refresh();
      }
    } catch (reason: any) {
      if (lease === active.current)
        setError(typeof reason?.message === 'string' && reason.message.trim() ? reason.message : '联系操作暂未完成，请查询原操作后再继续。');
    } finally {
      if (lease === active.current) {
        await reloadLocal(lease);
        setBusy(false);
      }
      working.current = false;
    }
  }
  async function lookup(lease: number, type: string | null = null) {
    const old = pages.find((page) => page.type === type),
      functionsList = functions
        .split(/[,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean);
    const result = await client.search(task, {
      keyword,
      functions: functionsList,
      only: type,
      after: type && old?.nextCursor ? { [type]: old.nextCursor } : {},
    });
    if (lease !== active.current) return;
    const merged = type
      ? pages.map((page) =>
          page.type === type
            ? { ...result[0], items: [...page.items, ...result[0].items] }
            : page,
        )
      : result;
    setPages(merged);
    setCandidates(contactCandidates(merged, subjectId));
    setSelected([]);
    setQueried(true);
  }
  async function loadRooms(lease: number, after = '') {
    let result;
    try {
      result = await client.rooms(after);
    } catch (reason) {
      if (lease === active.current) {
        setRooms([]);
        setRoomProgress([]);
        setRoomsLoaded(false);
      }
      throw reason;
    }
    if (lease !== active.current) return;
    setRooms((old) =>
      after
        ? [
            ...new Map(
              [...old, ...result.rooms].map((room) => [room.roomId, room]),
            ).values(),
          ]
        : result.rooms,
    );
    setScan((old) => (after ? old + result.scanned : result.scanned));
    setNext(result.next);
    setRoomsLoaded(true);
    const progress = await client.roomProgress();
    if (lease === active.current) setRoomProgress(progress);
  }
  useEffect(() => {
    active.current++;
    lookedUp.current = false;
    setPages([]);
    setCandidates([]);
    setSelected([]);
    setBatch(null);
    setRoomBatch(null);
    setRooms([]);
    setRoomProgress([]);
    setRoomsLoaded(false);
    setScan(0);
    setNext(null);
    setError('');
    setNotice('');
    setQueried(false);
    setRoomChoices([]);
    if (connected) reloadLocal().catch((e: any) => setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '任务联系人状态暂未读取成功，请稍后重试。'));
    return () => {
      active.current++;
    };
  }, [client, connected]);
  useEffect(
    () =>
      runtime.onTaskOperationStopped((event: any) => {
        if (event.scopeTaskId === task.taskId)
          reloadLocal().catch((e: any) => setError(typeof e?.message === 'string' && e.message.trim() ? e.message : '任务联系人状态暂未读取成功，请稍后重试。'));
      }),
    [client],
  );
  useEffect(() => {
    if (!connected || section !== 'contacts' || !requester || lookedUp.current)
      return;
    lookedUp.current = true;
    // Re-entering a task must show the current default contact list as well.
    // A prior suggestions request is only a saved snapshot; it must not suppress
    // a fresh, read-only lookup of currently visible facts and willingness.
    run((lease) => lookup(lease));
  }, [client, connected, requester, section]);
  useEffect(() => {
    if (connected && section === 'rooms') {
      const lease = active.current;
      loadRooms(lease).catch((e: any) => {
        if (lease === active.current) setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');
      });
    }
  }, [client, connected, section]);
  useEffect(() => {
    if (!client || !connected) return;
    let mounted=true, reading=false;
    const refresh = () => {
      if (!mounted || reading || working.current || document.visibilityState !== 'visible' || active.current < 1) return;
      reading=true;
      const lease = active.current;
      // Pending receipts can change in another tab. Do not replace a paginated
      // room directory or discard the user's current selections on a timer.
      const operation = reloadLocal(lease);
      operation.catch((e: any) => {
        if (mounted && lease === active.current) setError(typeof e?.message==='string'&&e.message.trim()?e.message:'操作暂未完成，请稍后重试。');
      }).finally(()=>{reading=false;});
    };
    const timer = window.setInterval(refresh, 20000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted=false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [client, connected, section]);
  function update(id: string, field: string, value: string) {
    setCandidates((items) =>
      items.map((item) =>
        item.subjectId === id ? { ...item, [field]: value } : item,
      ),
    );
  }
  async function prepare(items: any[]) {
    setBatch(
      await client.prepareInvites(
        items.map((item) => ({ subjectId: item.subjectId, note: item.help })),
      ),
    );
    setNotice('逐人内容已保存在本机，尚未发出。请检查下方批次后一次确认发送。');
  }
  if (!connected) return null;
  return (
    <section className="task-contact-workspace">
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="message" role="status">
          {notice}
        </div>
      )}
      {requester && section === 'contacts' && (
        <>
          <h2>建议联系清单</h2>
          <p>
            任务已经发布。这里查询当前允许读取的工作事实与明确交流意愿，由你判断适合的帮助；不会自动邀请，也不把没有履历理解为没有能力。
          </p>
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              run((lease) => lookup(lease));
            }}
          >
            <label>
              经历关键词（可空，最多八个词）
              <Input
                maxLength={200}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="按当前可见原文筛选，不生成语义评分"
              />
            </label>
            <label>
              想交流的功能（逗号分隔，可与经历查询独立）
              <Input
                value={functions}
                onChange={(e) => setFunctions(e.target.value)}
                placeholder="例如：自动化测试、任务协作"
              />
            </label>
            <p className="muted">
              {task.request.capabilityId
                ? `经历限定能力字段：${task.request.capabilityId}。`
                : '当前没有限定能力字段；经历查询结果只是可供检查的事实。'}{' '}
              功能意愿来自本人声明，不要求已有成功案例。未填功能时，只查询经历。
            </p>
            <Button type="submit" disabled={busy}>
              查询当前清单
            </Button>
          </form>
          {pages.map((page) => (
            <div key={page.type} className="message">
              <p>
                {page.type === 'history'
                  ? '可见工作事实'
                  : '项目、功能与交流意愿'}
                ：
                {page.error
                  ? `暂不可用：${page.error}`
                  : `本次已读取 ${page.items.length} 条来源。`}
              </p>
              {page.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => run((lease) => lookup(lease, page.type))}
                >
                  继续这一来源的下一页
                </Button>
              )}
            </div>
          ))}
          {queried && !candidates.length && (
            <div className="empty-state">
              这次可见范围中没有可列出的他人作者。任务仍在等待申请；可以换功能、继续下一页，或保留开放／赏金协助等待新参与者。空结果不表示没有合适的人。
            </div>
          )}
          {candidates.map((candidate) => (
            <article className="task-card" key={candidate.subjectId}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(candidate.subjectId)}
                  onChange={() =>
                    setSelected(toggled(selected, candidate.subjectId))
                  }
                />{' '}
                {candidate.displayName ?? candidate.subjectId}
              </label>
              <p>
                来源中记录的角色：{candidate.roles.join('、')}。
                {candidate.willingness ?? '当前意愿与可投入时间未知。'}
              </p>
              {(task.contacts?.responses.applications ?? []).some(
                (a: any) => a.subjectId === candidate.subjectId,
              ) && (
                <p className="muted">
                  此人也有实际申请，请在下方回应区核对原申请。
                </p>
              )}
              <details>
                <summary>核对原始来源及精确版本</summary>
                {candidate.sources.map((source: any) => (
                  <article key={source.item.type + source.item.id}>
                    <h4>{source.item.title}</h4>
                    <p>{source.item.summary}</p>
                    <code>
                      {source.item.ref.id} @ {source.item.ref.version}
                    </code>
                    <pre className="code-block">
                      {JSON.stringify(source.item.record, null, 2)}
                    </pre>
                  </article>
                ))}
              </details>
              <label>
                希望获得什么帮助
                <Textarea
                  maxLength={1500}
                  value={candidate.help}
                  onChange={(e) =>
                    update(candidate.subjectId, 'help', e.target.value)
                  }
                />
              </label>
              <label>
                你为什么选择此人
                <Textarea
                  maxLength={1500}
                  value={candidate.basis}
                  onChange={(e) =>
                    update(candidate.subjectId, 'basis', e.target.value)
                  }
                />
              </label>
              <label>
                仍需确认的条件
                <Textarea
                  maxLength={1500}
                  value={candidate.conditions}
                  onChange={(e) =>
                    update(candidate.subjectId, 'conditions', e.target.value)
                  }
                />
              </label>
            </article>
          ))}
          {!!candidates.length && (
            <div className="button-row">
              <Button
                disabled={busy || !selected.length}
                onClick={() =>
                  run(async () => {
                    await client.saveSuggestions(
                      candidates.filter((item) =>
                        selected.includes(item.subjectId),
                      ),
                      { confirmed: true },
                    );
                    setNotice('所选建议及依据已私有保存，尚未邀请。');
                  })
                }
              >
                保存所选建议与依据
              </Button>
              <Button
                variant="outline"
                disabled={busy || !selected.length}
                onClick={() =>
                  run(() =>
                    prepare(
                      candidates.filter((item) =>
                        selected.includes(item.subjectId),
                      ),
                    ),
                  )
                }
              >
                预览所选对象的独立邀请
              </Button>
            </div>
          )}
          {!!saved.length && (
            <details open>
              <summary>此任务已保存的建议（私有）</summary>
              <p className="muted">
                这是以前选择时的依据，当前可读性和意愿以重新查询及本人回应为准。
              </p>
              {saved.map((item: any) => (
                <article className="task-card" key={item.subjectId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(item.subjectId)}
                      onChange={() =>
                        setSelected(toggled(selected, item.subjectId))
                      }
                    />
                    {item.subjectId}
                  </label>
                  <p>{item.help}</p>
                  <p>选择依据：{item.basis}</p>
                  <p>{item.conditions}</p>
                  <details>
                    <summary>保存时的精确引用</summary>
                    <ul>
                      {item.sourceRefs.map((ref: string) => (
                        <li key={ref}>
                          <code>{ref}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !saved.some((item: any) => selected.includes(item.subjectId))
                }
                onClick={() =>
                  run(() =>
                    prepare(
                      saved.filter((item: any) =>
                        selected.includes(item.subjectId),
                      ),
                    ),
                  )
                }
              >
                预览所选已保存建议的邀请
              </Button>
            </details>
          )}
          {batch && (
            <div className="message">
              <h3>逐人发送预览与结果</h3>
              <p>
                只有下列对象会分别收到本人的内容。邀请七天与征集截止中较早到期，公开额度及未回应冷却继续适用。拒绝不会自动追发。
              </p>
              {batch.items.map((item: any) => (
                <article key={item.eventId}>
                  <h4>
                    {item.subjectId} · {labels[item.state]}
                  </h4>
                  <p>{item.note}</p>
                  <p>{new Date(item.expiresAt * 1000).toLocaleString()} 到期</p>
                  {item.error && <p>{item.error}</p>}
                  {item.state === 'queued' && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setBatch(await client.stopUnsent(item.eventId)),
                        )
                      }
                    >
                      取消这个未发送对象
                    </Button>
                  )}
                </article>
              ))}
              {batch.items.some(
                (item: any) =>
                  !['acknowledged', 'stopped-unsent', 'stopped-local'].includes(
                    item.state,
                  ),
              ) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      setBatch(await client.sendInvites({ confirmed: true }));
                      setNotice(
                        '逐人结果已更新。未知操作先核对原回执，尚未发送者保持独立。',
                      );
                    })
                  }
                >
                  {batch.confirmed
                    ? '先核对原操作，再继续本批'
                    : '确认逐人内容并发送本批'}
                </Button>
              )}
              <p className="muted">
                若原 Consent
                已失效，请使用任务的原操作恢复区审阅续签；不会静默更换邀请 ID
                或授权范围。
              </p>
            </div>
          )}
        </>
      )}
      {section === 'rooms' && (
        <>
          <h2>为这次工作选择沟通方式</h2>
          <p>
            分别交流与共同房间都可选。共同房间只共享以后主动发送的内容，不复制私聊、报价或
            Context；每位被邀者仍自行决定是否加入。同房邀请按成员变化分步继续，下一位加入须遵循当前成员的共同决定。
          </p>
          {interested.map((id) => (
            <label key={id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={roomChoices.includes(id)}
                onChange={() => setRoomChoices(toggled(roomChoices, id))}
              />
              {id}
            </label>
          ))}
          {!interested.length && (
            <p className="muted">
              目前没有可供这一流程选择的真实意愿回应、申请或实际参与者。你仍可在下方创建自己的讨论房间，也可独立进入普通聊天。
            </p>
          )}
          <label>
            本次沟通方式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">请选择本次方式</option>
              <option value="separate">分别建立沟通房间</option>
              <option value="together">共同房间，逐人邀请</option>
            </select>
          </label>
          <Button
            variant="outline"
            disabled={busy || !mode || !roomChoices.length}
            onClick={() =>
              run(async () => {
                setRoomBatch(await client.prepareRooms(mode, roomChoices));
                setNotice(
                  '沟通计划仅保存到本机；请查看逐房间、逐人清单再确认。',
                );
              })
            }
          >
            预览本次房间安排
          </Button>
          {roomBatch && (
            <div className="message">
              <h3>
                {roomBatch.mode === 'separate' ? '分别交流' : '共同房间'} ·
                待确认安排与结果
              </h3>
              {roomBatch.rooms.map((entry: any) => (
                <article key={entry.input.roomId}>
                  <p>
                    {entry.input.title} · {labels[entry.state]}
                  </p>
                  {entry.invitations.map((invitation: any) => (
                    <p key={invitation.decisionId}>
                      {invitation.subjectId}：{labels[invitation.state]}
                      {invitation.receipt ? '，加入须由对方确认' : ''}
                    </p>
                  ))}
                  {entry.error && <p>{entry.error}</p>}
                  {entry.created && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigate(`/app/rooms/${entry.input.roomId}`)
                      }
                    >
                      打开此房间及其当前决定
                    </Button>
                  )}
                </article>
              ))}
              {roomBatch.rooms.some(
                (entry: any) => entry.state !== 'acknowledged',
              ) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async (lease) => {
                      setRoomBatch(await client.sendRooms({ confirmed: true }));
                      await loadRooms(lease);
                    })
                  }
                >
                  确认安排／恢复原房间操作
                </Button>
              )}
            </div>
          )}
          {roomBatch?.rooms.every(
            (entry: any) =>
              !entry.created &&
              entry.state === 'queued' &&
              entry.invitations.every(
                (invitation: any) =>
                  invitation.state === 'queued' && !invitation.input,
              ),
          ) && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await client.cancelPreparedRooms();
                  setRoomBatch(null);
                  setNotice(
                    '未发送的房间预览已取消，没有创建房间或邀请任何人。',
                  );
                })
              }
            >
              取消尚未发送的房间预览
            </Button>
          )}
          {roomProgress.map((progress) => (
            <article className="task-card" key={progress.roomId}>
              <h3>房间当前参与情况</h3>
              {progress.unavailable ? (
                <p>当前无法核对这个房间，不继续显示旧成员。</p>
              ) : (
                <>
                  <p>
                    现有成员：
                    {progress.current.members
                      .map((member: any) => member.subjectId)
                      .join('、')}
                  </p>
                  {progress.invitations.map((invitation: any) => (
                    <p key={invitation.subjectId}>
                      {invitation.subjectId}：
                      {invitation.joined
                        ? '已经自行加入'
                        : invitation.state === 'members-changed'
                          ? '成员已变化，需要按新成员范围重新决定'
                          : invitation.state === 'rejected'
                            ? '已婉拒，不自动追发'
                            : invitation.state === 'pending'
                              ? '等待当前成员共同决定'
                              : invitation.state === 'approved'
                                ? '等待本人接受'
                                : invitation.state}
                    </p>
                  ))}
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        setRoomBatch(
                          await client.refreshRoomPlan(progress.roomId),
                        );
                        setNotice(
                          '已按列出的当前成员预览新的邀请决定，旧提议留在历史。请确认上方安排再发送，其他成员仍需按规则选择。',
                        );
                      })
                    }
                  >
                    为未加入者按当前成员预览新提议
                  </Button>
                </>
              )}
            </article>
          ))}
          <h3>我当前可进入的关联房间</h3>
          <p className="muted">
            已检查本人 {scan} 个成员房间。
            {next
              ? '仍有后续页，当前列表不完整。'
              : roomsLoaded
                ? '本次成员列表扫描到末尾。'
                : '正在检查当前权限。'}{' '}
            任务关联不授予其他房间权限。
          </p>
          {rooms.map((room) => (
            <Button
              variant="outline"
              key={room.roomId}
              onClick={() => navigate(`/app/rooms/${room.roomId}`)}
            >
              {room.title} · {room.members.length} 个成员身份
            </Button>
          ))}
          {roomsLoaded && !rooms.length && (
            <p>当前已扫描的范围没有可进入的关联房间。</p>
          )}
          <div className="button-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => run((lease) => loadRooms(lease))}
            >
              重新检查房间权限
            </Button>
            {next && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => run((lease) => loadRooms(lease, next))}
              >
                继续扫描本人下一页
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate('/app/rooms')}>
              进入独立普通聊天
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
