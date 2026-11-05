import { randomUUID } from 'node:crypto';
import { nativeConnectionMessage } from '../../../native-v2/presentation/native-result.mjs';
import { nativeChoiceUrl } from '../../../native-v2/compact-app/browser-choice.mjs';
import { nativeConfigurationMessage } from '../../../native-v2/presentation/native-configuration-message.mjs';
import { plain, unwrap, fingerprint } from './presentation.mjs';

const isOfficialOrigin = endpoint => {
  try {
    const url = new URL(endpoint);
    return url.origin === 'https://official.agigalaxy.org' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
};
const isOfficial = status => isOfficialOrigin(status.endpoint) || status.access?.kind === 'official-account' || !!status.officialAccount;
const accessReady = status => status.access?.kind === 'service' ? status.access.state === 'ready' : status.connected === true;
const accountReady = status => status.accountAccess?.state === 'ready' || status.officialAccount?.state === 'linked';

export function createPurposeIdentity(session) {
  function identity(onReady = null, back = session.onBack) {
    if (!session.nativeTools) return session.onBack();
    void session.run(
      () => session.native('galaxy_native_status'),
      (status) => {
        const ready = accessReady(status);
        if (onReady && ready) return onReady();
        const body = [nativeConnectionMessage(status, session.language)];
        session.menu(
          session.label('身份与设备', 'Identity and devices') +
            ' · ' +
            (ready
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
            ...(status.identity && !ready
              ? [[session.label('连接当前身份', 'Connect this identity'),
                  () => identityChoice('galaxy_native_connect', {}, () => identity(onReady, back), ['awaiting-account', 'processing'].includes(status.connectionOperation?.state))]]
              : []),
            ...(ready && isOfficial(status) && !accountReady(status)
              ? [[session.label('关联官网账户（按需）', 'Link website account (optional)'),
                  () => identityChoice('galaxy_native_account_connect', {}, () => identity(null, back), ['awaiting-account', 'processing'].includes(status.connectionOperation?.state))]]
              : []),
            ...(status.identity ? [[session.label('保存身份恢复码', 'Save an identity recovery code'), () => recoveryPage('set', () => identity(null, back))]] : []),
            [session.label('使用恢复码找回原身份', 'Recover an identity with its code'), () => recoveryPage('recover', () => identity(null, back))],
            [session.label('继续身份恢复', 'Continue identity recovery'), () => recoveryPage('resume', () => identity(null, back))],
            ...(ready
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
            ...(ready
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
            ...(ready
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
          ],
          back,
        );
      },
      back,
    );
  }

  function recoveryPage(action, back, operationId = '') {
    void session.run(
      async () => unwrap(await session.nativeTools.call('galaxy_identity_recovery', {action, ...(operationId ? {operationId} : {})})),
      async (value) => {
        const url = new URL(value.url);
        if (value.state !== 'user-choice-needs-browser' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/identity-recovery\/[a-f0-9]{48}$/.test(url.pathname)) throw Error('identity_recovery_local_url_invalid');
        await session.nativeTools.openLink?.(url.href);
        session.info(session.label('本机身份恢复','Local identity recovery'), session.label('在本机页面完成本人选择；恢复码只在该页面输入和显示，不要发送给助手。恢复后的连接需另行确认。','Complete your choice on the local page. Enter and view the recovery code only there; do not send it to the assistant. Reconnecting requires a separate choice.') + '\n\n' + url.href, () => {session.owner = null; back();});
      }, back,
    );
  }

  function identityChoice(name, input, done = identity, resume = false) {
    session.stopMessages();
    const v = ++session.version;
    let busy = false,
      choiceUrl = null,
      initial = null,
      initialSubject = null,
      connectStarted = resume,
      officialConnect = false;
    const title =
      name === 'galaxy_native_initialize'
        ? session.label('在本机准备身份', 'Prepare this device')
        : name === 'galaxy_native_disconnect'
          ? session.label('断开本机连接', 'Disconnect this local connection')
          : name === 'galaxy_native_account_connect'
            ? session.label('关联官网账户', 'Link website account')
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
          officialConnect = isOfficial(before);
          initialSubject = JSON.stringify([before.identity ?? null, before.endpoint ?? null]);
          if (session.owner !== null && session.owner !== beforeKey)
            throw Error('current_identity_changed');
        } else if (name === 'galaxy_native_account_connect'
          ? JSON.stringify([before.identity ?? null, before.endpoint ?? null]) !== initialSubject
          : beforeKey !== initial)
          throw Error('current_identity_changed');
        // Only this explicitly selected identity transition may change the menu's
        // owner/binding. The Native server checks its original real choice before
        // executing; generic reads and writes retain the ordinary owner fence.
        let value;
        if (name === 'galaxy_native_account_connect' && officialConnect && connectStarted) {
          const operation = before.connectionOperation;
          if (before.connectionError === 'current_device_control_required') throw Error(before.connectionError);
          if (operation?.state === 'awaiting-account' && operation.url && !choiceUrl) {
            const url = nativeChoiceUrl(operation.url);
            if (!url) throw Error('local_choice_unavailable');
            choiceUrl = url;
            await session.nativeTools.openLink?.(url);
            if (!session.alive(v)) return;
            session.info(title, session.label('请在打开的页面核对并选择。完成后会自动继续。', 'Review and choose on the opened page. This will continue automatically.'), () => { if (session.alive(v)) void tick(); });
          }

          if (operation?.identity && operation.identity !== before.identity || operation?.endpoint && operation.endpoint !== before.endpoint) throw Error('current_identity_changed');
          if (operation?.state === 'declined') value = {state: 'declined'};
          else if (['failed', 'unconfirmed'].includes(operation?.state)) throw Error(operation.error ?? 'native_connection_unconfirmed');
          else if ((operation?.state === 'finished' || !operation) && accountReady(before)) {
            session.owner = fingerprint(before);
            return done();
          } else if (operation?.state === 'finished' || !operation) {
            throw Error('native_identity_transition_unconfirmed');
          } else {
            session.messageTimer = setTimeout(() => void tick(), 1500);
            session.messageTimer.unref?.();
            return;
          }
        } else {
          if (name === 'galaxy_native_account_connect' && officialConnect) { connectStarted = true; }
          value = unwrap(await session.nativeTools.call(name, input));
        }
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
                '请在打开的页面核对并选择。完成后会自动继续。',
                'Review and choose on the opened page. This will continue automatically.',
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
              '已取消。',
              'Canceled.',
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
          (name === 'galaxy_native_connect' && !accessReady(after)) ||
          (name === 'galaxy_native_account_connect' && !accountReady(after)) ||
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
                  '暂时无法确认这次操作的结果。请查看当前状态。',
                  'The outcome cannot currently be confirmed. Check the current status.',
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
