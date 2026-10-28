import { createHostDialogs } from './tui-session/dialogs.ts';
import { createConnectedMenu } from './tui-session/connected-menu.ts';
import { createHistoryPages } from './tui-session/history.ts';
import { createConnectionPages } from './tui-session/connection.ts';
import { createRecordsPages } from './tui-session/records.ts';
import { createSettingsPages } from './tui-session/settings.ts';
import { createLocalWorkPages } from './tui-session/local-work.ts';
import type { GalaxyMenuSession } from './tui-session/session-context.ts';
import type {
  Action,
  StableHostApi,
  ConnectionController,
  CaseSubmission,
  DiscoverySource,
  HostWorkContext,
  HostWorkResult,
} from './adapter-types.ts';
import { createPurposeMenu } from './purpose-menu.mjs';
import { createOpenCodeWorkRecorder } from './work-recorder.mjs';
import {store, connection, createLegacyArchive, prepareOpenCodeLocalWork, isOpenCodePreparationDeferred, deferOpenCodePreparation} from './bridge/legacy-local.mjs';
import { createReadTaskController } from '../../shared/read-task.mjs';

export function createGalaxyAdapter(
  connectionController: ConnectionController | null = null,
  {
    readCaseSubmission = null,
    discovery = null,
    dataDirectory: configuredDirectory,
    nativeTools = null,
    readWorkContext = null,
    recordWork = true,
    readLocalIdentity,
    onWorkSessionComplete,
    hostPersistence,
    connectionUnavailable = false,
  }: {
    readCaseSubmission?: (() => Promise<CaseSubmission | null>) | null;
    discovery?: DiscoverySource | null;
    dataDirectory?: string;
    nativeTools?: {
      call(name: string, args: Record<string, unknown>): Promise<unknown>;
      openLink?: (url: string) => Promise<unknown>;
    } | null;
    readWorkContext?: (() => Promise<HostWorkContext | null>) | null;
    recordWork?: boolean;
    readLocalIdentity?: (directory: string) => Promise<{ id: string } | null>;
    onWorkSessionComplete?: (input: {
      galaxyId: string;
      host: string;
      sessionId: string;
    }) => Promise<unknown>;
    connectionUnavailable?: boolean;
    hostPersistence?: { history: ReturnType<typeof createOpenCodeWorkRecorder>['history']; archive: NonNullable<ReturnType<typeof createOpenCodeWorkRecorder>['archive']>; initialize(input:{initializationPath:'personal-galaxy';subjectType:'person'|'organization'}):Promise<unknown>; preparationStatus():Promise<{deferred:boolean}>; deferPreparation():Promise<unknown> };
  } = {},
) {
  let closed = false,
    attached = false;
  const localPageReads = createReadTaskController('opencode-local-work');
  let disposeHost: Action | null = null;
  let disposeLifecycle: Action | null = null;
  let workRecorder: ReturnType<typeof createOpenCodeWorkRecorder> | null = null;
  let closing: Promise<void> | null = null;
  function close() {
    if (closed) return closing ?? Promise.resolve();
    closed = true;
    localPageReads.dispose();
    try {
      disposeHost?.();
    } finally {
      disposeHost = null;
      try {
        connectionController?.disconnect();
      } finally {
        discovery?.close();
        disposeLifecycle?.();
        disposeLifecycle = null;
        closing = workRecorder?.close() ?? Promise.resolve();
      }
    }
    return closing;
  }
  function requiredController(): ConnectionController {
    if (!connectionController)
      throw new Error('Galaxy connection runtime unavailable.');
    return connectionController;
  }
  function clearConnectionController() {
    connectionController = null;
  }
  function controllerMethod<K extends keyof ConnectionController>(
    key: K,
  ): NonNullable<ConnectionController[K]> {
    const method = requiredController()[key];
    if (method === undefined || method === null)
      throw new Error('Galaxy connection operation unavailable.');
    return method;
  }
  return {
    id: 'galaxy.opencode.stable.tui',
    close,
    tui: async (api: StableHostApi) => {
      if (closed || attached)
        throw new Error('Galaxy adapter is closed or already attached.');
      attached = true;
      if (api.lifecycle) {
        const signal = api.lifecycle.signal;
        if (signal.aborted) {
          void close();
          return;
        }
        signal.addEventListener('abort', close, { once: true });
        const unregister = api.lifecycle.onDispose(close);
        disposeLifecycle = () => {
          signal.removeEventListener('abort', close);
          unregister();
        };
      }
      try {
        if (closed) return;
        const dataDirectory =
          configuredDirectory ?? process.env.GALAXY_DATA_DIR;
        if (recordWork)
          workRecorder = createOpenCodeWorkRecorder(api, {
            dataDirectory,
            getIdentity: readLocalIdentity,
            onSessionComplete: onWorkSessionComplete,
            ...(hostPersistence ? {history: hostPersistence.history} : {}),
            archive: hostPersistence?.archive ?? createLegacyArchive({
              dataDirectory,
              getIdentity: readLocalIdentity,
            }),
          });
        let discoveryAbort: AbortController | null = null;
        let disposeMenuKeys: Action | null = null;
        let activeLanguage = 'zh-CN';
        let connectionGeneration = 0;
        let pageGeneration = 0;
        let visiblePage: number | null = null;
        let pendingConnection: object | null = null;
        let purposeMenu: ReturnType<typeof createPurposeMenu> | null = null;
        let firstPreparationVisible = false;

        function nextPage() {
          localPageReads.cancel();
          return ++pageGeneration;
        }

        function clearMenuKeys() {
          if (disposeMenuKeys) disposeMenuKeys();
          disposeMenuKeys = null;
        }

        function closeGalaxy() {
          if (firstPreparationVisible) {
            firstPreparationVisible = false;
            void deferOpenCodePreparation(dataDirectory).catch(() => {});
          }
          connectionGeneration++;
          nextPage();
          discoveryAbort?.abort();
          connectionController?.cancel();
          pendingConnection = null;
          purposeMenu?.close();
          purposeMenu = null;
          clearMenuKeys();
          if (visiblePage !== null) {
            visiblePage = null;
            api.ui.dialog.setSize('medium');
            api.ui.dialog.clear();
          }
        }

        const menuSession: GalaxyMenuSession = {
          get activeLanguage() {
            return activeLanguage;
          },
          set activeLanguage(value) {
            activeLanguage = value;
          },
          get clearMenuKeys() {
            return clearMenuKeys;
          },
          get nextPage() {
            return nextPage;
          },
          get disposeMenuKeys() {
            return disposeMenuKeys;
          },
          set disposeMenuKeys(value) {
            disposeMenuKeys = value;
          },
          get visiblePage() {
            return visiblePage;
          },
          set visiblePage(value) {
            visiblePage = value;
          },
          get showDiscovery() {
            return showDiscovery;
          },
          get showLocalSearchFeedback() {
            return showLocalSearchFeedback;
          },
          get showBindingReceipts() {
            return showBindingReceipts;
          },
          get checkRemoteBinding() {
            return checkRemoteBinding;
          },
          get previewConnection() {
            return previewConnection;
          },
          get api() {
            return api;
          },
          get clearConnectionController() {
            return clearConnectionController;
          },
          get closeGalaxy() {
            return closeGalaxy;
          },
          get closed() {
            return closed;
          },
          get connection() {
            return connection;
          },
          get connectionController() {
            return connectionController;
          },
          set connectionController(value) {
            connectionController = value;
          },
          get connectionGeneration() {
            return connectionGeneration;
          },
          set connectionGeneration(value) {
            connectionGeneration = value;
          },
          get controllerMethod() {
            return controllerMethod;
          },
          get currentWorkContext() {
            return currentWorkContext;
          },
          get dataDirectory() {
            return dataDirectory;
          },
          get discovery() {
            return discovery;
          },
          get discoveryAbort() {
            return discoveryAbort;
          },
          set discoveryAbort(value) {
            discoveryAbort = value;
          },
          get localPageReads() {
            return localPageReads;
          },
          get nativeTools() {
            return nativeTools;
          },
          get pageGeneration() {
            return pageGeneration;
          },
          get pendingConnection() {
            return pendingConnection;
          },
          set pendingConnection(value) {
            pendingConnection = value;
          },
          get previewCaseSubmission() {
            return previewCaseSubmission;
          },
          get promptHistory() {
            return promptHistory;
          },
          get purposeMenu() {
            return purposeMenu;
          },
          set purposeMenu(value) {
            purposeMenu = value;
          },
          get readCaseSubmission() {
            return readCaseSubmission;
          },
          get readWorkContext() {
            return readWorkContext;
          },
          get requiredController() {
            return requiredController;
          },
          get returnToWork() {
            return returnToWork;
          },
          get showConnection() {
            return showConnection;
          },
          get showConsole() {
            return showConsole;
          },
          get showInfo() {
            return showInfo;
          },
          get showManagedConnection() {
            return showManagedConnection;
          },
          get showPrompt() {
            return showPrompt;
          },
          get showPublicationDrafts() {
            return showPublicationDrafts;
          },
          get showQuickInitialize() {
            return showQuickInitialize;
          },
          get showReading() {
            return showReading;
          },
          get showSelect() {
            return showSelect;
          },
          get showStatus() {
            return showStatus;
          },
          get store() {
            return store;
          },
          get workRecorder() {
            return workRecorder;
          },
        };
        const {
          showStatus,
          showConnection,
          showDiscovery,
          showLocalSearchFeedback,
          showBindingReceipts,
          checkRemoteBinding,
          previewConnection,
        } = createConnectionPages(menuSession);
        const { showManagedConnection } = createConnectedMenu(menuSession);
        const { showPublicationDrafts, previewCaseSubmission } =
          createRecordsPages(menuSession);
        const { promptHistory } = createHistoryPages(menuSession);
        const { showInfo, showReading, showPrompt, showSelect } =
          createHostDialogs(menuSession);
        const { showSettings } = createSettingsPages(menuSession);
        const { showLocalWorkHistory } = createLocalWorkPages(menuSession);

        async function currentWorkContext(): Promise<HostWorkContext | null> {
          if (readWorkContext) return readWorkContext();
          const route = api.route?.current,
            state = api.state;
          const sessionId =
            route?.name === 'session' ? route.params?.sessionID : undefined;
          if (!sessionId || !state) return null;
          const lastUser = [...state.session.messages(sessionId)]
            .reverse()
            .find((message) => message.role === 'user');
          const query = lastUser
            ? state
                .part(lastUser.id)
                .filter(
                  (part) =>
                    part.type === 'text' && typeof part.text === 'string',
                )
                .map((part) => part.text)
                .join('\n')
                .trim()
            : '';
          // The current host session is local return context. It is never inferred
          // to be a Galaxy Task/Case, nor shared as a new social/work object.
          return {
            origin: { host: 'opencode', workRef: sessionId },
            ...(query ? { query } : {}),
          };
        }

        async function returnToWork(result?: HostWorkResult): Promise<void> {
          if (!result) {
            closeGalaxy();
            return;
          }
          const page = pageGeneration;
          if (!api.client?.tui.appendPrompt) {
            showInfo(
              activeLanguage === 'zh-CN'
                ? '带回原工作'
                : 'Return to original work',
              (activeLanguage === 'zh-CN'
                ? '当前宿主没有提供把内容放入原输入的接口。可以阅读以下内容后继续原工作。\n\n'
                : 'This host cannot append content to the original input. Read the content below before continuing.\n\n') +
                result.content +
                (result.sourceUrl ? '\n\n' + result.sourceUrl : ''),
              closeGalaxy,
            );
            return;
          }
          const text =
            '\n\n' +
            (activeLanguage === 'zh-CN' ? '银河 · ' : 'Galaxy · ') +
            result.title +
            '\n\n' +
            result.content +
            (result.sourceUrl
              ? '\n\n' +
                (activeLanguage === 'zh-CN' ? '来源：' : 'Source: ') +
                result.sourceUrl
              : '') +
            '\n';
          try {
            const response = await api.client.tui.appendPrompt({ text });
            if (closed || page !== pageGeneration) return;
            if (response.data !== true)
              throw new Error('host_input_not_confirmed');
            closeGalaxy();
          } catch {
            if (closed || page !== pageGeneration) return;
            showInfo(
              activeLanguage === 'zh-CN'
                ? '原工作输入尚待确认'
                : 'Original input needs checking',
              (activeLanguage === 'zh-CN'
                ? '未能确认内容是否已放入原输入。先回到原工作查看，避免重复加入；这里不会发送给模型。\n\n'
                : 'The host did not confirm whether content was appended. Check the original input before adding it again. No model prompt was submitted.\n\n') +
                result.content +
                (result.sourceUrl ? '\n\n' + result.sourceUrl : ''),
              closeGalaxy,
            );
          }
        }

        async function showQuickInitialize(
          onReturn: Action,
          firstStart = false,
        ): Promise<unknown> {
          const requestedPage = pageGeneration,
            stillHere = () => !closed && requestedPage === pageGeneration;
          const owner = await workRecorder?.history.identity();
          const snapshot = hostPersistence
            ? {identity:owner,recoveryRequired:false}
            : await store.getLocalSnapshot(dataDirectory);
          if (!stillHere()) return;
          if (owner || snapshot.identity) {
            firstPreparationVisible = false;
            await workRecorder?.refresh();
            if (stillHere()) return onReturn();
            return;
          }
          const chinese = activeLanguage === 'zh-CN';
          if (snapshot.recoveryRequired)
            return showInfo(
              chinese ? '本地资料需要恢复' : 'Local recovery needed',
              chinese
                ? '上次本机准备尚未完成。请保留现有资料，恢复后再开始记录。'
                : 'The previous preparation was interrupted. Keep existing material and recover before recording.',
              onReturn,
            );
          const initialize = async (subjectType: 'person' | 'organization') => {
            const operationPage = pageGeneration,
              atOriginalPage = () =>
                !closed && operationPage === pageGeneration;
            firstPreparationVisible = false;
            try {
              // A real TUI start choice is sufficient for this local-only operation.
              // No browser approval or account association repeats the same decision.
              if (!(await workRecorder?.history.identity())) {
                if(hostPersistence)await hostPersistence.initialize({initializationPath:'personal-galaxy',subjectType});
                else await prepareOpenCodeLocalWork(dataDirectory, { subjectType });
              }
              await workRecorder?.refresh();
              if (atOriginalPage()) onReturn();
            } catch {
              if (atOriginalPage())
                showInfo(
                  'Galaxy',
                  chinese
                    ? '本机准备未完成，请保留现有资料再试。'
                    : 'Device preparation is incomplete; retain current material before retrying.',
                  onReturn,
                );
            }
          };
          firstPreparationVisible = firstStart;
          const later = async () => {
            firstPreparationVisible = false;
            await (hostPersistence?hostPersistence.deferPreparation():deferOpenCodePreparation(dataDirectory)).catch(() => {});
            closeGalaxy();
          };
          showSelect({
            title: chinese
              ? '开始使用银河\n普通工作会自动记录到本机，供本人回看与自己的 AI 整理；保留事实、来源和有限片段，默认不另存全部会话。\n上传预设“履历概况”，接入在线服务前不关联、不上传。沿用已有身份；新身份默认为个人，类型创建后不可更改。'
              : 'Start using Galaxy\nOrdinary work is recorded on this device for your review and AI summaries. Facts, sources and bounded excerpts are retained; full conversations are not copied by default.\nUpload is preset to history overview, with no connection or upload before choosing a service. Existing identity is reused; new identities are personal by default and their type is permanent.',
            options: [
              {
                number: '1',
                title: chinese ? '同意并开始' : 'Agree and start',
              },
              {
                number: '2',
                title: chinese ? '用于组织' : 'Use for an organization',
              },
              { number: '3', title: chinese ? '以后再说' : 'Not now' },
            ],
            routes: {
              1: () => initialize('person'),
              2: () => initialize('organization'),
              3: later,
            },
            onBack: firstStart ? later : onReturn,
            onEscape: later,
          });
        }

        async function purpose(
          kind: 'search' | 'messages' | 'publish' | 'community' | 'continueWeb',
          onBack: Action,
        ): Promise<unknown> {
          if (
            nativeTools &&
            workRecorder &&
            ['messages', 'publish', 'continueWeb'].includes(kind)
          ) {
            try {
              if (!(await workRecorder.history.identity()))
                return showQuickInitialize(() => void purpose(kind, onBack));
            } catch {
              return showInfo(
                'Galaxy',
                activeLanguage === 'zh-CN'
                  ? '本地身份暂不可读，请先恢复原资料位置。'
                  : 'The local identity is unavailable. Restore its existing location first.',
                onBack,
              );
            }
          }
          const version = ++connectionGeneration;
          purposeMenu?.close();
          if (
            !nativeTools &&
            kind === 'search' &&
            !connectionController?.querySearch
          ) {
            return showSelect({
              title:
                activeLanguage === 'zh-CN'
                  ? '找帮助\n当前宿主尚未接入可查询的银河服务。'
                  : 'Find help\nThis host has no connected Galaxy search service.',
              options: [
                {
                  number: '1',
                  title:
                    activeLanguage === 'zh-CN'
                      ? '接入银河'
                      : 'Connect to Galaxy',
                },
                {
                  number: '2',
                  title:
                    activeLanguage === 'zh-CN'
                      ? '回到原工作'
                      : 'Return to original work',
                },
              ],
              routes: { 1: () => showConnection(onBack), 2: closeGalaxy },
              onBack,
            });
          }
          purposeMenu = createPurposeMenu({
            nativeTools,
            controller: connectionController,
            select: showSelect,
            prompt: showPrompt,
            info: showInfo,
            readInfo: showReading,
            language: activeLanguage,
            isCurrent: () => !closed && version === connectionGeneration,
            onBack,
            onReturnWork: returnToWork,
            readWorkContext: currentWorkContext,
          });
          purposeMenu[kind]();
        }

        async function showConsole(
          initialized?: Awaited<
            ReturnType<typeof store.getGalaxyIntegrationStatus>
          >,
        ) {
          const status = nativeTools
            ? undefined
            : initialized?.integration
              ? initialized
              : await store.getGalaxyIntegrationStatus(dataDirectory);
          const chinese = activeLanguage === 'zh-CN';
          const reopen = () => showConsole(status);
          showSelect({
            title: chinese ? '✧ 银河' : '✧ Galaxy',
            options: [
              {
                number: '1',
                title: chinese ? '找帮助' : 'Find help',
                description: chinese
                  ? '说明目标，直接查看当前可用的帮助。'
                  : 'Describe a goal and read currently available help.',
              },
              {
                number: '2',
                title: chinese ? '发起求助' : 'Ask for help',
                description: chinese
                  ? '沿用当前工作准备需要的协助。'
                  : 'Prepare a request from the current work.',
              },
              {
                number: '3',
                title: chinese ? '消息' : 'Messages',
                description: chinese
                  ? '查看对话，做必要回复。'
                  : 'Read conversations and reply when needed.',
              },
              ...(nativeTools
                ? [
                    {
                      number: '6',
                      title: chinese ? '逛社区' : 'Browse community',
                      description: chinese
                        ? '按主题阅读讨论，保留原工作。'
                        : 'Browse discussions by topic and retain your original work.',
                    },
                  ]
                : []),
              ...(nativeTools
                ? [
                    {
                      number: '7',
                      title: chinese
                        ? '接着网页里的事情'
                        : 'Continue the selected web content',
                      description: chinese
                        ? '沿用网页选择的材料和当前目的。'
                        : 'Use the selected web material and current purpose.',
                    },
                  ]
                : []),
              {
                number: '8',
                title: chinese ? '本地工作履历' : 'Local work history',
                description: chinese
                  ? '查看自动记录的工作、过程、摘要与来源。'
                  : 'Read recorded work, summaries and sources.',
              },
              {
                number: '4',
                title: chinese ? '我的与设置' : 'My settings',
                description: chinese
                  ? '身份、连接、资料和显示偏好。'
                  : 'Identity, connection, data and display preferences.',
              },
              {
                number: '5',
                title: chinese ? '回到原工作' : 'Return to original work',
                description: '',
              },
            ],
            routes: {
              1: () => purpose('search', reopen),
              2: () => purpose('publish', reopen),
              3: () => purpose('messages', reopen),
              4: () => showSettings(reopen),
              5: closeGalaxy,
              6: () => purpose('community', reopen),
              7: () => purpose('continueWeb', reopen),
              8: () => void showLocalWorkHistory(reopen),
              0: closeGalaxy,
            },
            onBack: closeGalaxy,
          });
        }

        async function openGalaxy() {
          if (closed) return;
          const page = nextPage();
          try {
            if (nativeTools) {
              await showConsole();
              return;
            }
            const status =
              await store.getGalaxyIntegrationStatus(dataDirectory);
            if (closed || page !== pageGeneration) return;
            if (status.recoveryRequired) {
              showInfo(
                'Galaxy / 本地恢复',
                '本地初始化或重置曾中断。请保留现有文件，检查待完成的操作后，再明确恢复初始化或重置。\n\n当前只读查看不会创建新身份、删除文件或自动恢复。',
                closeGalaxy,
              );
              return;
            }
            if (status.initialized) {
              await showConsole(status);
              return;
            }
            await showConsole(status);
          } catch (error) {
            if (closed || page !== pageGeneration) return;
            showInfo(
              'Galaxy',
              `无法打开本机 Galaxy：${String(error instanceof Error ? error.message : error)}`,
              closeGalaxy,
            );
          }
        }

        const disposeRoot = api.keymap.registerLayer({
          commands: [
            {
              name: 'galaxy.open',
              title: 'Galaxy',
              desc: '进入 Galaxy：让真实工作中的难题找到更合适的协作路径。',
              category: 'Galaxy',
              namespace: 'palette',
              slashName: 'galaxy',
              slashAliases: ['Galaxy'],
              run: () => void openGalaxy(),
            },
          ],
        });
        disposeHost = () => {
          closeGalaxy();
          disposeRoot();
        };
        if (connectionUnavailable)
          api.ui.toast?.({
            variant: 'warning',
            title: '银河 · 在线连接暂不可用',
            message:
              '本地记录可以继续使用。需要在线服务时，请在设置中恢复原连接。',
          });
        // Installation normally prepared the identity already. An older/manual
        // install with no identity gets one actual agreement here, not a menu hunt.
        if (recordWork && nativeTools && workRecorder) {
          await workRecorder.ready;
          try {
            if (
              !closed &&
              !(await workRecorder.history.identity()) &&
              !(hostPersistence?(await hostPersistence.preparationStatus()).deferred:await isOpenCodePreparationDeferred(dataDirectory))
            )
              await showQuickInitialize(closeGalaxy, true);
          } catch {
            api.ui.toast?.({
              variant: 'warning',
              title: '银河 · 本地资料暂不可读',
              message: '已有资料保留。可在设置中恢复原资料位置后继续。',
            });
          }
        }
      } catch (error) {
        void close();
        throw error;
      }
    },
  };
}

// OpenCode caches the plugin module across deactivate/activate. Each activation
// owns a fresh runtime; the factory itself remains a single-use adapter.
export function createGalaxyPlugin(
  createAdapter: () =>
    | ReturnType<typeof createGalaxyAdapter>
    | Promise<ReturnType<typeof createGalaxyAdapter>> = createGalaxyAdapter,
) {
  return {
    id: 'galaxy.opencode.stable.tui',
    tui: async (api: StableHostApi) => {
      const adapter = await createAdapter();
      await adapter.tui(api);
    },
  };
}

export default createGalaxyPlugin();
