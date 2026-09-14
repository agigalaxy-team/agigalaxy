import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { capsuleRefKey } from './capsule-workspace-client.mjs';

// Exact selected message references only. No room-wide publication toggle and
// no automatic transcript-to-Capsule conversion or cloud draft storage.
export function CapsuleMessagePicker({
  runtime,
  subjectId,
  busy,
  run,
  selected,
  onChange,
  onlyOwn = false,
}: any) {
  const [rooms, setRooms] = useState<any[]>([]),
    [roomNext, setRoomNext] = useState<string | null>(null),
    [roomId, setRoomId] = useState(''),
    [messages, setMessages] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    return () => {
      epoch.current++;
    };
  }, [runtime, subjectId]);
  async function call(path: string, input: any) {
    const token = epoch.current,
      r = await runtime.api.call(path, input);
    if (token !== epoch.current) throw new Error('消息来源身份已变化。');
    return r;
  }
  async function readRooms(after?: string) {
    const r = await call('/v2/chat/rooms/query', {
      limit: 30,
      ...(after ? { after } : {}),
    });
    setRooms((old) => (after ? [...old, ...r.rooms] : r.rooms));
    setRoomNext(r.next);
  }
  async function readMessages(id = roomId, after = '0') {
    const r = await call(`/v2/chat/rooms/${id}/history`, { after, limit: 30 });
    setMessages((old) =>
      after === '0' ? r.messages : [...old, ...r.messages],
    );
    setNext(r.next);
    setLoaded(true);
  }
  return (
    <details>
      <summary>明确选择聊天消息作为来源（可选）</summary>
      <p>
        房间阅读权不等于发布许可。只选择确实需要的消息；第三方消息仍需原作者许可。共享摘要有单独派生来源，不能冒充普通原创消息。
      </p>
      <Button
        type="button"
        disabled={busy}
        onClick={() => run(() => readRooms())}
      >
        读取我当前加入的房间
      </Button>
      {roomNext && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(() => readRooms(roomNext))}
        >
          更多房间
        </Button>
      )}
      <label>
        消息所在房间
        <select
          value={roomId}
          disabled={busy}
          onChange={(e) => {
            setRoomId(e.target.value);
            setMessages([]);
            setNext(null);
            setLoaded(false);
          }}
        >
          <option value="">选择房间</option>
          {rooms.map((r) => (
            <option key={r.roomId} value={r.roomId}>
              {r.title}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        disabled={busy || !roomId}
        onClick={() => run(() => readMessages())}
      >
        读取当前消息页
      </Button>
      {messages
        .filter(
          (m) =>
            m.text &&
            !m.sharedSummaryId &&
            (!onlyOwn || m.subjectId === subjectId),
        )
        .map((m) => {
          const ref = {
              kind: 'selected-message',
              id: m.messageId,
              version: m.revision,
            },
            k = capsuleRefKey(ref);
          return (
            <label className="task-card" key={k}>
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.some((s: any) => capsuleRefKey(s.ref) === k)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...selected,
                          { ref, authorId: m.subjectId, label: '选定聊天消息' },
                        ]
                      : selected.filter((s: any) => capsuleRefKey(s.ref) !== k),
                  )
                }
              />
              {m.text}
              <p>
                {m.subjectId} · 精确版本 {m.revision}
              </p>
            </label>
          );
        })}
      {loaded &&
        !messages.some(
          (m) =>
            m.text &&
            !m.sharedSummaryId &&
            (!onlyOwn || m.subjectId === subjectId),
        ) && (
          <p>这一页没有可选消息。失效、隐藏、其他作者或共享摘要可能被排除。</p>
        )}
      {next && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => run(() => readMessages(roomId, next))}
        >
          更多消息
        </Button>
      )}
    </details>
  );
}
