import { randomUUID } from 'node:crypto';
import { nativeConnectionMessage } from '../../../../packages/galaxy-edge-mcp/src/native-v2/interaction/presentation.mjs';
import { nativeChoiceUrl } from '../../../native-v2/compact-app/browser-choice.mjs';
import { nativeConfigurationMessage } from '../../../../packages/galaxy-edge-mcp/src/native-v2/configuration-message.mjs';
import { plain, unwrap, fingerprint } from './presentation.mjs';

export function createPurposeIdentity(session) {
  function identity(onReady = null, back = session.onBack) {
    if (!session.nativeTools) return session.onBack();
    void session.run(
      () => session.native('galaxy_native_status'),
      (status) => {
        if (onReady && status.connected === true) return onReady();
        const body = [
          nativeConnectionMessage(status, session.language),
          ...(status.identity
            ? [
                session.label('当前银河身份：', 'Current Galaxy identity: ') +
                  plain(status.identity),
              ]
            : [
                session.label(
                  '这台设备尚未准备银河身份。可以在本机准备；连接服务会另行显示实际范围。',
                  'This device has no prepared Galaxy identity. Prepare it locally; connecting to a service shows its actual scope separately.',
                ),
              ]),
          ...(status.endpoint
            ? [
                session.label('当前服务：', 'Current service: ') +
                  plain(status.endpoint),
              ]
            : []),
        ];
        session.menu(
          session.label('身份与设备', 'Identity and devices') +
            ' · ' +
            (status.connected === true
              ? session.label('已连接', 'Connected')
              : status.connectionError
                ? session.label('连接暂不可用', 'Connection unavailable')
                : status.identity
                  ? session.label('尚未连接', 'Disconnected')
                  : session.label('尚未准备', 'Not prepared')),
          [
            ...(!status.identity
              ? [
                  [
                    session.label('在本机准备身份', 'Prepare this device'),
                    () =>
                      identityChoice(
                        'galaxy_native_initialize',
                        { profile: 'minimal' },
                        () => identity(onReady, back),
                      ),
                  ],
                ]
              : []),
            ...(status.identity && status.connected !== true
              ? [
                  status.connectionChoice?.enabled === true
                    ? [
                        session.label(
                          '重试当前连接',
                          'Retry current connection',
                        ),
                        () => identity(onReady, back),
                      ]
                    : [
                        session.label('连接当前身份', 'Connect this identity'),
                        () =>
                          identityChoice('galaxy_native_connect', {}, () =>
                            identity(onReady, back),
                          ),
                      ],
                ]
              : []),
            ...(status.connected === true
              ? [
                  [
                    session.label(
                      '在官网继续当前身份',
                      'Continue this identity on the website',
                    ),
                    () =>
                      websiteIdentity({ kind: 'publish' }, () =>
                        identity(null, back),
                      ),
                  ],
                ]
              : []),
            ...(status.connected === true
              ? [
                  [
                    session.label(
                      '打开当前身份与设备',
                      'Open current identity and devices',
                    ),
                    () =>
                      void session.openObject({ kind: 'identity' }, identity),
                  ],
                ]
              : []),
            ...(status.connected === true
              ? [
                  [
                    session.label(
                      '断开本机连接',
                      'Disconnect this local connection',
                    ),
                    () => identityChoice('galaxy_native_disconnect', {}),
                  ],
                ]
              : []),
            [
              session.label('当前身份与服务', 'Current identity and service'),
              () =>
                session.message(
                  session.label(
                    '当前身份与服务',
                    'Current identity and service',
                  ),
                  body.join('\n\n'),
                  () => identity(onReady, back),
                ),
            ],
            [
              session.label('回到原工作', 'Return to original work'),
              session.onReturnWork,
            ],
          ],
          back,
        );
      },
      back,
    );
  }

  function identityChoice(name, input, done = identity) {
    session.stopMessages();
    const v = ++session.version;
    let busy = false,
      choiceUrl = null,
      initial = null;
    const title =
      name === 'galaxy_native_initialize'
        ? session.label('在本机准备身份', 'Prepare this device')
        : name === 'galaxy_native_disconnect'
          ? session.label('断开本机连接', 'Disconnect this local connection')
          : session.label('连接当前身份', 'Connect this identity');
    const tick = async () => {
      if (!session.alive(v) || busy) return;
      busy = true;
      try {
        const before = unwrap(
          await session.nativeTools.call('galaxy_native_status', {}),
        );
        if (!session.alive(v)) return;
        const beforeKey = fingerprint(before);
        if (initial === null) {
          initial = beforeKey;
          if (session.owner !== null && session.owner !== beforeKey)
            throw Error('current_identity_changed');
        } else if (beforeKey !== initial)
          throw Error('current_identity_changed');
        // Only this explicitly selected identity transition may change the menu's
        // owner/binding. The Native server checks its original real choice before
        // executing; generic reads and writes retain the ordinary owner fence.
        const value = unwrap(await session.nativeTools.call(name, input));
        if (!session.alive(v)) return;
        if (value.state === 'user-choice-needs-browser') {
          const url = nativeChoiceUrl(value.url);
          if (!url) throw Error('local_choice_unavailable');
          if (choiceUrl !== url) {
            choiceUrl = url;
            await session.nativeTools.openLink?.(url);
            if (!session.alive(v)) return;
            session.info(
              title,
              session.label(
                '请在本机选择页核对这次内容与范围。允许后会自动继续；原工作仍保留。',
                'Review this operation and scope in the local choice page. It continues after approval; the original work is retained.',
              ) +
                '\n\n' +
                url,
              () => {
                if (session.alive(v)) void tick();
              },
            );
          }
          session.messageTimer = setTimeout(() => void tick(), 1500);
          session.messageTimer.unref?.();
          return;
        }
        if (value.state === 'declined')
          return session.message(
            title,
            session.label(
              '这次操作未获准。可以继续原工作，或重新选择。',
              'This operation was not approved. Continue the original work or choose again.',
            ),
            identity,
          );
        const after = unwrap(
          await session.nativeTools.call('galaxy_native_status', {}),
        );
        if (!session.alive(v)) return;
        if (
          (name === 'galaxy_native_initialize' &&
            (!after.identity || value.identity !== after.identity)) ||
          (name === 'galaxy_native_connect' && after.connected !== true) ||
          (name === 'galaxy_native_disconnect' && after.connected === true)
        )
          throw Error('native_identity_transition_unconfirmed');
        session.owner = fingerprint(after);
        done();
      } catch (error) {
        if (session.alive(v))
          session.message(
            title,
            String(error.message).startsWith('native_configuration_')
              ? nativeConfigurationMessage(error, session.language)
              : session.label(
                  '这次操作暂未完成。原身份与工作仍保留，请检查当前连接后再试。',
                  'This operation has not completed. Existing identity and work are retained; check this connection before retrying.',
                ),
            identity,
          );
      } finally {
        busy = false;
      }
    };
    session.info(
      title,
      session.label('正在准备本次操作…', 'Preparing this operation…'),
      () => {
        if (session.alive(v)) void tick();
      },
    );
    void tick();
  }

  function websiteIdentity(object, back = session.onBack, options = {}) {
    const requestId = randomUUID();
    void session.run(
      async () => {
        const context = await session.readWorkContext?.();
        return session.native('galaxy_identity_web_connect', {
          requestId,
          object,
          ...(context?.origin ? { origin: context.origin } : {}),
          ...(options.scopes ? { scopes: options.scopes } : {}),
          ...(options.continueWith
            ? { continueWith: options.continueWith }
            : {}),
        });
      },
      (first) => {
        session.navigationId = first.navigationId;
        const v = ++session.version;
        let busy = false;
        const show = (value) => {
          if (!session.alive(v)) return;
          if (
            value.state === 'completed' &&
            value.deviceAuthorizationVerified === true
          )
            return session.message(
              session.label('在官网继续', 'Continue on the website'),
              session.label(
                '本次设备授权已完成。可以在已打开的网页继续，或回到原工作。',
                'This device authorization completed. Continue on the opened website or return to the original work.',
              ),
              options.onComplete ?? session.onReturnWork,
            );
          if (
            ['canceled', 'expired', 'transport-unavailable'].includes(
              value.state,
            ) ||
            value.transportAvailable !== true
          )
            return session.message(
              session.label(
                '网页接续尚未完成',
                'Website connection is incomplete',
              ),
              session.label(
                '这次接续已结束或暂时不可用，原身份和操作记录仍保留。可以继续原工作。',
                'This connection ended or is unavailable. The original identity and operation record are retained; continue your work.',
              ),
              back,
            );
          const url = new URL(value.url);
          if (
            url.protocol !== 'http:' ||
            url.hostname !== '127.0.0.1' ||
            !url.port ||
            url.pathname !== '/connect/' + value.handoffId ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw Error('web_identity_local_url_invalid');
          session.info(
            session.label(
              '在官网继续当前身份',
              'Continue this identity on the website',
            ),
            session.label(
              '在本机接续页打开官网，并核对同一身份、这个网页设备和实际范围。只有你的明确选择会授权；原工作仍保留。',
              'Open the website from the local connection page and review this identity, web device and exact scope. Your explicit choice grants access; the original work is retained.',
            ) +
              '\n\n' +
              url.href,
            () => {
              if (session.alive(v)) void tick();
            },
          );
        };
        const tick = async () => {
          if (!session.alive(v) || busy) return;
          busy = true;
          try {
            const value = await session.native(
              'galaxy_identity_web_connect_status',
              { handoffId: first.handoffId },
            );
            if (!session.alive(v)) return;
            if (
              value.state === 'completed' ||
              ['canceled', 'expired', 'transport-unavailable'].includes(
                value.state,
              ) ||
              value.transportAvailable !== true
            ) {
              session.stopMessages();
              show(value);
              return;
            }
            session.messageTimer = setTimeout(() => void tick(), 1500);
            session.messageTimer.unref?.();
          } catch {
            if (session.alive(v))
              session.message(
                session.label(
                  '网页接续尚待确认',
                  'Website connection needs confirmation',
                ),
                session.label(
                  '暂时无法读取这次进度。原身份与接续记录仍保留，未创建另一身份。可以回到原工作。',
                  'The progress cannot currently be read. The original identity and connection record are retained; no other identity was created. Return to the original work.',
                ),
                session.onReturnWork,
              );
          } finally {
            busy = false;
          }
        };
        try {
          show(first);
          if (session.alive(v)) void tick();
        } catch {
          session.message(
            'Galaxy',
            session.label(
              '本机接续地址当前不可用。原身份仍保留。',
              'The local connection address is unavailable. The original identity is retained.',
            ),
            back,
          );
        }
      },
      back,
    );
  }
  return { identity, identityChoice, websiteIdentity };
}
