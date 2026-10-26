import type { Action, Routes, MenuOption } from '../adapter-types.ts';
import { redactLocalWorkData } from '../../../../packages/galaxy-core/src/local-data-redaction.mjs';
import { setWorkArchiveSelection } from '../work-archive-choice.mjs';
import type { GalaxyMenuSession } from './session-context.ts';

export function createLocalWorkPages(session: GalaxyMenuSession) {
  type LocalWorkListItem = { workId: string; title: string; summary: string };
  type LocalWorkEnvironment = {
    version: number;
    observedAt: string;
    facts: Record<string, unknown>;
  };
  type LocalWorkObservation = {
    kind: string;
    source: { kind: string; messageId?: string };
    details: Record<string, unknown>;
    content?: { excerpt: string } | null;
    occurredAt?: string | null;
    observedAt: string;
    exclusions?: { path: string; kind: string }[];
  };

  async function readLocalWorkPage<T>(
    key: string,
    title: string,
    onReturn: Action,
    read: () => Promise<T>,
    present: (value: T) => void,
    unavailable: string,
  ) {
    session.showInfo(
      title,
      session.activeLanguage === 'zh-CN' ? '正在读取…' : 'Loading…',
      onReturn,
    );
    return session.localPageReads.run(
      { lane: 'page', key },
      async () => read(),
      {
        onSuccess: present,
        onError: () => session.showInfo('Galaxy', unavailable, onReturn),
      },
    );
  }

  async function showLocalWorkHistory(onReturn: Action, after?: string) {
    const chinese = session.activeLanguage === 'zh-CN',
      recorder = session.workRecorder;
    if (!recorder)
      return session.showInfo(
        'Galaxy',
        chinese
          ? '当前入口未取得本机记录位置。请恢复所选配置后重开；已有资料保留。'
          : 'The local recording location is unavailable. Restore the selected configuration and reopen.',
        onReturn,
      );
    return readLocalWorkPage(
      JSON.stringify(['history', after]),
      chinese ? '本地工作履历' : 'Local work history',
      onReturn,
      async () => {
        await recorder.refresh();
        return recorder.history.list({ after, limit: 6 });
      },
      (page) => {
        if (!page.galaxyId)
          return session.showQuickInitialize(
            () => void showLocalWorkHistory(onReturn, after),
          );
        const options: MenuOption[] = [],
          routes: Routes = {};
        page.items.forEach((work: LocalWorkListItem, index: number) => {
          const number = String(index + 1);
          options.push({
            number,
            title: work.title,
            description:
              work.summary?.slice(0, 160) ||
              (chinese ? '工作记录已保存' : 'Work recorded'),
          });
          routes[number] = () =>
            void showLocalWorkDetails(
              work.workId,
              () => void showLocalWorkHistory(onReturn, after),
            );
        });
        if (page.nextAfter) {
          options.push({
            number: 'n',
            title: chinese ? '下一组工作' : 'Next group',
          });
          routes.n = () => void showLocalWorkHistory(onReturn, page.nextAfter);
        }
        session.showSelect({
          title:
            (chinese ? '本地工作履历' : 'Local work history') +
            (page.items.length
              ? ''
              : chinese
                ? '\n还没有本地工作记录。保持客户端启用并照常工作即可。'
                : '\nNo local work recorded yet. Continue working with the client active.'),
          options,
          routes,
          onBack: onReturn,
        });
      },
      chinese
        ? '本地记录暂不可读，已有资料保留。'
        : 'Local history is temporarily unavailable; existing material is retained.',
    );
  }

  async function showLocalWorkDetails(
    workId: string,
    onReturn: Action,
    afterSequence = 0,
  ) {
    const chinese = session.activeLanguage === 'zh-CN',
      recorder = session.workRecorder;
    if (!recorder) return onReturn();
    return readLocalWorkPage(
      JSON.stringify(['detail', workId, afterSequence]),
      chinese ? '本地工作履历' : 'Local work history',
      onReturn,
      async () => {
        const detail = await recorder.history.get({
          workId,
          afterSequence,
          limit: 6,
        });
        const archiveSettings =
          detail && recorder.archive && detail.work.host === 'opencode'
            ? await recorder.archive.settings()
            : null;
        return { detail, archiveSettings };
      },
      ({ detail, archiveSettings }) => {
        if (!detail) return onReturn();
        const back = () =>
          void showLocalWorkDetails(workId, onReturn, afterSequence);
        const work = detail.work;
        const processingLabels: Record<string, string> = {
          pending: '等待整理',
          running: '自己的AI正在整理',
          failed: '整理未完成，原记录保留',
          'model-unavailable': '等待宿主模型可用',
          idle: '当前材料已整理',
        };
        const outcomeLabels: Record<string, string> = {
          unknown: '尚无明确整体结果',
          'reported-success': '已报告完成（AI归纳）',
          'reported-failure': '已报告未完成（AI归纳）',
          partial: '部分结果（AI归纳）',
          cancelled: '已取消（AI归纳）',
        };
        const options: MenuOption[] = [
          {
            number: 's',
            title: chinese ? '概况与整理' : 'Overview and summary',
          },
          ...(work.host === 'opencode' && session.api.route?.navigate
            ? [
                {
                  number: 'r',
                  title: chinese ? '回到这段工作' : 'Return to this work',
                },
              ]
            : []),
        ];
        const routes: Routes = {
          s: () =>
            session.showReading(
              work.title,
              (work.summary ||
                (chinese
                  ? '已记录当前可观察材料，尚未形成AI摘要。'
                  : 'Observed material has been recorded; no AI summary yet.')) +
                '\n\n' +
                (chinese ? '整理状态：' : 'Summary state: ') +
                (chinese
                  ? processingLabels[work.processing?.state || 'pending']
                  : work.processing?.state || 'pending') +
                '\n' +
                (chinese ? '工作结果：' : 'Reported outcome: ') +
                (chinese ? outcomeLabels[work.outcome] : work.outcome) +
                (work.processing?.state === 'failed'
                  ? '\n\n' +
                    (chinese
                      ? '工作记录仍可阅读。有新材料或切换模型后会自动继续整理。'
                      : 'Work records remain readable. New material or a model change resumes summarization automatically.')
                  : ''),
              back,
            ),
          r: () => {
            session.closeGalaxy();
            if (work.host === 'opencode')
              session.api.route?.navigate?.('session', {
                sessionID: work.sessionId,
              });
          },
        };
        if (detail.environments.length) {
          options.push({
            number: 'e',
            title: chinese ? '主要环境记录' : 'Observed environment',
          });
          routes.e = () =>
            session.showReading(
              chinese ? '主要环境记录' : 'Observed environment',
              detail.environments
                .map((item: LocalWorkEnvironment) => {
                  const facts = item.facts,
                    labels: Record<string, string> = chinese
                      ? {
                          host: '宿主',
                          hostVersion: '宿主版本',
                          platform: '系统',
                          architecture: '架构',
                          runtime: '运行环境',
                          runtimeVersion: '运行版本',
                          configuredModel: '宿主配置模型',
                          selectedModel: '会话选用模型',
                          actualModel: '消息报告的实际模型',
                        }
                      : {};
                  return (
                    (chinese ? '版本 ' : 'Version ') +
                    item.version +
                    ' · ' +
                    item.observedAt +
                    '\n' +
                    Object.entries(facts)
                      .filter(([key]) => key !== 'tools')
                      .map(
                        ([key, value]) =>
                          (labels[key] || key) + '：' + String(value),
                      )
                      .join('\n') +
                    (Array.isArray(facts.tools) && facts.tools.length
                      ? '\n' +
                        (chinese ? '工具接入：' : 'Connected tools: ') +
                        facts.tools.join('、')
                      : '')
                  );
                })
                .join('\n\n'),
              back,
            );
        }
        if (recorder.archive && archiveSettings && work.host === 'opencode') {
          const archive = recorder.archive,
            settings = archiveSettings,
            listed = settings.settings.sessions.some(
              (item: { host: string; sessionId: string }) =>
                item.host === work.host && item.sessionId === work.sessionId,
            ),
            selected = settings.settings.enabled && listed;
          options.push({
            number: 'a',
            title: selected
              ? chinese
                ? '停止为这段工作另存完整消息'
                : 'Stop saving full messages'
              : chinese
                ? '为这段工作保存完整消息'
                : 'Save full messages for this work',
            description: chinese
              ? '本人私有保存，回读所选会话可取得的消息；排除凭据，不读取附件正文，不因此上传。'
              : 'Private copies of available selected messages; credentials excluded, attachment bodies unread, no upload.',
          });
          routes.a = async () => {
            session.showInfo(
              chinese ? '正在保存' : 'Saving',
              chinese
                ? '正在更新这段工作的保存设置。'
                : 'Updating saving settings for this work.',
              back,
            );
            const operationPage = session.pageGeneration,
              stillReading = () =>
                !session.closed && operationPage === session.pageGeneration;
            try {
              await setWorkArchiveSelection(archive, {
                galaxyId: work.galaxyId,
                host: work.host,
                sessionId: work.sessionId,
                enabled: !selected,
              });
              if (!selected) {
                const result = await recorder.backfillArchive({
                  galaxyId: work.galaxyId,
                  host: work.host,
                  sessionId: work.sessionId,
                });
                if (!stillReading()) return;
                if (result.state !== 'copied')
                  return session.showInfo(
                    chinese
                      ? '较早的消息暂不可读'
                      : 'Earlier messages are unavailable',
                    chinese
                      ? '已有工作记录仍可阅读。'
                      : 'Existing work records remain readable.',
                    back,
                  );
              }
              await recorder.refresh();
              if (stillReading()) back();
            } catch {
              if (stillReading())
                session.showInfo(
                  chinese
                    ? '保存设置暂未完成'
                    : 'Unable to update saving settings',
                  chinese
                    ? '已有记录仍可阅读，请稍后重试。'
                    : 'Existing records remain readable. Please try again later.',
                  back,
                );
            }
          };
        }
        const labels: Record<string, string> = chinese
          ? {
              'user-statement': '用户陈述',
              'model-report': '模型报告',
              'host-event': '宿主事件',
              'tool-report': '工具回报',
              'external-material': '材料引用',
            }
          : {};
        detail.observations.forEach(
          (observation: LocalWorkObservation, index: number) => {
            const number = String(index + 1),
              source = observation.source;
            const eventLabels: Record<string, string> = chinese
              ? {
                  user: '我的话',
                  assistant: 'AI回复',
                  idle: '回合结束',
                  busy: '处理中',
                  completed: '工具完成',
                  running: '工具运行中',
                  error: '工具未完成',
                  message: '消息',
                  tool: '工具',
                  session: '会话',
                  artifact: '材料',
                  gap: '来源变化',
                }
              : {};
            // Host observations intentionally retain the original display conversion.
            const detailName = String(
              // eslint-disable-next-line typescript/no-base-to-string
              observation.details.tool ||
                observation.details.status ||
                observation.details.role ||
                observation.kind,
            );
            options.push({
              number,
              title: observation.details.tool
                ? detailName
                : eventLabels[detailName] || detailName,
              description:
                observation.content?.excerpt?.slice(0, 100) ||
                observation.occurredAt ||
                observation.observedAt,
            });
            routes[number] = () =>
              session.showReading(
                observation.details.tool
                  ? detailName
                  : eventLabels[detailName] || detailName,
                (observation.content?.excerpt ||
                  (chinese
                    ? '此项记录来源与状态，未保存正文。'
                    : 'This entry contains source and status, without body text.')) +
                  '\n\n' +
                  (chinese ? '来源：' : 'Source: ') +
                  (labels[source.kind] || source.kind) +
                  '\n' +
                  (chinese ? '时间：' : 'Observed at: ') +
                  observation.observedAt +
                  (observation.exclusions?.length
                    ? '\n' +
                      (chinese
                        ? '凭据等内容已排除。'
                        : 'Credentials and other excluded material are omitted.')
                    : ''),
                back,
              );
          },
        );
        const originals = session.api.client?.session?.message
          ? detail.observations
              .filter(
                (item: LocalWorkObservation) =>
                  item.source.messageId && work.host === 'opencode',
              )
              .filter(
                (
                  item: LocalWorkObservation,
                  index: number,
                  items: LocalWorkObservation[],
                ) =>
                  items.findIndex(
                    (other) => other.source.messageId === item.source.messageId,
                  ) === index,
              )
          : [];
        if (originals.length) {
          const originalList = () => {
            const originalRoutes: Routes = {},
              originalOptions: MenuOption[] = [];
            originals.forEach(
              (observation: LocalWorkObservation, index: number) => {
                const number = String(index + 1),
                  source = observation.source;
                const role = observation.details.role,
                  name =
                    role === 'user'
                      ? chinese
                        ? '我的话'
                        : 'My message'
                      : role === 'assistant'
                        ? chinese
                          ? 'AI回复'
                          : 'AI reply'
                        : chinese
                          ? '消息'
                          : 'Message';
                const related = detail.observations.find(
                  (item: LocalWorkObservation) =>
                    item.source.messageId === source.messageId &&
                    item.content?.excerpt,
                );
                originalOptions.push({
                  number,
                  title: name,
                  description:
                    related?.content?.excerpt?.slice(0, 100) ||
                    observation.occurredAt ||
                    observation.observedAt,
                });
                originalRoutes[number] = async () => {
                  session.showInfo(
                    chinese ? '正在读取消息' : 'Reading message',
                    chinese
                      ? '正在读取这条消息的正文。'
                      : 'Reading this message from the host.',
                    originalList,
                  );
                  const readingPage = session.pageGeneration,
                    stillReading = () =>
                      !session.closed && readingPage === session.pageGeneration;
                  try {
                    if (!source.messageId)
                      throw Error('host_original_unavailable');
                    const response = session.api.client?.session?.message
                      ? ((await session.api.client.session.message({
                          sessionID: work.sessionId,
                          messageID: source.messageId,
                        })) as {
                          data?: {
                            parts?: {
                              type: string;
                              text?: string;
                              state?: { output?: string; error?: string };
                            }[];
                          };
                          error?: unknown;
                        })
                      : null;
                    if (!stillReading()) return;
                    const original = response?.data?.parts;
                    if (response?.error || !original)
                      throw Error('host_original_unavailable');
                    const text = original
                      .map((part) =>
                        part.type === 'text'
                          ? part.text
                          : part.type === 'tool'
                            ? part.state?.output || part.state?.error
                            : '',
                      )
                      .filter(Boolean)
                      .join('\n\n');
                    if (!text) throw Error('host_original_unavailable');
                    const protectedText = redactLocalWorkData(text);
                    session.showReading(
                      chinese
                        ? '宿主当前可读的消息正文'
                        : 'Currently readable host message',
                      protectedText.value +
                        (protectedText.exclusions.length
                          ? '\n\n' +
                            (chinese ? '凭据已排除。' : 'Credentials excluded.')
                          : ''),
                      originalList,
                    );
                  } catch {
                    if (stillReading())
                      session.showInfo(
                        chinese ? '原文暂不可取得' : 'Original unavailable',
                        chinese
                          ? '这条消息暂时无法从宿主读取，已保存的工作记录仍可阅读。'
                          : 'This message could not be read from the host. Saved work records remain readable.',
                        originalList,
                      );
                  }
                };
              },
            );
            session.showSelect({
              title: chinese
                ? '回查这一页的消息原文'
                : 'Read original messages on this page',
              options: originalOptions,
              routes: originalRoutes,
              onBack: back,
            });
          };
          options.push({
            number: 'o',
            title: chinese ? '回查消息原文' : 'Read original messages',
          });
          routes.o = originalList;
        }
        if (detail.nextAfter !== null) {
          options.push({
            number: 'n',
            title: chinese ? '后续过程记录' : 'More observations',
          });
          routes.n = () =>
            void showLocalWorkDetails(workId, onReturn, detail.nextAfter);
        }
        session.showSelect({
          title: work.title,
          options,
          routes,
          onBack: onReturn,
        });
      },
      chinese
        ? '这段本地工作暂不可读，已有资料保留。'
        : 'This local work is temporarily unavailable.',
    );
  }

  return { readLocalWorkPage, showLocalWorkHistory, showLocalWorkDetails };
}
