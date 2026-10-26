import { randomUUID } from 'node:crypto';
import { chatSendRequestHash } from '../../../../packages/galaxy-official/src/shared/chat-message-request-hash.mjs';
import { nativeChoiceUrl } from '../../../native-v2/compact-app/browser-choice.mjs';
import { plain, unwrap, fingerprint } from './presentation.mjs';

export function createPurposeMessages(session) {
  function messages(after) {
    if (!session.nativeTools)
      return session.message(
        session.label('消息', 'Messages'),
        session.label(
          '这个 OpenCode 连接尚未提供 Native 消息工具。可以在原聊天使用银河消息工具，或打开已配置的完整网页。',
          'This OpenCode connection has no Native message tools. Use the Galaxy message tools in the original chat or the configured full website.',
        ),
      );
    void session.run(
      () =>
        session.native('galaxy_chat_rooms', {
          limit: 6,
          ...(after ? { after } : {}),
        }),
      (page) => {
        const rooms = page.rooms ?? [];
        session.menu(
          session.label('消息', 'Messages'),
          [
            ...rooms.map((room) => [
              plain(room.title) || session.label('对话', 'Conversation'),
              () => roomView(room),
              session.label(
                '查看消息并继续这段工作',
                'Read messages and continue this work',
              ),
            ]),
            [
              session.label('联系与回应', 'Contacts and responses'),
              () => session.projects(true),
            ],
            ...(page.next
              ? [
                  [
                    session.label('较早的对话', 'Earlier conversations'),
                    () => messages(page.next),
                  ],
                ]
              : []),
          ],
          session.onBack,
        );
      },
    );
  }

  async function readRoom(room) {
    const roomId = room.id ?? room.roomId;
    const meta = await session.native('galaxy_chat_room', { roomId }),
      history = await session.native('galaxy_chat_history', {
        roomId,
        latest: true,
        limit: 40,
      }),
      grants = await session.native('galaxy_chat_agent_grants', {
        roomId,
        limit: 100,
      });
    const status = unwrap(
      await session.nativeTools.call('galaxy_native_status', {}),
    );
    if (session.owner !== fingerprint(status))
      throw Error('current_identity_changed');
    const grant = (grants.items ?? []).find(
      (g) =>
        g.state === 'active' &&
        g.mode === 'respond' &&
        g.bindingId === status.connection?.bindingId,
    );
    const names =
      (
        await session.native('galaxy_profile_names', {
          subjectIds: [
            ...new Set(
              (history.messages ?? []).map((m) => m.subjectId).filter(Boolean),
            ),
          ].slice(0, 20),
        })
      ).items ?? [];
    return {
      meta,
      history,
      grant,
      status,
      names: new Map(names.map((n) => [n.subjectId, n.displayName])),
    };
  }

  function roomView(room, back = () => messages()) {
    const roomId = room.id ?? room.roomId;
    void session.run(
      () => readRoom(room),
      (initial) => {
        let latest = initial,
          hasNew = false;
        const readingText = (data) => {
          const members = (data.meta.members ?? []).map(
            (member) => member.subjectId,
          );
          return (
            (data.history.messages ?? [])
              .slice(-12)
              .map(
                (m) =>
                  (m.subjectId === data.status.identity
                    ? session.label('我', 'Me')
                    : data.names.get(m.subjectId) ||
                      session.label('成员 ', 'Member ') +
                        Math.max(1, members.indexOf(m.subjectId) + 1)) +
                  '：' +
                  plain(
                    m.state === 'accepted'
                      ? m.text
                      : session.label(
                          '这条消息当前不可读。',
                          'This message is currently unavailable.',
                        ),
                  ),
              )
              .join('\n\n') ||
            session.label(
              '这段对话还没有可读消息。',
              'No readable messages yet.',
            )
          );
        };
        const actions = () =>
          session.menu(
            plain(latest.meta.title ?? room.title),
            [
              ...(hasNew
                ? [
                    [
                      session.label('新消息', 'New messages'),
                      () => roomView(room, back),
                      session.label(
                        '已自动取得当前允许的消息，继续阅读。',
                        'Current authorized messages were read automatically; continue reading.',
                      ),
                    ],
                  ]
                : []),
              ...(latest.meta.transportAvailable === true &&
              !['archived', 'owner-succession'].includes(latest.meta.state)
                ? [
                    [
                      session.label('写消息', 'Write a message'),
                      () => reply(room, latest.grant, back),
                    ],
                  ]
                : []),
              [
                session.label('打开完整对话', 'Open full conversation'),
                () =>
                  void session.openObject({ kind: 'room', id: roomId }, () =>
                    roomView(room, back),
                  ),
              ],
              [
                session.label(
                  '把对话带回原工作',
                  'Bring the conversation to the original work',
                ),
                () =>
                  void session.run(
                    () => readRoom(room),
                    (fresh) =>
                      session.onReturnWork({
                        title: plain(fresh.meta.title ?? room.title),
                        content: readingText(fresh),
                        ...(fresh.status.website
                          ? {
                              sourceUrl: new URL(
                                '/app/rooms/' + roomId,
                                fresh.status.website,
                              ).href,
                            }
                          : {}),
                      }),
                    () => roomView(room, back),
                  ),
              ],
            ],
            back,
          );
        const finishReading = () => {
          hasNew = false;
          actions();
        };
        session.message(
          plain(initial.meta.title ?? room.title),
          readingText(initial),
          finishReading,
        );
        const v = session.version,
          signature = (d) =>
            JSON.stringify([
              d.meta.title,
              d.meta.state,
              d.meta.transportAvailable,
              d.grant,
              d.history.messages,
              [...d.names],
            ]);
        const watch = () => {
          session.messageTimer = setTimeout(async () => {
            if (!session.alive(v)) return;
            try {
              const fresh = await readRoom(room);
              if (!session.alive(v)) return;
              if (signature(fresh) !== signature(latest)) {
                const changedText =
                  readingText(fresh) !== readingText(latest) ||
                  fresh.meta.title !== latest.meta.title;
                hasNew ||=
                  JSON.stringify(fresh.history.messages) !==
                  JSON.stringify(latest.history.messages);
                latest = fresh;
                // Stable DialogAlert accepts immutable text. Replace only the still-open
                // reading alert when its readable content changes, keeping the same Enter
                // continuation. Any editor or selected action invalidates this version.
                if (changedText)
                  session.info(
                    plain(fresh.meta.title ?? room.title),
                    readingText(fresh),
                    () => {
                      if (session.alive(v)) finishReading();
                    },
                  );
              }
              watch();
            } catch {
              if (session.alive(v))
                session.message(
                  session.label(
                    '暂时无法读取这段对话',
                    'Unable to read this conversation',
                  ),
                  session.label(
                    '暂时无法取得当前允许的消息。可以保留原工作，稍后重新打开。',
                    'Current authorized messages could not be read. Retain your original work and reopen the conversation later.',
                  ),
                  back,
                );
            }
          }, 5000);
          session.messageTimer.unref?.();
        };
        watch();
      },
      back,
    );
  }

  function reply(room, grant, back = () => messages(), draft = '') {
    session.stopMessages();
    const v = ++session.version;
    session.prompt({
      title: session.label('写给这段对话的消息', 'Write to this conversation'),
      placeholder: '',
      value: draft,
      onCancel: () => roomView(room, back),
      onConfirm: (text) => {
        if (!session.alive(v)) return;
        if (!text.trim()) return roomView(room, back);
        if (!grant) return allowReply(room, text.trim(), back);
        const roomId = room.id ?? room.roomId,
          payload = {
            clientMessageId: randomUUID(),
            text: text.trim(),
            replyTo: null,
            agentGrantId: grant.grantId,
          };
        const send = () =>
          void session.run(
            async () => {
              try {
                return await session.native('galaxy_chat_send', {
                  roomId,
                  ...payload,
                });
              } catch {
                const receipt = await session.native(
                  'galaxy_chat_message_status',
                  {
                    roomId,
                    clientMessageId: payload.clientMessageId,
                    requestHash: await chatSendRequestHash(payload),
                  },
                );
                return {
                  ...receipt,
                  state:
                    receipt.state === 'not-found' ? 'absent' : receipt.state,
                };
              }
            },
            (result) => {
              if (
                result.state === 'accepted' ||
                (result.messageId && !result.state)
              )
                return roomView(room, back);
              // A confirmed absent receipt can offer the same original bytes. Unknown or
              // conflict never creates a second message or silently changes its grant.
              session.menu(
                session.label('发送结果尚待确认', 'Sending needs confirmation'),
                [
                  [
                    session.label('继续这条消息', 'Continue this message'),
                    () =>
                      void session.run(
                        async () =>
                          session.native('galaxy_chat_message_status', {
                            roomId,
                            clientMessageId: payload.clientMessageId,
                            requestHash: await chatSendRequestHash(payload),
                          }),
                        (r) =>
                          r.state === 'accepted'
                            ? roomView(room, back)
                            : session.message(
                                'Galaxy',
                                session.label(
                                  '原消息尚未确认，可以在完整对话中继续。',
                                  'The original message is not confirmed. Continue in the full conversation.',
                                ),
                                () => roomView(room, back),
                              ),
                      ),
                  ],
                  ...(result.state === 'absent'
                    ? [
                        [
                          session.label(
                            '重试同一条消息',
                            'Retry the same message',
                          ),
                          send,
                        ],
                      ]
                    : []),
                  [
                    session.label('回到原工作', 'Return to original work'),
                    session.onReturnWork,
                  ],
                ],
                () => roomView(room, back),
              );
            },
            () => reply(room, grant, back, text),
          );
        send();
      },
    });
  }

  function allowReply(room, text, back) {
    session.stopMessages();
    const v = ++session.version,
      roomId = room.id ?? room.roomId,
      input = {
        roomId,
        grantId: randomUUID(),
        mode: 'respond',
        primaryResponder: false,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    let busy = false,
      opened = null;
    const tick = async () => {
      if (!session.alive(v) || busy) return;
      busy = true;
      try {
        const value = await session.native('galaxy_chat_agent_grant', input);
        if (!session.alive(v)) return;
        if (value.state === 'declined') return reply(room, null, back, text);
        if (value.state === 'user-choice-needs-browser') {
          const url = nativeChoiceUrl(value.url);
          if (!url) throw Error('local_choice_unavailable');
          if (opened !== url) {
            opened = url;
            await session.nativeTools.openLink?.(url);
            if (!session.alive(v)) return;
            session.info(
              session.label(
                '允许这段对话回复',
                'Allow replies in this conversation',
              ),
              session.label(
                '当前宿主尚无回复权限。请在本机选择页核对：只在这段对话读取与回复，有效一小时；不会开启模型或后台运行。原消息仍保留，允许后发送。',
                'This host has no reply permission. Review reading and responding only in this room for one hour on the local choice page. This starts no model or background loop. Your message is retained and sends after approval.',
              ),
              () => {
                if (session.alive(v)) void tick();
              },
            );
          }
          session.messageTimer = setTimeout(() => void tick(), 1500);
          session.messageTimer.unref?.();
          return;
        }
        const fresh = await readRoom(room);
        if (!session.alive(v)) return;
        if (!fresh.grant) throw Error('reply_grant_unavailable');
        // The written message already expressed this send. Use that exact text
        // after the actual permission choice, without asking to compose it again.
        const payload = {
          roomId,
          clientMessageId: randomUUID(),
          text,
          replyTo: null,
          agentGrantId: fresh.grant.grantId,
        };
        let sent;
        try {
          sent = await session.native('galaxy_chat_send', payload);
        } catch {
          sent = await session.native('galaxy_chat_message_status', {
            roomId,
            clientMessageId: payload.clientMessageId,
            requestHash: await chatSendRequestHash(payload),
          });
        }
        if (session.alive(v)) {
          if (sent.state === 'accepted' || (sent.messageId && !sent.state))
            roomView(room, back);
          else
            session.message(
              session.label('消息尚待确认', 'Message needs confirmation'),
              session.label(
                '原消息尚未确认，已保留这次定位。可以继续原对话。',
                'The original message is not confirmed. Continue this conversation.',
              ),
              () => roomView(room, back),
            );
        }
      } catch {
        if (session.alive(v))
          session.message(
            session.label('消息未能继续', 'Unable to continue message'),
            session.label(
              '当前权限或服务不可用。原文字保留，请稍后再试。',
              'The permission or service is unavailable. Your text is retained; retry later.',
            ),
            () => reply(room, null, back, text),
          );
      } finally {
        busy = false;
      }
    };
    session.info(
      session.label('正在准备回复', 'Preparing reply'),
      session.label(
        '核对这段对话的实际权限。',
        'Checking this conversation’s permission.',
      ),
      () => {
        if (session.alive(v)) void tick();
      },
    );
    void tick();
  }
  return { messages, readRoom, roomView, reply, allowReply };
}
