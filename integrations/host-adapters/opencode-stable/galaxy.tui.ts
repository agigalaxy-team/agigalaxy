import type { Action, Routes, Menu, MenuOption, Prompt, ModuleEntry, StableHostApi, ConnectionController, CaseSubmission, HistoryFilters, AdapterCore, PublicationDraft, HistoryItem, DiscoverySource, BindingReceiptView, HostWorkContext, HostWorkResult } from './adapter-types.ts';
import { createDeletionMenu } from './deletion-menu.mjs';
import { createLocalDeletionRecords } from '../local-deletion-records.mjs';
import { createDataExportMenu } from './data-export-menu.mjs';
import { createProfileMenu } from './profile-menu.mjs';
import { createCaseReviewMenu } from './case-review-menu.mjs';
import { createSearchMenu } from './search-menu.mjs';
import { createSearchFeedbackMenu } from './search-feedback-menu.mjs';
import { createBuilderMenu } from './builder-menu.mjs';
import { createAuditMenu } from './audit-menu.mjs';
import { createA2aMenu } from './a2a-menu.mjs';
import { createAssistanceMenu } from './assistance-menu.mjs';
import { createAssistanceDraftMenu } from './assistance-draft-menu.mjs';
import { createContextDraftMenu } from './context-draft-menu.mjs';
import { createBindingManagementMenu } from './binding-management-menu.mjs';
import { createIdentityMenu } from './identity-menu.mjs';
import { describeConnectionState } from './connection-state.mjs';
import { createPurposeMenu } from './purpose-menu.mjs';
import { showExactChoice } from './exact-choice.mjs';
import {readableDialogSelect} from './dialog-reading.mjs';
import {sourceReadingText} from './source-reading.mjs';

const MODULE_LABELS: Record<string, string> = {
  'galaxy-id': '银河 ID 与本地身份卡',
  'case-workspace': '工作中的 Case 与本地历史',
  'consent-controls': '隐私、披露与授权记录',
  'agent-mcp': 'Agent / MCP 接入',
  'agent-guidance': 'AI 引导与初始化支持',
};

function divider() {
  return '────────────────────────────────────────';
}

// The stable OpenCode Dialog can soft-wrap mixed CJK/Latin text without
// reserving a full second row. These intentional short lines avoid overlap.
function localBoundary(language = 'zh-CN') {
  return language === 'en-US'
    ? 'Local only · no remote account · no sync\nNo public Proof · no Worker / Hub'
    : '仅本机运行 · 无远程账户 · 无同步\n无公开 Proof · 无 Worker / Hub';
}

function formatModules(modules: (string | ModuleEntry)[] = [], catalog: ModuleEntry[] = [], language = 'zh-CN') {
  const catalogById = new Map(catalog.map((module) => [module.id, module]));
  return modules.map((module) => {
    const id = typeof module === 'string' ? module : module.id;
    const title = (language === 'zh-CN' ? MODULE_LABELS[id] : null)
      ?? (typeof module === 'string' ? undefined : module.title)
      ?? catalogById.get(id)?.title
      ?? id;
    return `• ${title}`;
  }).join('\n');
}

function compactModules(modules: (string | ModuleEntry)[], language: string) {
  const labels: Record<string, string> = language === 'zh-CN'
    ? { 'galaxy-id': '银河ID/身份卡', 'case-workspace': 'Case/本地历史', 'consent-controls': '隐私/披露/授权', 'agent-mcp': 'Agent/MCP', 'agent-guidance': 'AI引导/初始化' }
    : { 'galaxy-id': 'Galaxy ID', 'case-workspace': 'Case/history', 'consent-controls': 'Disclosure/consent', 'agent-mcp': 'Agent/MCP', 'agent-guidance': 'AI setup guidance' };
  const titles = modules.map(module => { const id = typeof module === 'string' ? module : module.id; return labels[id] ?? id; });
  const lines = [];
  for (let i = 0; i < titles.length; i += 2) lines.push(titles.slice(i, i + 2).join(' · '));
  return lines.join('\n');
}

export function createGalaxyAdapter(connectionController: ConnectionController | null = null, { readCaseSubmission = null, discovery = null, dataDirectory: configuredDirectory, nativeTools = null, readWorkContext = null }: { readCaseSubmission?: (() => Promise<CaseSubmission | null>) | null; discovery?: DiscoverySource | null; dataDirectory?: string; nativeTools?: {call(name:string,args:Record<string,unknown>):Promise<unknown>;openLink?:(url:string)=>Promise<unknown>} | null; readWorkContext?: (()=>Promise<HostWorkContext | null>) | null } = {}) {
let closed = false, attached = false;
let disposeHost: Action | null = null;
let disposeLifecycle: Action | null = null;
function close() {
  if (closed) return;
  closed = true;
  try { disposeHost?.(); }
  finally {
    disposeHost = null;
    try { connectionController?.disconnect(); }
    finally { discovery?.close(); disposeLifecycle?.(); disposeLifecycle = null; }
  }
}
function requiredController(): ConnectionController {
  if (!connectionController) throw new Error('Galaxy connection runtime unavailable.');
  return connectionController;
}
function clearConnectionController() { connectionController = null; }
function controllerMethod<K extends keyof ConnectionController>(key: K): NonNullable<ConnectionController[K]> {
  const method = requiredController()[key];
  if (method === undefined || method === null) throw new Error('Galaxy connection operation unavailable.');
  return method;
}
return {
  id: 'galaxy.opencode.stable.tui',
  close,
  tui: async (api: StableHostApi) => {
    if (closed || attached) throw new Error('Galaxy adapter is closed or already attached.');
    attached = true;
    if (api.lifecycle) {
      const signal = api.lifecycle.signal;
      if (signal.aborted) { close(); return; }
      signal.addEventListener('abort', close, { once: true });
      const unregister = api.lifecycle.onDispose(close);
      disposeLifecycle = () => { signal.removeEventListener('abort', close); unregister(); };
    }
    try {
    const [core, store, connection] = await Promise.all([
      import('../../../packages/galaxy-core/src/integration-modules.mjs'),
      import('../../../packages/galaxy-core/src/local-store.mjs'),
      import('../../../packages/galaxy-core/src/connection-profile.mjs'),
    ]) as [AdapterCore, typeof import('../../../packages/galaxy-core/src/local-store.mjs'), typeof import('../../../packages/galaxy-core/src/connection-profile.mjs')];
    if (closed) return;
    const dataDirectory = configuredDirectory ?? process.env.GALAXY_DATA_DIR;
    let discoveryAbort: AbortController | null = null;
    let disposeMenuKeys: Action | null = null;
    let activeLanguage = 'zh-CN';
    let connectionGeneration = 0;
    let pageGeneration = 0;
    let visiblePage: number | null = null;
    let pendingConnection: object | null = null;
    let purposeMenu: ReturnType<typeof createPurposeMenu> | null = null;

    function clearMenuKeys() {
      if (disposeMenuKeys) disposeMenuKeys();
      disposeMenuKeys = null;
    }

    function closeGalaxy() {
      connectionGeneration++;
      pageGeneration++;
      discoveryAbort?.abort();
      connectionController?.cancel();
      pendingConnection = null;
      purposeMenu?.close(); purposeMenu = null;
      clearMenuKeys();
      if (visiblePage !== null) {
        visiblePage = null;
        api.ui.dialog.setSize('medium');
        api.ui.dialog.clear();
      }
    }

    async function currentWorkContext(): Promise<HostWorkContext | null> {
      if (readWorkContext) return readWorkContext();
      const route = api.route?.current, state = api.state;
      const sessionId = route?.name === 'session' ? route.params?.sessionID : undefined;
      if (!sessionId || !state) return null;
      const lastUser = [...state.session.messages(sessionId)].reverse().find(message => message.role === 'user');
      const query = lastUser ? state.part(lastUser.id).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').trim() : '';
      // The current host session is local return context. It is never inferred
      // to be a Galaxy Task/Case, nor shared as a new social/work object.
      return { origin: { host: 'opencode', workRef: sessionId }, ...(query ? { query } : {}) };
    }

    async function returnToWork(result?: HostWorkResult): Promise<void> {
      if (!result) { closeGalaxy(); return; }
      const page = pageGeneration;
      if (!api.client?.tui.appendPrompt) {
        showInfo(activeLanguage === 'zh-CN' ? '带回原工作' : 'Return to original work',
          (activeLanguage === 'zh-CN' ? '当前宿主没有提供把内容放入原输入的接口。可以阅读以下内容后继续原工作。\n\n' : 'This host cannot append content to the original input. Read the content below before continuing.\n\n')
            + result.content + (result.sourceUrl ? '\n\n' + result.sourceUrl : ''), closeGalaxy);
        return;
      }
      const text = '\n\n' + (activeLanguage === 'zh-CN' ? '银河 · ' : 'Galaxy · ') + result.title + '\n\n' + result.content
        + (result.sourceUrl ? '\n\n' + (activeLanguage === 'zh-CN' ? '来源：' : 'Source: ') + result.sourceUrl : '') + '\n';
      try {
        const response = await api.client.tui.appendPrompt({ text });
        if (closed || page !== pageGeneration) return;
        if (response.data !== true) throw new Error('host_input_not_confirmed');
        closeGalaxy();
      } catch {
        if (closed || page !== pageGeneration) return;
        showInfo(activeLanguage === 'zh-CN' ? '原工作输入尚待确认' : 'Original input needs checking',
          (activeLanguage === 'zh-CN' ? '未能确认内容是否已放入原输入。先回到原工作查看，避免重复加入；这里不会发送给模型。\n\n' : 'The host did not confirm whether content was appended. Check the original input before adding it again. No model prompt was submitted.\n\n')
            + result.content + (result.sourceUrl ? '\n\n' + result.sourceUrl : ''), closeGalaxy);
      }
    }

    function installMenuKeys(routes: Routes, onEscape: Action | null, onHelp: Action | null, { includeZero = true } = {}) {
      clearMenuKeys();
      const commands = [];
      const bindings = [];
      for (const [number, handler] of Object.entries(routes)) {
        if (number === '0') continue;
        const activate = handler as () => void;
        const name = `galaxy.choose.${number}`;
        commands.push({ name, title: `Galaxy 选择 ${number}`, run: () => activate() });
        bindings.push({ key: number, cmd: name, desc: `选择 ${number}` });
      }
      commands.push(
        { name: 'galaxy.exit', title: '退出 Galaxy', run: () => onEscape?.() },
        { name: 'galaxy.help', title: 'Galaxy 交互规则', run: () => onHelp?.() },
      );
      if (includeZero) {
        commands.push({ name: 'galaxy.zero', title: 'Galaxy 返回或退出', run: () => (routes[0] ?? closeGalaxy)() });
      }
      bindings.push(
        { key: 'escape', cmd: 'galaxy.exit', desc: '退出 Galaxy' },
        { key: 'question', cmd: 'galaxy.help', desc: '交互规则' },
      );
      if (includeZero) bindings.push({ key: '0', cmd: 'galaxy.zero', desc: '返回或退出 Galaxy' });
      const disposeLayer = api.keymap.registerLayer({ mode: 'modal', commands, bindings });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true; disposeLayer();
        if (disposeMenuKeys === dispose) disposeMenuKeys = null;
      };
      disposeMenuKeys = dispose;
      return dispose;
    }

    function pageCleanup(page: number, disposeKeys: Action, isTransition = () => false) {
      visiblePage = page;
      return () => {
        disposeKeys();
        if (visiblePage !== page) return;
        visiblePage = null;
        // Native Esc/backdrop dismissal need not invoke DialogPrompt.onCancel.
        // Internal page replacement and confirmed native transitions are distinct.
        if (!isTransition()) closeGalaxy();
      };
    }

    function showInfo(title: string, message: string, onConfirm: Action) {
      if (closed) return;
      const page = ++pageGeneration;
      let transitioning = false;
      const cleanup = pageCleanup(page, installMenuKeys({}, closeGalaxy, null, { includeZero: false }), () => transitioning);
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(
        // DialogAlert closes itself after onConfirm returns. Defer the next Galaxy page
        // so the host cannot close the newly opened controller page with the old alert.
        () => api.ui.DialogAlert({ title, message, onConfirm: () => {
          transitioning = true;
          setTimeout(() => { transitioning = false; if (!closed && page === pageGeneration) onConfirm?.(); }, 0);
        } }),
        cleanup,
      );
    }

    function showPrompt({ title, placeholder, value, onConfirm, onCancel = closeGalaxy }: Prompt) {
      if (closed) return;
      const page = ++pageGeneration;
      let transitioning = false;
      // A prompt collects actual content or a value required by the operation.
      // Authorization comes from the corresponding exact native choice.
      const cleanup = pageCleanup(page, installMenuKeys({}, closeGalaxy, null, { includeZero: false }), () => transitioning);
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(
        () => api.ui.DialogPrompt({
          title,
          placeholder,
          ...(value===undefined?{}:{value}),
          onConfirm: (value) => {
            transitioning = true;
            setTimeout(() => { transitioning = false; if (!closed && page === pageGeneration) onConfirm(value); }, 0);
          },
          onCancel: () => setTimeout(() => { if (!closed && page === pageGeneration) onCancel(); }, 0),
        }),
        cleanup,
      );
    }

    function showRules(onReturn: Action) {
      showInfo(
        'Galaxy / 交互规则',
        `数字是主入口：输入本屏显示的 [1]–[9] 可直接选择。\n\n[0] 只在 Galaxy 控制台主页退出；在二级页面返回 Galaxy 控制台或上一步。\nEsc 在任何 Galaxy 页面直接退出到聊天；Enter 与方向键可使用 OpenCode 的原生选择器。\n\n${divider()}\n浏览、返回和退出不会写入本机状态。只有确认初始化或未来明确标注的确认操作才会改变本机 Galaxy。`,
        onReturn,
      );
    }

    function showSelect(input: Menu) {
      const prepared: Menu=readableDialogSelect(input);
      const {title,options,routes:inputRoutes,onBack,onEscape=closeGalaxy}=prepared;
      let routes: Routes=inputRoutes;
      if (closed) return;
      const page = ++pageGeneration;
      let transitioning = false;
      routes = { 0: onBack, ...routes };
      const reopen = () => showSelect({ title, options, routes, onBack, onEscape });
      const cleanup = pageCleanup(page, installMenuKeys(routes, onEscape, () => showRules(reopen)), () => transitioning);
      api.ui.dialog.setSize('xlarge');
      api.ui.dialog.replace(
        () => api.ui.DialogSelect({
          title: `${title}\n\n[0] 返回 · Esc 回到原工作`,
          skipFilter: true,
          options: options.map((option) => ({
            title: option.number ? `[${option.number}] ${option.title}` : option.title,
            description: option.description,
            value: option.number,
            disabled: option.disabled === true,
            // Native Select closes itself after selection. Defer a page transition so
            // its cleanup cannot dismiss the next Galaxy page.
            onSelect: () => {
              transitioning = true;
              setTimeout(() => { transitioning = false; if (!closed && page === pageGeneration) {
                if(option.reading)showInfo(title,option.description??'',reopen);else routes[option.number]?.();
              } }, 0);
            },
          })),
        }),
        cleanup,
      );
    }

    function showLanguage() {
      showSelect({
        title: 'Galaxy / 选择语言',
        options: [
          { number: '1', title: '简体中文', description: '以中文开始 Galaxy 本机引导。' },
          { number: '2', title: 'English', description: 'Start Galaxy in English.' },
        ],
        routes: {
          1: () => showWelcome('zh-CN'),
          2: () => showWelcome('en-US'),
        },
        onBack: closeGalaxy,
      });
    }

    function showWelcome(language: string) {
      activeLanguage = language;
      const contract = core.getGalaxyInitializationContract({ language, stage: 1 });
      const welcome = contract.currentStage.welcome;
      if (!welcome) throw new Error('Galaxy welcome contract unavailable.');
      const chinese = language === 'zh-CN';
      showInfo(
        welcome.title,
        `${welcome.purpose}\n\n${welcome.vision}\n\n${divider()}\n${chinese ? '按 Enter 选择 Galaxy 形态。' : 'Press Enter to choose a Galaxy form.'}`,
        () => showInitializationStage(language, 1),
      );
    }

    function showPrivacyTerms(language: string) {
      const chinese = language === 'zh-CN';
      showInfo(
        chinese ? 'Galaxy / 隐私条款' : 'Galaxy / Privacy terms',
        chinese
          ? '本页只读，不修改配置，也不联网。\n仅本地：配置、ID和设备密钥。\n无远程账户、上传、公开Proof或同步。\n匿名发现不发送ID/Case/Context。\n绑定另需端点、Scope、确认、签名。\n受控披露（未启用）：Context Grant\n需可预览、限期、可撤销及远程授权。\n网络贡献（未启用）：需Evidence、\n可见性、撤销、发布门槛；无信誉结论。\n每项授权限定接收方/用途/字段/时限。\n按 Enter 返回隐私选择；Esc 退出。'
          : 'Read-only page; no writes or network access.\nLocal only: configuration, ID and device-held keys.\nNo remote account, uploads, public Proof or sync.\nAnonymous discovery sends no ID/Case/Context.\nBinding needs endpoint, Scope, confirmation, signature.\nControlled sharing (off): previewable, expiring,\nrevocable Context Grant and remote authorization.\nNetwork contribution (off): Evidence, visibility,\nrevocation and release gates; no reputation claim.\nGrants bound recipient, purpose, fields and expiry.\nEnter returns to privacy; Esc exits.',
        () => showInitializationStage(language, 3),
      );
    }

    function showInitializationStage(language: string, stageNumber: number) {
      activeLanguage = language;
      const contract = core.getGalaxyInitializationContract({
        language,
        stage: stageNumber,
        hostCapabilities: { nativeSingleSelect: true, nativeConfirm: true },
      });
      const stage = contract.currentStage;
      const chinese = language === 'zh-CN';
      const previous = stageNumber === 1 ? showLanguage : () => showInitializationStage(language, stageNumber - 1);

      if (stageNumber === 5) {
        const preview = store.previewGalaxyIntegration({ initializationPath: 'personal-galaxy' });
        const confirmation = chinese ? '确认初始化' : 'Confirm initialization';
        showPrompt({
          title: chinese
            ? `${contract.header.title} · 阶段 5 / 5\n个人银河 · 仅本地 · 新 Galaxy ID\nL3 推荐：${compactModules(preview.modules, language)}\n保存L3快照/空连接意图；未连接\n无远程账户/上传/Proof发布/同步\n不启动Worker/Hub；请输入“确认初始化”\n“返回”改身份；“取消”退出且不写入。`
            : `${contract.header.title} · Step 5 / 5\nPersonal Galaxy · local only · new Galaxy ID\nL3 recommended: ${compactModules(preview.modules, language)}\nSave L3 snapshot/empty intentions; not connected.\nNo remote account, uploads, Proof, sync, Worker/Hub.\nType “Confirm initialization” to create locally.\n“back” changes identity; “cancel” exits without writes.`,
          placeholder: confirmation,
          onConfirm: async (value) => {
            const input = value.trim();
            if (input === confirmation) {
              try {
                const initialized = await store.initializeGalaxyIntegration(dataDirectory, {
                  initializationPath: 'personal-galaxy',
                  source: 'opencode-native-tui',
                });
                await showConsole(initialized);
              } catch (error) {
                showInfo(chinese ? '初始化未完成' : 'Initialization did not complete', String(error instanceof Error ? error.message : error), () => showInitializationStage(language, 5));
              }
              return;
            }
            if (input === (chinese ? '返回' : 'back')) {
              previous();
              return;
            }
            if (input === (chinese ? '取消' : 'cancel')) {
              closeGalaxy();
              return;
            }
            showInfo(
              chinese ? '尚未确认初始化' : 'Initialization not confirmed',
              chinese
                ? '没有写入任何本机状态。请输入精确的“确认初始化”，或输入“返回”修改选择。'
                : 'No local state was written. Type the exact phrase “Confirm initialization”, or type “back” to change a choice.',
              () => showInitializationStage(language, 5),
            );
          },
          onCancel: closeGalaxy,
        });
        return;
      }

      let stageTitle = `${stage.title}\n${stage.prompt}${stage.note ? `\n\n${stage.note}` : ''}`;
      if (stageNumber === 2) {
        const preview = store.previewGalaxyIntegration({ initializationPath: 'personal-galaxy' });
        stageTitle = `${stage.title}\n${compactModules(preview.modules, language)}\n${chinese
          ? '本地准备，未连接；本地发现/Hub未启用'
          : 'Local preparation only; discovery/Hub not enabled.'}`;
      }
      if (stageNumber === 3) stageTitle = `${stage.title}\n${chinese
        ? 'Official默认/Hub可选；未连接，仅本地'
        : 'Official default; Hub optional. Not connected.'}`;
      const options: Menu['options'] = stageNumber === 2
        ? [{ number: '1', title: chinese ? '采用 L3（已预选）' : 'Use L3 (preselected)', description: chinese ? '继续查看接入与可见性；最终确认前不保存。' : 'Review connection and visibility; nothing is saved before final confirmation.' }]
        : stage.options.map((option, index) => ({
          number: String(index + 1),
          title: option.title,
          description: option.description ?? option.disabledReason ?? '',
          disabled: option.selectable !== true,
        }));

      const routes: Routes = { 0: previous };
      const selectable = options.find((option) => !option.disabled);
      if (selectable) routes[selectable.number] = () => showInitializationStage(language, stageNumber + 1);
      if (stageNumber === 3) {
        options.push({
          number: '4',
          title: chinese ? '阅读隐私条款' : 'Read privacy terms',
          description: chinese ? '查看三个层级的写入、披露与规划边界；返回后仍停在本页。' : 'Review writing, disclosure, and planned boundaries for all three levels; then return here.',
        });
        routes[4] = () => showPrivacyTerms(language);
      }
      showSelect({
        title: `${contract.header.title} · ${chinese ? `阶段 ${stageNumber} / 5` : `Step ${stageNumber} / 5`}\n${stageTitle}`,
        options: [...options, { number: '0', title: chinese ? '返回' : 'Back', description: chinese ? '回到上一步，不写入本地状态。' : 'Return to the previous step without writing local state.' }],
        routes,
        onBack: previous,
      });
    }

    async function showStatus(onBack: Action) {
      const status = await store.getGalaxyIntegrationStatus(dataDirectory);
      const id = status.galaxyId?.id ?? '尚未创建';
      const modules = status.integration?.modules ?? [];
      showInfo(
        'Galaxy / 本机状态',
        `Galaxy ID：${id}\n\n${localBoundary(activeLanguage)}\n\n${divider()}\n当前本机能力\n${formatModules(modules, status.catalog?.modules, activeLanguage) || '• 尚未启用模块'}\n\n状态查询只读；按 Enter 返回控制台。`,
        onBack,
      );
    }

    async function showConnection(onBack: Action) {
      if (connectionController) return showManagedConnection(onBack);
      if (discovery) return showDiscovery(onBack);
      const chinese = activeLanguage === 'zh-CN';
      try {
        const contract = await connection.getGalaxyConnectionStatus(dataDirectory);
        const targetLines = contract.targets.map((target: { kind: string; endpoint: string }) => `${target.kind}: ${target.endpoint}\n  ${chinese ? '已配置，未验证、未连接' : 'Configured, unverified, disconnected'}`);
        const scopeLines = contract.scopes.map((scope: { action: string; state: string; recipient: string; purpose: string; visibleFields: string[]; expiresAt: string }) => `${scope.action}: ${scope.state}\n  ${scope.recipient} · ${scope.purpose}\n  ${scope.visibleFields.join(', ')}\n  ${scope.expiresAt}\n  ${chinese ? '不具备外发权限' : 'No transfer permission'}`);
        showInfo(
          chinese ? 'Galaxy / 接入银河' : 'Galaxy / Connect to Galaxy',
          [
            chinese ? '连接状态：未连接' : 'Connection: not connected',
            contract.appliedCapabilityProfile === 'l3-foundation'
              ? (chinese ? 'L3 本地能力包已确认' : 'L3 local package confirmed')
              : (chinese ? 'L3 尚未应用；保留现有本地配置' : 'L3 not applied; existing local configuration retained'),
            '',
            chinese ? 'Official：默认公共信息入口，尚未读取 Manifest。\nHub：可选自治端点；本页仅查看配置。' : 'Official: default public entry; Manifest not fetched.\nHub: optional autonomous endpoints; this page is read-only.',
            ...targetLines,
            ...(targetLines.length ? [] : [chinese ? '尚未配置远程端点。' : 'No remote endpoints configured.']),
            '',
            ...scopeLines,
            ...(scopeLines.length ? [] : [chinese ? '没有 Scope 授权。' : 'No Scope grants.']),
            '',
            chinese ? '不读取远程信息、不签名、不绑定、不传输。\n按 Enter 返回控制台；Esc 退出。' : 'No remote reads, signing, binding or transfer.\nEnter returns to console; Esc exits.',
          ].join('\n'),
          onBack,
        );
      } catch (error) {
        showInfo(chinese ? '连接配置无法读取' : 'Connection configuration unavailable', String(error instanceof Error ? error.message : error), onBack);
      }
    }

    function showLocalSearchFeedback(onBack: Action) {
      const source = discovery ?? connectionController;
      if (!source?.querySearchFeedback || !source.editSearchFeedback) return;
      const current = ++connectionGeneration;
      void createSearchFeedbackMenu({controller: source, select: showSelect, info: showInfo, language: activeLanguage,
        isCurrent: () => current === connectionGeneration, onBack}).open();
    }

    function showDiscovery(onBack: Action) {
      if (!discovery) return;
      const source = discovery;
      const chinese = activeLanguage === 'zh-CN';
      const version = ++connectionGeneration;
      const back = () => { connectionGeneration++; discoveryAbort?.abort(); onBack(); };
      showSelect({
        title: `${chinese ? 'Galaxy / 服务信息' : 'Galaxy / Service information'}\n${source.endpoint}\n${source.scopes.join(', ')}\n${describeConnectionState(source.status().state, activeLanguage, 'discovery')}`,
        options: [{ number: '1', title: chinese ? '读取服务信息' : 'Read service information',
          description: chinese ? '匿名读取 Manifest；连接另行预览确认' : 'Read Manifest anonymously; connection requires a separate preview' },
          { number: '2', title: chinese ? '本机绑定回执' : 'Local binding receipts', description: chinese ? '离线查看，不读取远端信息' : 'Read offline; no remote request' },
          { number: '3', title: chinese ? '本机反馈汇总' : 'Local feedback summary', description: chinese ? '离线查看、修改或移除个人反馈' : 'View, edit or remove personal feedback offline' },
          { number: '4', title: chinese ? '本地协作草稿' : 'Local collaboration drafts', description: chinese ? '离线续填与查看提交记录' : 'Edit offline and inspect local submission records' },
          { number: '5', title: chinese ? '本地材料草稿' : 'Local material drafts', description: chinese ? '离线编辑选定材料，不重新开放授权' : 'Edit selected materials offline without reopening access' }],
        routes: { 5: () => {if(version!==connectionGeneration)return;const current=++connectionGeneration;
            createContextDraftMenu({controller:source,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
              canSubmit:false,isCurrent:()=>current===connectionGeneration,onBack:()=>showDiscovery(onBack),onConfirm:undefined,onOpenGrant:undefined}).open();
          }, 4: () => { if(version!==connectionGeneration)return;const current=++connectionGeneration;
            createAssistanceDraftMenu({controller:source,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,readWorkContext,
              canSubmit:false,isCurrent:()=>current===connectionGeneration,onBack:()=>showDiscovery(onBack),onConfirm:undefined,onOpenRequest:undefined}).open();
          }, 3: () => { if(version===connectionGeneration)showLocalSearchFeedback(() => showDiscovery(onBack)); },
          2: () => void showBindingReceipts(() => showDiscovery(onBack)), 1: async () => {
          if (version !== connectionGeneration) return;
          const current = ++connectionGeneration;
          discoveryAbort?.abort();
          const abort = new AbortController(); discoveryAbort = abort;
          showSelect({ title: chinese ? '正在读取服务信息…' : 'Reading service information…', options: [], routes: {}, onBack: back });
          try {
            const result = await source.read(abort.signal);
            if (abort.signal.aborted || current !== connectionGeneration) return;
            connectionController = result.controller;
            const clean = (text: string) => text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ');
            showInfo(chinese ? '服务信息已验证' : 'Service information verified',
              `${result.networkType === 'hub' ? 'Hub' : 'Official'}\n${clean(result.displayName)}\n${clean(result.operator)}\n${source.endpoint}\n${new Date(result.checkedAt * 1000).toISOString()}\n${chinese ? '信息签名有效；尚未连接或授权' : 'Valid signature; not connected or authorized'}`,
              () => { if (current === connectionGeneration) void showManagedConnection(onBack); });
          } catch {
            if (!abort.signal.aborted && current === connectionGeneration)
              showInfo(chinese ? '服务信息读取失败' : 'Service information unavailable',
                describeConnectionState(source.status().state, activeLanguage, 'discovery'),
                () => { if (current === connectionGeneration) showDiscovery(onBack); });
          } finally { if (discoveryAbort === abort) discoveryAbort = null; }
        } }, onBack: back,
      });
    }

    async function showManagedConnection(onBack: Action) {
      const connectionController = requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const back = () => { connectionGeneration++; controllerMethod('cancel')(); pendingConnection = null; onBack(); };
      const reopen = () => void showManagedConnection(onBack);
      try {
        const status = await controllerMethod('status')();
        if (version !== connectionGeneration) return;
        const managesData=!!(connectionController.queryBindings||connectionController.querySearchFeedback||connectionController.listBindingReceipts
          ||(connectionController.queryHistory&&status.scopes?.includes('history'))||(connectionController.readAudit&&status.scopes?.includes('audit'))
          ||(connectionController.saveDataExport&&status.scopes?.includes('data-export'))||((connectionController.readDeletion&&status.scopes?.includes('data-delete'))||connectionController.prepareDeletionStatus));
        showSelect({
          title: `${chinese ? 'Galaxy / 连接与专业入口' : 'Galaxy / Connection and professional tools'}\n${describeConnectionState(status.state, activeLanguage)}\n${chinese?'服务：':'Service: '}${status.endpoint}\n${discovery ? describeConnectionState(discovery.status().state, activeLanguage, 'discovery') : ''}\n${'receiptSaveState' in status && status.receiptSaveState === 'save-failed' ? (chinese ? '本机回执保存失败；请检查本机存储，不要重复绑定' : 'Local receipt save failed; check local storage, do not repeat binding') : ''}`,
          options: [
            { number: '1', title: chinese ? '预览连接' : 'Preview connection', description: chinese ? '先显示准确请求；确认前不联网或签名' : 'Review exact request before signing or network activity' },
            { number: '2', title: chinese ? '断开本机会话' : 'Disconnect local session', description: chinese ? '丢弃本机凭据；不声称已撤销远端绑定' : 'Discard local credential; does not revoke remote binding' },
            ...(connectionController.checkRemote||managesData ? [{ number: '3', title: managesData
              ? (chinese ? '设备与本人资料' : 'Devices and my data') : (chinese ? '核查远端绑定' : 'Check remote binding'), description: chinese ? '读取当前获准的原记录或处理本人资料。' : 'Read currently authorized records or manage my data.' }] : []),
            ...((connectionController.querySearch&&['history','proof','capsules','builders'].some(scope=>status.scopes?.includes(scope))||connectionController.queryHistory&&status.scopes?.includes('history')) && status.state === 'session-local'
              ? [{ number: '4', title: connectionController.querySearch?(chinese?'分类型搜索':'Search by source'):(chinese ? '查询履历' : 'Search history'), description: chinese ? '向上方端点发送关键词，保留当前可见记录的来源类型' : 'Send search terms and retain authorized source types' }] : []),
            ...(connectionController.prepareCase && readCaseSubmission && status.scopes?.includes('case-teaser') && status.state === 'session-local'
              ? [{ number: '5', title: chinese ? '提交已授权草稿' : 'Submit authorized draft', description: chinese ? '预览宿主选中的 Case / 纠正记录；确认后提交' : 'Preview the selected Case/review draft before submitting' }] : []),
            ...(connectionController.listPublicationDrafts && status.state === 'session-local' && ['consent', 'case-teaser'].every(scope => status.scopes?.includes(scope))
              ? [{ number: '6', title: chinese ? '发布本地草稿' : 'Publish local draft', description: chinese ? '选择草稿和可见性，确认授权与内容后提交' : 'Select a draft and visibility, then review Consent and content' }] : []),
            ...(connectionController.queryBuilders && status.state === 'session-local' && status.scopes?.includes('builders')
              ? [{ number: '8', title: chinese ? '建设者登记' : 'Builder registry', description: chinese ? '登记Worker、Bridge和Hub；查看兼容报告与维护状态' : 'Register Worker, Bridge and Hub declarations; read reports and maintenance' }] : []),
            ...(connectionController.queryAssistance && status.state === 'session-local' && status.scopes?.includes('assistance')
              ? [{ number: '7', title: chinese ? '协作请求' : 'Collaboration', description: chinese ? '发现、申请和处理协作' : 'Find, apply and manage requests' }] : []),
            ...(connectionController.readA2a && status.state === 'session-local' && status.scopes?.includes('case-teaser')
              ? [{ number: '9', title: chinese ? 'A2A 外部任务' : 'A2A external tasks', description: chinese ? '选择端点、发送内容与跟踪结果' : 'Choose an endpoint, send selected text and track results' }] : []),
          ],
          routes: { 9: () => { if (version === connectionGeneration && connectionController.readA2a) {
              const current = ++connectionGeneration;
              createA2aMenu({controller: connectionController, select: showSelect, prompt: showPrompt, info: showInfo, language: activeLanguage,
                availableScopes: status.scopes, readWorkContext, onReturnWork:closeGalaxy, onBack: reopen, isCurrent: () => current === connectionGeneration}).open();
            } }, 8: () => { if (version === connectionGeneration && connectionController.queryBuilders) {
              const current = ++connectionGeneration;
              createBuilderMenu({controller: connectionController, select: showSelect, prompt: showPrompt, info: showInfo, language: activeLanguage,
                availableScopes: status.scopes, onReturnWork:closeGalaxy,onBack: reopen, isCurrent: () => current === connectionGeneration}).open();
            } }, 1: () => void previewConnection(onBack), 2: () => { controllerMethod('disconnect')(); if (discovery) { clearConnectionController(); showDiscovery(onBack); } else reopen(); },
            3: () => { if (version !== connectionGeneration) return;
              if (!managesData) { if (connectionController.checkRemote) void checkRemoteBinding(onBack); return; }
              showSelect({ title: chinese ? '设备与本人资料' : 'Devices and my data',
                options: [...(connectionController.checkRemote?[{ number: '1', title: chinese ? '核查远端绑定' : 'Check remote binding', description: '' }]:[]),
                  ...(connectionController.readIdentity&&status.state==='session-local'?[{number:'9',title:chinese?'外部账户关联':'External accounts',description:chinese?'关联或撤销OIDC账户':'Link or unlink an OIDC account'}]:[]),
                  ...(connectionController.queryBindings&&status.state==='session-local'? [{number:'8',title:chinese?'本人设备与绑定':'My installations and bindings',description:chinese?'查看安装实例、当前绑定及撤销入口':'View installations, current bindings and revocation'}]:[]),
                  ...(connectionController.readAudit && status.scopes?.includes('audit') ? [{ number: '2', title: chinese ? '审计记录与授权' : 'Audit records and approval', description: '' }] : []),
                  ...(connectionController.saveDataExport && status.scopes?.includes('data-export') ? [{ number: '3', title: chinese ? '导出本人资料' : 'Export my data', description: '' }] : []),
                  ...(((connectionController.readDeletion && status.scopes?.includes('data-delete')) || connectionController.prepareDeletionStatus) ? [{ number: '4', title: chinese ? '数据删除申请' : 'Data deletion requests', description: '' }] : []),
                  ...(connectionController.listBindingReceipts ? [{ number: '5', title: chinese ? '本机绑定回执' : 'Local binding receipts', description: chinese ? '只读历史；不会恢复会话或联网' : 'Read local history; no session restore or network' }] : []),
                  ...(connectionController.queryHistory && status.scopes?.includes('history') && status.state === 'session-local' ? [{ number: '6', title: chinese ? '我的资料与自述' : 'My Profile and self description', description: chinese ? '自述与事实履历分别展示' : 'Self description and factual history shown separately' }] : []),
                  ...(connectionController.querySearchFeedback ? [{ number: '7', title: chinese ? '本机反馈汇总' : 'Local feedback summary', description: chinese ? '离线查看、修改或移除个人反馈' : 'View, edit or remove personal feedback offline' }] : [])],
                routes: { 9:()=>{if(version!==connectionGeneration||!connectionController.readIdentity)return;const current=++connectionGeneration;
                    createIdentityMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,isCurrent:()=>current===connectionGeneration,onBack:reopen}).open();},
                  8:()=>{if(version!==connectionGeneration||!connectionController.queryBindings)return;const current=++connectionGeneration;
                    createBindingManagementMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,isCurrent:()=>current===connectionGeneration,onBack:reopen}).open();},
                  7: () => showLocalSearchFeedback(reopen), 6: () => { const current=++connectionGeneration;
                    createProfileMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
                      onBack:reopen,isCurrent:()=>current===connectionGeneration}).open(); },
                  5: () => void showBindingReceipts(reopen), 1: () => void checkRemoteBinding(onBack), 2: () => { const current = ++connectionGeneration;
                  createAuditMenu({ controller: connectionController, select: showSelect, prompt: showPrompt, info: showInfo, language: activeLanguage,
                    availableScopes: status.scopes, onBack: reopen, isCurrent: () => current === connectionGeneration }).open(); },
                  3: () => { const current = ++connectionGeneration;
                    createDataExportMenu({ controller: connectionController, select: showSelect, prompt: showPrompt, info: showInfo,
                      language: activeLanguage, onBack: reopen, isCurrent: () => current === connectionGeneration }).open(); },
                  4: () => { const current = ++connectionGeneration;
                    createDeletionMenu({ controller: connectionController, select: showSelect, prompt: showPrompt, canSubmit: status.state === 'session-local' && status.scopes?.includes('data-delete'), info: showInfo, language: activeLanguage,
                      records: createLocalDeletionRecords({dataDirectory,endpoint:status.endpoint,isCurrent:()=>current===connectionGeneration}),
                      onReturnWork:closeGalaxy,onBack: reopen, isCurrent: () => current === connectionGeneration }).open(); } }, onBack: reopen });
            },
            4: () => {if(version!==connectionGeneration)return;
              if(connectionController.querySearch){const current=++connectionGeneration;createSearchMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
                isCurrent:()=>current===connectionGeneration,onReturnWork:closeGalaxy,readWorkContext,onBack:reopen,onHistoryFilters:()=>promptHistory(onBack),availableScopes:status.scopes}).open();}
              else if(connectionController.queryHistory)void promptHistory(onBack);},
            5: () => { if (version === connectionGeneration && connectionController.prepareCase && readCaseSubmission) void previewCaseSubmission(onBack); },
            6: () => { if (version === connectionGeneration && connectionController.listPublicationDrafts) void showPublicationDrafts(onBack); },
            7: () => { if (version === connectionGeneration && connectionController.queryAssistance) {
              const current = ++connectionGeneration;
              createAssistanceMenu({ controller: connectionController, select: showSelect, prompt: showPrompt, info: showInfo,
                language: activeLanguage, availableScopes: status.scopes, readWorkContext, onBack: reopen, isCurrent: () => current === connectionGeneration }).open();
            } } },
          onBack: back,
        });
      } catch {
        if (version === connectionGeneration) showInfo('Galaxy', chinese ? '连接状态不可用。' : 'Connection status unavailable.', onBack);
      }
    }

    async function showPublicationDrafts(onBack: Action) {
      const connectionController = requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const back = () => void showManagedConnection(onBack);
      try {
        const drafts = ((await controllerMethod('listPublicationDrafts')()) as PublicationDraft[]).filter(item => item.status !== 'acknowledged');
        if (version !== connectionGeneration) return;
        if (!drafts.length) return showInfo('Galaxy', chinese ? '暂无待发布草稿。' : 'No drafts pending publication.', back);
        const render = (offset: number) => {
          if (version !== connectionGeneration) return;
          const routes: Routes = {};
          const options = drafts.slice(offset, offset + 8).map((draft, index) => {
            routes[index + 1] = () => showSelect({ title: chinese ? '选择可见性' : 'Choose visibility',
              options: [{ number: '1', title: chinese ? '私有' : 'Private', description: chinese ? '发送到端点，仅本人查看' : 'Sent to the endpoint; visible only to you' },
                { number: '2', title: chinese ? '公开' : 'Public', description: chinese ? '进入公开履历；请确认内容适合公开' : 'Available in public history; review content before sharing' },
                ...(connectionController.reconcilePublication && draft.status === 'prepared' ? [{ number: '3', title: chinese ? '核对已有提交' : 'Check previous submission', description: chinese ? '只读取远端原事件，匹配后恢复本地回执' : 'Read the original remote event and recover a matching local receipt' }] : [])],
              routes: { 1: () => void previewCaseSubmission(onBack, draft.localCaseId, 'Private'),
                2: () => void previewCaseSubmission(onBack, draft.localCaseId, 'Public'),
                3: () => void reconcilePublicationDraft(onBack, draft.localCaseId) }, onBack: () => render(offset) });
            return { number: String(index + 1), title: draft.title.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 160), description: draft.status };
          });
          if (offset + 8 < drafts.length) {
            options.push({ number: '9', title: chinese ? '下一页' : 'Next page', description: '' });
            routes[9] = () => render(offset + 8);
          }
          showSelect({ title: chinese ? 'Galaxy / 本地草稿' : 'Galaxy / Local drafts', options, routes,
            onBack: offset ? () => render(Math.max(0, offset - 8)) : back });
        };
        render(0);
      } catch { if (version === connectionGeneration) showInfo('Galaxy', chinese ? '无法读取本地草稿。' : 'Cannot read local drafts.', back); }
    }

    async function reconcilePublicationDraft(onBack: Action, localDraftId: string) {
      requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const back = () => void showPublicationDrafts(onBack);
      showInfo('Galaxy', chinese ? '正在核对原事件；Esc取消。' : 'Checking the original event; Esc cancels.', () => { controllerMethod('cancel')(); back(); });
      try {
        const result = await controllerMethod('reconcilePublication')(localDraftId);
        if (version !== connectionGeneration) return;
        const messages: Record<string, string> = chinese ? {
          acknowledged: '远端原事件内容匹配，本地回执已恢复。', unknown: '暂时无法核实；不代表未提交，请勿生成新事件重复发布。',
          mismatch: '远端内容与本地冻结草稿不匹配，需要进一步核对。', 'not-prepared': '尚未准备发布，无原事件可核对。'
        } : { acknowledged: 'Original event matched; local receipt recovered.', unknown: 'Unable to verify; do not assume it was not submitted.',
          mismatch: 'Remote content differs from the frozen draft.', 'not-prepared': 'No publication prepared.' };
        showInfo('Galaxy', messages[result.state] ?? result.state, back);
      } catch { if (version === connectionGeneration) showInfo('Galaxy', chinese ? '核对未完成。' : 'Check incomplete.', back); }
    }

    async function previewCaseSubmission(onBack: Action, localDraftId: string | null = null, visibility = 'Private') {
      requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const reopen = () => void showManagedConnection(onBack);
      const cancel = () => { connectionGeneration++; controllerMethod('cancel')(); reopen(); };
      try {
        const request = localDraftId ? null : await readCaseSubmission?.();
        if (version !== connectionGeneration) return;
        if (!request && !localDraftId) return showInfo('Galaxy', chinese ? '没有已授权的选中草稿。' : 'No authorized draft selected.', reopen);
        const preview = localDraftId ? await controllerMethod('preparePublication')(localDraftId, { visibility })
          : await controllerMethod('prepareCase')(request);
        if (version !== connectionGeneration) { controllerMethod('cancel')(); return; }
        let started = false;
        showExactChoice({preview,title:chinese?'发送这份工作内容与范围':'Send this work content and scope',select:showSelect,info:showInfo,language:activeLanguage,
            isCurrent:()=>version===connectionGeneration&&!started,onCancel:cancel,
            onConfirm: async (value: string) => {
              if (version !== connectionGeneration || started) return;
              started = true;
              showInfo('Galaxy', chinese ? '正在提交；Esc取消本地等待。' : 'Submitting; Esc cancels locally.', cancel);
              try {
                await (localDraftId ? controllerMethod('executePublication')(preview, value)
                  : controllerMethod('executeCase')(preview, value));
                if (version !== connectionGeneration) return;
                showInfo('Galaxy', chinese?'这份工作内容已保存，可以回到原工作继续。':'This work content was saved. Continue the original work.', reopen);
              } catch {
                if (version === connectionGeneration) showInfo('Galaxy', chinese ? '发送结果尚未确认。已有提交可在原草稿中继续查询；请先查询同一次操作。' : 'Sending is not confirmed. Continue checking this same operation from the original draft.', reopen);
              }
            } });
      } catch {
        if (version === connectionGeneration) { controllerMethod('cancel')(); showInfo('Galaxy', chinese ? '无法准备草稿；没有提交。' : 'Draft preparation failed; nothing submitted.', reopen); }
      }
    }

    async function promptHistory(onBack: Action) {
      requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      let status;
      try { status = await controllerMethod('status')(); }
      catch { return void showManagedConnection(onBack); }
      if (version !== connectionGeneration) return;
      let draft: HistoryFilters = { query: '', limit: 8 };
      const ownerFields = ['sourceKind', 'environment', 'createdFrom', 'createdBefore'] as const;
      const back = () => void showManagedConnection(onBack);
      const current = () => version === connectionGeneration;
      const own = () => { draft.subjectId = status.subjectId; };
      const clean = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 200);
      const choose = (field: Exclude<keyof HistoryFilters, 'limit'>, title: string, choices: string[][], owner = false) => {
        const routes: Routes = {};
        const options = choices.map(([value, label], index) => {
          routes[index + 1] = () => {
            if (!current()) return;
            if (value) { draft[field] = value; if (owner) own(); } else delete draft[field];
            render();
          };
          return { number: String(index + 1), title: label, description: '' };
        });
        showSelect({ title, options, routes, onBack: render });
      };
      const edit = (field: Exclude<keyof HistoryFilters, 'limit'>, title: string, owner = false) => showPrompt({ title, placeholder: field.startsWith('created') ? (draft[field] ?? '').slice(0, 10) : (draft[field] ?? ''),
        onCancel: render, onConfirm: value => {
          if (!current()) return;
          const text = value.trim();
          if (field === 'query' && (text.length > 200 || new Set(text.toLowerCase().split(/\s+/).filter(Boolean)).size > 8))
            return showInfo('Galaxy', chinese ? '最多 200 字符、8 个空格分隔的关键词。' : 'Maximum 200 characters and 8 search terms.', render);
          if (field === 'environment' && text.length > 160)
            return showInfo('Galaxy', chinese ? '环境名称最多 160 字符。' : 'Environment name: maximum 160 characters.', render);
          if(field==='capabilityId'&&text&&!/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(text))
            return showInfo('Galaxy',chinese?'Capability ID最多128字符，使用字母、数字或 : . _ / -。':'Capability ID: up to128 letters, digits or : . _ / -.',render);
          if (field.startsWith('created') && text) {
            const iso = `${text}T00:00:00.000Z`;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso)
              return showInfo('Galaxy', chinese ? '请输入有效日期，例如 2026-09-10。' : 'Enter a valid date, e.g. 2026-09-10.', render);
            draft[field] = iso;
          } else if (text) draft[field] = text; else delete draft[field];
          if (owner && text) own();
          render();
        } });
      const render = () => {
        if (!current()) return;
        const label = (zh: string, en: string) => chinese ? zh : en;
        const summary = (field: Exclude<keyof HistoryFilters, 'limit'>) => clean(draft[field] ?? label('不限', 'Any'));
        showSelect({ title: label('Galaxy / 履历筛选\n来源、环境、时间仅用于本人履历；日期以 UTC 零点为界。',
          'Galaxy / History filters\nSource, environment and dates filter your history. Dates use midnight UTC.'),
          options: [
            { number: '1', title: label('查询范围', 'Scope'), description: draft.subjectId ? label('本人履历', 'My history') : label('全部可见履历', 'All visible history') },
            { number: '2', title: label('关键词', 'Keywords'), description: summary('query') },
            { number: '3', title: label('报告结果', 'Reported outcome'), description: summary('outcome') },
            { number: '4', title: label('来源', 'Source'), description: summary('sourceKind') },
            { number: '5', title: label('运行环境', 'Environment'), description: summary('environment') },
            { number: '6', title: label('起始日期（包含）', 'From date (inclusive)'), description: summary('createdFrom') },
            { number: '7', title: label('结束日期（不包含）', 'Before date (exclusive)'), description: summary('createdBefore') },
            { number: '8', title: label('开始查询', 'Search'), description: label('提交以上筛选条件', 'Submit these filters') },
            { number: '9', title: label('能力、验证与清空', 'Capability, verification and reset'), description: `${summary('capabilityId')} · ${summary('verificationStrength')}` }
          ], routes: {
            1: () => { if (draft.subjectId) { delete draft.subjectId; ownerFields.forEach(field => delete draft[field]); } else own(); render(); },
            2: () => edit('query', label('输入标题/摘要关键词；留空清除', 'Title/summary keywords; empty clears')),
            3: () => choose('outcome', label('报告结果', 'Reported outcome'), [['', label('不限', 'Any')], ['succeeded', label('成功', 'Succeeded')], ['partial', label('部分成功', 'Partial')], ['failed', label('失败', 'Failed')], ['inconclusive', label('无定论', 'Inconclusive')], ['conflicting', label('结果冲突', 'Conflicting')]]),
            4: () => choose('sourceKind', label('来源（选择后切换本人履历）', 'Source (selecting switches to my history)'), [['', label('不限', 'Any')], ['local', label('本地', 'Local')], ['bridge', 'Bridge'], ['hub', 'Hub']], true),
            5: () => edit('environment', label('完整环境名称；留空清除', 'Full environment name; empty clears'), true),
            6: () => edit('createdFrom', label('登记起始日期 YYYY-MM-DD；留空清除', 'Registered from YYYY-MM-DD; empty clears'), true),
            7: () => edit('createdBefore', label('登记结束日期 YYYY-MM-DD（不含）；留空清除', 'Registered before YYYY-MM-DD (exclusive); empty clears'), true),
            8: () => {
              if (draft.createdFrom && draft.createdBefore && draft.createdFrom >= draft.createdBefore)
                return showInfo('Galaxy', label('结束日期必须晚于起始日期。', 'End date must follow start date.'), render);
              void showHistoryPage(onBack, { ...draft });
            },
            9: () => showSelect({title:label('更多检索条件（仍按Case ID排序）','More search filters (Case ID order)'),options:[
              {number:'1',title:'Capability ID',description:summary('capabilityId')},
              {number:'2',title:label('验证强度','Verification strength'),description:summary('verificationStrength')},
              {number:'3',title:label('清空全部筛选','Clear all filters'),description:''}],routes:{
                1:()=>edit('capabilityId',label('所需Capability ID；不代表已认证能力','Requested Capability ID; not certified proficiency')),
                2:()=>choose('verificationStrength',label('当前可见证据强度','Current visible evidence strength'),[
                  ['',label('不限','Any')],['reported-only',label('仅报告：此视图无当前CI Proof','Reports only: no current visible CI Proof')],['ci-execution-fact',label('存在当前CI执行事实Proof','Current CI execution Proof')]]),
                3:()=>{draft={query:'',limit:8};render();}},onBack:render})
          }, onBack: back });
      };
      render();
    }

    async function showHistoryPage(onBack: Action, query: HistoryFilters) {
      const connectionController = requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const back = () => { connectionGeneration++; controllerMethod('cancel')(); void showManagedConnection(onBack); };
      const plain = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '').replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 800);
      showInfo('Galaxy', chinese ? '正在查询履历；Esc取消。' : 'Reading history; Esc cancels.', back);
      try {
        const page = await controllerMethod('queryHistory')(query);
        if (version !== connectionGeneration) return;
        const items: HistoryItem[] = page.items;
        const outcomes:Record<string,[string,string]>={succeeded:['报告成功','Reported success'],partial:['部分解决','Partial resolution'],failed:['报告失败','Reported failure'],inconclusive:['尚无定论','Inconclusive'],conflicting:['结果冲突','Conflicting']};
        const outcomeLabel=(value:unknown)=>outcomes[String(value)]?.[chinese?0:1]??plain(value);
        const refreshed=page.refresh?`${chinese?'按当前可见来源重算 / 检查时间':'Rebuilt from current visible sources / checked at'}: ${new Date(page.refresh.checkedAt*1000).toISOString()}`:'';
        const ci = page.pageSummary?.ciSources;
        const ciSummary = ci ? `${chinese ? '本页 CI Proof / 来源组 / 重复记录' : 'Page CI proofs / source groups / duplicate records'}: ${ci.proofRecordCount} / ${ci.sourceGroupCount} / ${ci.duplicateProofRecordCount}; ${chinese ? '不作为独立证据计数' : 'not an independent evidence count'}` : '';
        const options = items.map((item, index) => ({ number: String(index + 1), title: plain(item.title),
          description: `${plain(item.state)} · ${plain(item.summary)}` }));
        const routes: Routes = {};
        const render = () => showSelect({
          title: `${chinese ? 'Galaxy / 可见履历' : 'Galaxy / Visible history'}\n${chinese ? '端点报告的记录；不代表能力认证' : 'Endpoint-reported records; not capability certification'}\n${refreshed}\n${ciSummary}\n${page.search?.windowLimited?(chinese?'已达到本次扫描上限；请翻页继续，不代表全库无匹配。':'Scan window reached; continue to next page. This is not a complete search.'):''}\n${items.length ? '' : (chinese ? '本页暂无匹配履历' : 'No matching history on this page')}`,
          options, routes, onBack: back });
        items.forEach((item, index) => {
          const feedback = () => {
            if (version !== connectionGeneration) return;
            const choices: [string, { relevance: string; helpedSelection: boolean | null } | null][] = [
              [chinese ? '相关，并帮助了选择' : 'Relevant and helped selection', { relevance: 'relevant', helpedSelection: true }],
              [chinese ? '相关，但尚未帮助选择' : 'Relevant, has not helped selection', { relevance: 'relevant', helpedSelection: false }],
              [chinese ? '不相关' : 'Not relevant', { relevance: 'not-relevant', helpedSelection: false }],
              [chinese ? '不确定' : 'Unsure', { relevance: 'unsure', helpedSelection: null }],
              [chinese ? '移除此前反馈' : 'Remove previous feedback', null]
            ];
            const routes: Routes = {};
            const options = choices.map(([title, verdict], index) => {
              routes[index + 1] = async () => {
                if (version !== connectionGeneration) return;
                try {
                  await controllerMethod('recordSearchFeedback')(item.caseId, verdict);
                  if (version === connectionGeneration) showInfo('Galaxy', chinese ? '反馈已在本机更新；不影响证明或能力评价。' : 'Feedback updated locally; Proof and capability claims are unchanged.', render);
                } catch { if (version === connectionGeneration) showInfo('Galaxy', chinese ? '反馈未保存，请重新查询后再试。' : 'Feedback not saved; query again before retrying.', render); }
              };
              return { number: String(index + 1), title, description: '' };
            });
            showSelect({ title: chinese ? '查询反馈（仅保存在本机）\n可按0跳过，不上传查询内容。' : 'Search feedback (local only)\nPress 0 to skip; search content is not uploaded.', options, routes, onBack: render });
          };
          const actions=()=>{
            const ownerReview=item.fieldPolicy?.view==='owner'&&item.rebuild&&connectionController.getCase&&connectionController.prepareCaseReview&&connectionController.executeCaseReview;
            const caseModeration=item.rebuild&&connectionController.queryModeration;
            const linked=item.collaborationContext?.items??[];
            void (async()=>{
              try{
                const status=await controllerMethod('status')();if(version!==connectionGeneration)return;
                const entries:MenuOption[]=[{number:'1',title:chinese?'返回结果列表':'Back to results'},{number:'6',title:chinese?'查看来源与完整记录':'Inspect source and complete record'}];
                const choices:Routes={1:render,6:()=>showInfo(plain(item.title),sourceText,actions)};
                if(connectionController.recordSearchFeedback){entries.push({number:'2',title:chinese?'查询反馈':'Search feedback'});choices[2]=feedback;}
                if(ownerReview&&['case-teaser','consent'].every(scope=>status.scopes?.includes(scope))){
                  entries.push({number:'3',title:chinese?'纠正与争议记录（本人Case）':'Correction and dispute records (my Case)'});
                  choices[3]=()=>{const current=++connectionGeneration;
                    createCaseReviewMenu({controller:connectionController,caseId:item.caseId,sourceVersion:item.rebuild!.sourceVersion,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
                      isCurrent:()=>current===connectionGeneration,onBack:()=>void showHistoryPage(onBack,query)}).open();};
                }
                if(linked.length&&connectionController.getAssistance&&status.scopes?.includes('assistance')){
                  entries.push({number:'4',title:chinese?'协作争议与处理':'Collaboration disputes and moderation'});
                  const chooseLinks=(offset=0)=>{
                    const options:MenuOption[]=[],linkRoutes:Routes={};
                    linked.slice(offset,offset+8).forEach((link,i)=>{
                      options.push({number:String(i+1),title:plain(link.assistanceId),description:plain(link.requestedScope)});
                      linkRoutes[i+1]=()=>{const current=++connectionGeneration;
                        createAssistanceMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,availableScopes:status.scopes,readWorkContext,
                          isCurrent:()=>current===connectionGeneration,onBack:()=>void showHistoryPage(onBack,query)}).openRequest(link.assistanceId);};
                    });
                    if(offset+8<linked.length){options.push({number:'9',title:chinese?'下一页':'Next page'});linkRoutes[9]=()=>chooseLinks(offset+8);}
                    showSelect({title:chinese?'选择关联协作':'Choose linked collaboration',options,routes:linkRoutes,onBack:offset?()=>chooseLinks(Math.max(0,offset-8)):actions});
                  };
                  choices[4]=()=>chooseLinks();
                }
                if(caseModeration&&status.scopes?.includes('moderation')){
                  entries.push({number:'5',title:chinese?'Case独立争议处理':'Case independent moderation'});
                  choices[5]=()=>{const current=++connectionGeneration;
                    createAssistanceMenu({controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,availableScopes:status.scopes,readWorkContext,
                      isCurrent:()=>current===connectionGeneration,onBack:()=>void showHistoryPage(onBack,query)})
                      .openCaseModeration({caseId:item.caseId,sourceVersion:item.rebuild!.sourceVersion,events:item.rebuild!.sources.events});};
                }
                showSelect({title:chinese?'履历后续操作':'History actions',options:entries,routes:choices,onBack:render});
              }catch{if(version===connectionGeneration)showInfo('Galaxy',chinese?'请重新查询后操作。':'Query history again before acting.',render);}
            })();
          };
          const sourceText=[plain(item.summary), `Case: ${plain(item.caseId)}`,
              ...(item.fieldPolicy?[`${chinese?'字段视图':'Field view'}: ${plain(item.fieldPolicy.view)} / ${plain(item.fieldPolicy.id)}@${item.fieldPolicy.version}`]:[]),
              ...(item.participants??[]).map(person=>`${chinese?'Case中声明的参与者':'Case-declared participant'}: ${plain(person.subjectId)} · ${plain(person.role)}`),
              ...(item.attempts??[]).filter(attempt=>attempt.configuration).map(attempt=>`${chinese?'尝试配置':'Attempt configuration'}: ${plain(attempt.id)} · ${plain(attempt.configuration?.environment)} / ${plain(attempt.configuration?.version)}`),
              ...(item.collaborationContext?.items??[]).flatMap(link=>[
                `${chinese?'协作来源 / 声明的能力需求（非认证）':'Collaboration source / declared capability requirement (not certification)'}: ${plain(link.assistanceId)} / ${plain(link.capabilityId??'—')}`,
                `${chinese?'请求范围':'Requested scope'}: ${plain(link.requestedScope)}`,
                ...link.participantLinks.map(person=>`${chinese?'签署参与记录':'Signed participation record'}: ${plain(person.subjectId)} · ${plain(person.role)} · ${plain(person.eventId)}`)
              ]),
              ...(item.rebuild ? [
                `${chinese ? '重建规则 / 来源版本' : 'Rebuild rule / source version'}: ${plain(item.rebuild.rule.id)}@${item.rebuild.rule.version} / ${item.rebuild.sourceVersion}`,
                `${chinese ? '可见内容摘要' : 'Visible content hash'}: ${plain(item.rebuild.contentHash)}`,
                `${chinese ? '与本次会话上次查询比较' : 'Compared with last query in this session'}: ${item.rebuildComparison?.state === 'unchanged' ? (chinese ? '无变化' : 'Unchanged') : item.rebuildComparison?.state === 'changed' ? (chinese ? '来源或可见内容有变化' : 'Sources or visible content changed') : (chinese ? '暂无可比较记录' : 'No comparable baseline')}`,
                `${chinese ? '来源事件（最多显示最近10条）' : 'Source events (last 10 shown)'}: ${item.rebuild.sources.events.length}`,
                ...item.rebuild.sources.events.slice(-10).map(event => `${event.version} · ${plain(event.kind)} · ${plain(event.id)}`)
              ] : []),
              ...item.results.flatMap(result => [`${outcomeLabel(result.outcome)}: ${plain(result.summary)}${result.corrected ? (chinese ? '（有纠正）' : ' (corrected)') : ''}`,
                ...(result.failureReason?[`${chinese?'失败说明':'Failure reason'}: ${plain(result.failureReason)}`]:[]),
                ...(result.limitations??[]).map(value=>`${chinese?'限制':'Limitation'}: ${plain(value)}`)]),
              ...(item.reportedProgress?[`${chinese?'结果报告时间线（事件顺序；不构成能力评分）':'Result timeline (event order; not a capability score)'}`,
                ...item.reportedProgress.timeline.map(report=>`${report.sourceEventVersion} · ${outcomeLabel(report.outcome)} · ${plain(report.resultId)}${report.corrected?(chinese?'（原报告有纠正）':' (original report corrected)'):''}`),
                ...item.reportedProgress.subsequentReports.map(report=>`${chinese?'成功报告后的后续结果（回归未核验）':'Subsequent report after success (regression not verified)'}: ${plain(report.previousSuccessId)} → ${plain(report.resultId)} · ${report.attemptRelation==='same-attempt'?(chinese?'同一尝试':'same attempt'):(chinese?'不同尝试':'different attempt')}`)]:[]),
              ...(item.corrections ?? []).map(correction => `${chinese ? '纠正' : 'Correction'}: ${plain(correction.summary)}`),
              ...(item.reviews ?? []).flatMap(review => [
                `${plain(review.type)}: ${plain(review.state)} · ${chinese ? 'Case 所有者报告' : 'Case owner reported'}`,
                ...(review.changes ?? []).map(change => `${plain(change.state)}: ${plain(change.summary)}`)]),
              ...(item.proofs ?? []).map(proof => `Proof: ${plain(proof.proofId)} · ${plain(proof.caseContext?.status ?? proof.status)}${proof.provenance ? '\n' + plain(proof.provenance.sourceKey) + '\n' + (proof.provenance.sourceControl?.repositoryOwner ? plain(proof.provenance.sourceControl.repositoryOwner.login) + ' / ' + proof.provenance.sourceControl.repositoryOwner.id + (chinese ? '（GitHub 所有者记录，未证明提交者控制权）' : ' (GitHub owner record; submitter control unverified)') : (chinese ? '仓库所有者资料未记录' : 'Repository owner metadata not recorded')) : ''}`),
              ...(item.searchExplanation?[`${chinese?'检索解释':'Search explanation'} · ${plain(item.searchExplanation.sourceType)} · ${plain(item.searchExplanation.order)}`,
                ...item.searchExplanation.textMatches.map(match=>`${plain(match.term)} → ${match.fields.map(plain).join(', ')}`),
                ...item.searchExplanation.capabilityMatches.map(match=>`Capability ${plain(match.capabilityId)} → Assistance ${plain(match.assistanceId)} (${chinese?'请求者声明的工作需求':'requester-declared requirement'})`),
                `${chinese?'当前可见验证强度':'Current visible verification strength'}: ${plain(item.searchExplanation.verification.strength)}`,
                `${chinese?'检查时间':'Checked at'}: ${new Date(item.searchExplanation.checkedAt*1000).toISOString()}`,
                ...item.searchExplanation.limitations.map(plain)]:[]),
              ...(item.moderationContext?.items.length?[chinese?'独立处理沿革（按授权展示；过程决定不等于自动验证）':'Independent review history (authorized view; decisions are not automatic verification)',
                ...item.moderationContext.items.flatMap(record=>[`${plain(record.reportId)} · ${plain(record.state)}${record.paused?' · paused':''}`,
                  ...record.events.map(event=>`${plain(event.kind)} · ${plain(event.verdict)} · ${plain(event.summary)}`),
                  ...(record.revalidation?[`${chinese?'Evidence验证轮次':'Evidence verification round'}: ${record.revalidation.generation} · ${plain(record.revalidation.state)}`]:[])])]:[]),
              ...item.matchReasons.map(plain)].join('\n');
          routes[index + 1] = () => showInfo(plain(item.title),[
            sourceReadingText({type:'history',record:item,summary:item.summary},(cn:string,en:string)=>chinese?cn:en,plain),
            ...(item.corrections?.length?[chinese?'原工作有纠正，具体内容可从来源记录继续阅读。':'The original work has corrections. Read their source records for details.']:[]),
            ...(item.moderationContext?.items.some(record=>record.paused)?[chinese?'当前可见处理记录标明暂停，请查看处理详情后继续。':'A visible handling record reports a pause. Inspect its details before continuing.']:[]),
          ].join('\n\n'),actions);
        });
        if (page.nextCursor) {
          const number = String(items.length + 1);
          options.push({ number, title: chinese ? '下一页' : 'Next page', description: '' });
          routes[number] = () => void showHistoryPage(onBack, { ...query, after: page.nextCursor });
        }
        render();
      } catch {
        if (version === connectionGeneration) showInfo('Galaxy', chinese ? '查询未完成，请检查会话权限或关键词。' : 'Query incomplete; check session scopes or search terms.', back);
      }
    }

    async function showBindingReceipts(onBack: Action, offset = 0) {
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      try {
        const read = connectionController?.listBindingReceipts ?? discovery?.listBindingReceipts;
        if (!read) throw new Error('Local receipt reader unavailable.');
        const result = await read();
        if (version !== connectionGeneration) return;
        const routes: Routes = {}, reopen = () => void showBindingReceipts(onBack, offset);
        const options: MenuOption[] = result.records.slice(offset, offset + 8).map((record: BindingReceiptView, index: number) => {
          const number = String(index + 1);
          routes[number] = () => showInfo(chinese ? '本机绑定回执' : 'Local binding receipt', [record.endpoint, record.bindingId,
            record.subjectId, record.installationId, record.scopes.join(', '),
            `${chinese ? '本机记录时间' : 'Local recorded time'}: ${new Date(record.receivedAt * 1000).toISOString()}`,
            `${chinese ? '回执到期时间' : 'Receipt expiry'}: ${new Date(record.bindingExpiresAt * 1000).toISOString()}`,
            record.verification === 'unverified' ? (chinese ? '签名未通过当前信任配置核验' : 'Signature unverified with current trust configuration')
              : (chinese ? '签名在所记录时间有效' : 'Signature valid at recorded time'),
            record.lifetime === 'expired' ? (chinese ? '回执已过期' : 'Receipt expired') : (chinese ? '未超过回执声明期限' : 'Within receipt stated lifetime'),
            record.configurationMatches ? (chinese ? '安装实例与请求范围匹配当前配置' : 'Installation and requested scopes match configuration') : (chinese ? '历史配置与当前不同' : 'Historical configuration differs'),
            chinese ? '仅本机历史；远端状态未核查，不提供访问权限。' : 'Local history only; remote state not checked; grants no access.',
          ].join('\n'), reopen);
          return { number, title: record.bindingId, description: new Date(record.receivedAt * 1000).toISOString() };
        });
        if (offset + 8 < result.records.length) { options.push({ number: '9', title: chinese ? '下一页' : 'Next page' }); routes[9] = () => void showBindingReceipts(onBack, offset + 8); }
        showSelect({ title: `${chinese ? '本机绑定回执' : 'Local binding receipts'}\n${result.records.length}\n${chinese ? '历史记录不代表当前绑定或会话有效' : 'History does not establish current binding or session validity'}`,
          options, routes, onBack: offset ? () => void showBindingReceipts(onBack, Math.max(0, offset - 8)) : onBack });
      } catch { if (version === connectionGeneration) showInfo('Galaxy', chinese ? '本机回执无法读取，请检查身份和存储。' : 'Local receipts unavailable; check identity and storage.', onBack); }
    }

    async function checkRemoteBinding(onBack: Action) {
      requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      const reopen = () => void showManagedConnection(onBack);
      showInfo('Galaxy', chinese ? '正在核查远端绑定；Esc取消。' : 'Checking remote binding; Esc cancels.', () => { controllerMethod('cancel')(); reopen(); });
      try {
        const result = await controllerMethod('checkRemote')();
        if (version !== connectionGeneration) return;
        showInfo('Galaxy', `${result.endpoint}\n${result.state}\n${chinese ? '仅代表本次查询，不代表持续在线或业务授权。' : 'This check does not establish continuing connectivity or business authorization.'}`, reopen);
      } catch {
        if (version === connectionGeneration) showInfo('Galaxy', chinese ? '核查未完成，不会自动重试。' : 'Check incomplete; no automatic retry.', reopen);
      }
    }

    async function previewConnection(onBack: Action) {
      requiredController();
      const version = ++connectionGeneration;
      const chinese = activeLanguage === 'zh-CN';
      try {
        const preview = await controllerMethod('prepare')();
        if (version !== connectionGeneration) { controllerMethod('cancel')(); return; }
        pendingConnection = preview;
        const cancel = () => { if (version !== connectionGeneration) return; controllerMethod('cancel')(); pendingConnection = null; void showManagedConnection(onBack); };
        let started = false;
        const prompt = () => {
          if (version !== connectionGeneration || pendingConnection !== preview) return;
          let request: {scopes?:string[]}={};try{request=JSON.parse(preview.requestJson);}catch{/* The exact original still stays in its preview. */}
          const scopes: Record<string,string>={binding:'设备连接',consent:'所选内容授权',history:'可见履历',assistance:'求助与参与',context:'所选材料',notifications:'消息通知',capsules:'知识胶囊',builders:'开放节点信息','case-teaser':'当前工作记录',proof:'来源证据',evidence:'提交的材料',moderation:'已获准的处理记录',audit:'本人操作记录','audit-review':'本人授权记录','data-export':'本人资料导出','data-delete':'本人资料删除'};
          showSelect({
          title: `${chinese ? '连接到银河' : 'Connect to Galaxy'}\n${preview.endpoint}\n${chinese?'本次选择的权限':'Selected permissions'}：${request.scopes?.map(scope=>chinese?scopes[scope]??scope:scope).join('、')??(chinese?'宿主已选择的设备连接':'The device connection selected by the host')}\n${chinese?'私人笔记与原工作全文不会由这次连接上传。':'This connection does not upload private notes or the original work in full.'}`,
          options:[{number:'1',title:chinese?'允许这次连接':'Allow this connection'},
            {number:'2',title:chinese?'查看连接来源':'Inspect connection source',description:chinese?'需要诊断时查看准确请求。':'Inspect the exact request when diagnosing.'}],
          onBack: cancel,
          routes:{2:()=>showInfo(chinese?'连接来源与诊断':'Connection source and diagnostics',preview.requestJson,prompt),1:async () => {
            if (version !== connectionGeneration || pendingConnection !== preview || started) return;
            started = true;
            showInfo('Galaxy', chinese ? '正在连接；Esc可取消，已送达请求不保证撤回。' : 'Connecting; Esc cancels locally but cannot undo delivered requests.', cancel);
            try {
              // This action comes from the actual native selection. The exact
              // host preview remains the same object and checks its own expiry.
              await controllerMethod('execute')(preview, preview.confirmation);
              if (version !== connectionGeneration) return;
              pendingConnection = null;
              void showManagedConnection(onBack);
            } catch {
              if (version !== connectionGeneration) return;
              pendingConnection = null;
              showInfo('Galaxy', chinese ? '连接未完成；远端结果可能需复核，不会自动重试。' : 'Connection incomplete; remote outcome may need review. No automatic retry.', () => void showManagedConnection(onBack));
            }
          }},
          });
        };
        prompt();
      } catch {
        if (version === connectionGeneration) showInfo('Galaxy', chinese ? '无法准备连接；没有发送。' : 'Cannot prepare connection; nothing sent.', onBack);
      }
    }

    async function showSettingsModules(onReturn: Action) {
      const status = await store.getGalaxyIntegrationStatus(dataDirectory);
      const modules = status.integration?.modules ?? [];
      showInfo(
        'Galaxy / 模块与集成',
        `当前已启用的本机模块：\n${formatModules(modules, status.catalog?.modules, activeLanguage) || '• 尚未启用模块'}\n\n${localBoundary(activeLanguage)}\n\n${divider()}\nFounding Beta 不允许从设置页重新执行首次初始化，也不提供远程模块安装。`,
        onReturn,
      );
    }

    function showSettingsLanguage(onReturn: Action) {
      showSelect({
        title: 'Galaxy / 显示语言\n这只影响当前 OpenCode 对话，不会修改 Galaxy ID、本机配置或初始化记录。',
        options: [
          { number: '1', title: '简体中文', description: '以中文显示此会话中的 Galaxy 页面。' },
          { number: '2', title: 'English', description: 'Show Galaxy pages in English for this conversation.' },
        ],
        routes: {
          1: () => {
            activeLanguage = 'zh-CN';
            showInfo('Galaxy / 显示语言', '已切换为简体中文。\n\n这不会修改本机 Galaxy、身份或初始化记录。\n\n按 Enter 返回 Galaxy 控制台。', onReturn);
          },
          2: () => {
            activeLanguage = 'en-US';
            showInfo('Galaxy / Display language', 'English is now used for this OpenCode conversation.\n\nThis does not change your local Galaxy, identity, or initialization record.\n\nPress Enter to return to the Galaxy console.', onReturn);
          },
          0: onReturn,
        },
        onBack: onReturn,
      });
    }

    async function showReinitializeGalaxy(onReturn: Action) {
      const status = await store.getGalaxyIntegrationStatus(dataDirectory);
      const count = (name: keyof NonNullable<typeof status.recordCounts>) => status.recordCounts?.[name] ?? 0;
      const chinese = activeLanguage === 'zh-CN';
      const identity = status.galaxyId?.id ?? (chinese ? '尚未创建' : 'Not created');
      showSelect({
        title: chinese
          ? `Galaxy / 重新初始化\n\n这是一项不可恢复的本机清理操作。确认后将清除：\n• Galaxy ID：${identity}\n• 私钥与公钥\n• ${count('cases')} 个本地 Case、${count('disclosurePlans')} 个披露计划、${count('consentGrants')} 个授权记录、${count('localProofDrafts')} 个 Local Proof Draft\n• 初始化状态与本机审计记录\n\n不会删除 .galaxy 目录中不属于 Galaxy 托管文件的内容。清除后自动回到首次语言选择。`
          : `Galaxy / Reinitialize\n\nThis is an irreversible local cleanup. Confirming removes:\n• Galaxy ID: ${identity}\n• Private and public keys\n• ${count('cases')} local Cases, ${count('disclosurePlans')} disclosure plans, ${count('consentGrants')} consent grants, and ${count('localProofDrafts')} Local Proof Drafts\n• Initialization state and local audit history\n\nUnknown files inside .galaxy are not deleted. After cleanup, Galaxy returns to first-time language selection.`,
        options: [
          {
            number: '1',
            title: chinese ? '确认清除本机 Galaxy 并重新初始化' : 'Confirm local Galaxy cleanup and reinitialize',
            description: chinese ? '永久清除上述 Galaxy 托管数据；随后立即进入首次初始化。' : 'Permanently remove the Galaxy-managed data above, then enter first-time setup.',
          },
          {
            number: '0',
            title: chinese ? '返回 Galaxy 控制台' : 'Return to Galaxy console',
            description: chinese ? '不删除任何数据。' : 'Delete nothing.',
          },
        ],
        routes: {
          1: async () => {
            try {
              await store.resetGalaxyIntegration(dataDirectory);
              void showQuickInitialize(onReturn);
            } catch (error) {
              showInfo(chinese ? '重新初始化未完成' : 'Reinitialization did not complete', String(error instanceof Error ? error.message : error), onReturn);
            }
          },
          0: onReturn,
        },
        onBack: onReturn,
      });
    }

    function showSettings(onReturn: Action): void {
      const chinese = activeLanguage === 'zh-CN';
      if(nativeTools){
        const nativeEntry=(kind:'identity'|'methods'|'external'|'projects')=>()=>{
          const version=++connectionGeneration;purposeMenu?.close();
          purposeMenu=createPurposeMenu({nativeTools,controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
            isCurrent:()=>!closed&&version===connectionGeneration,onBack:()=>showSettings(onReturn),onReturnWork:returnToWork,readWorkContext:currentWorkContext});purposeMenu[kind]();
        };
        return showSelect({title:chinese?'Galaxy / 我的与设置':'Galaxy / My settings',options:[
          {number:'1',title:chinese?'身份与设备':'Identity and devices',description:chinese?'沿用当前 Native 的稳定身份。':'Use the current stable Native identity.'},
          {number:'2',title:chinese?'方法':'Methods',description:chinese?'沿用实际工作整理、应用与验证方法。':'Prepare, apply and reverify methods from actual work.'},
          {number:'4',title:chinese?'交给已有服务处理':'Use an existing service',description:chinese?'选择现有工作与必要内容，接续已配置 A2A 服务。':'Select current work and necessary content for a configured A2A service.'},
          {number:'5',title:chinese?'同行与联系':'People and contacts',description:chinese?'从当前方向读项目、发起联系，接续对话。':'Read projects, contact people, and continue the conversation.'},
          {number:'3',title:chinese?'显示语言':'Display language',description:chinese?'更改这个 OpenCode 入口的显示语言。':'Change the language of this OpenCode entry.'}],
          routes:{1:nativeEntry('identity'),2:nativeEntry('methods'),4:nativeEntry('external'),5:nativeEntry('projects'),3:()=>showSettingsLanguage(()=>showSettings(onReturn))},onBack:onReturn});
      }
      showSelect({
        title: chinese
          ? 'Galaxy / 我的与设置'
          : 'Galaxy / My settings',
        options: [
          { number: '6', title: chinese ? '连接与设备' : 'Connection and devices', description: chinese ? '按需要接入已有身份，查看当前连接。' : 'Connect an existing identity when needed and inspect this connection.' },
          { number: '5', title: chinese ? '创建本机身份' : 'Create local identity', description: chinese ? '仅在这台设备尚未准备身份时使用。' : 'Use only when this device has no local identity yet.' },
          { number: '1', title: chinese ? '本机身份与运行边界' : 'Local identity and boundary', description: chinese ? '查看本机身份卡及服务边界。' : 'Review the local identity card and service boundary.' },
          { number: '2', title: chinese ? '模块与集成' : 'Modules and integrations', description: chinese ? '查看已启用的本机模块，不安装或变更。' : 'Review enabled local modules; no installation or change.' },
          { number: '3', title: chinese ? '显示语言' : 'Display language', description: chinese ? '仅更改当前 OpenCode 对话语言。' : 'Change language only for this OpenCode conversation.' },
          { number: '4', title: chinese ? '重新初始化 Galaxy' : 'Reinitialize Galaxy', description: chinese ? '清除 Galaxy 托管数据与当前 ID，然后从首次初始化开始。' : 'Clear Galaxy-managed data and the current ID, then restart first-time setup.' },
        ],
        routes: {
          6: () => showConnection(onReturn),
          5: () => showQuickInitialize(onReturn),
          1: () => showStatus(onReturn),
          2: () => showSettingsModules(onReturn),
          3: () => showSettingsLanguage(onReturn),
          4: () => showReinitializeGalaxy(onReturn),
          0: onReturn,
        },
        onBack: onReturn,
      });
    }

    async function showQuickInitialize(onReturn: Action) {
      const status = await store.getGalaxyIntegrationStatus(dataDirectory);
      if (status.initialized) return showConsole(status);
      const chinese=activeLanguage==='zh-CN';
      showSelect({title:chinese?'Galaxy / 在本机准备身份\n保存稳定身份和设备密钥，便于接续工作。连接和外发范围按需另行选择。':'Galaxy / Prepare this device\nSave a stable identity and device-held key. Connection and external sharing are selected when needed.',
        options:[{number:'1',title:chinese?'创建本机身份':'Create local identity',description:chinese?'使用当前默认配置；保留已有文件。':'Use current defaults and retain existing files.'}],
        routes:{1:async()=>{try{const initialized=await store.initializeGalaxyIntegration(dataDirectory,{initializationPath:'personal-galaxy',source:'opencode-native-tui'});await showConsole(initialized);}catch{showInfo('Galaxy',chinese?'本机准备未完成，请保留现有资料再试。':'Device preparation is incomplete; retain current material before retrying.',onReturn);}}},onBack:onReturn});
    }

    function purpose(kind: 'search' | 'messages' | 'publish' | 'community', onBack: Action) {
      const version=++connectionGeneration;
      purposeMenu?.close();
      if(!nativeTools&&kind==='search'&&!connectionController?.querySearch){
        return showSelect({title:activeLanguage==='zh-CN'?'找帮助\n当前宿主尚未接入可查询的银河服务。':'Find help\nThis host has no connected Galaxy search service.',
          options:[{number:'1',title:activeLanguage==='zh-CN'?'接入银河':'Connect to Galaxy'},{number:'2',title:activeLanguage==='zh-CN'?'回到原工作':'Return to original work'}],routes:{1:()=>showConnection(onBack),2:closeGalaxy},onBack});
      }
      purposeMenu=createPurposeMenu({nativeTools,controller:connectionController,select:showSelect,prompt:showPrompt,info:showInfo,language:activeLanguage,
        isCurrent:()=>!closed&&version===connectionGeneration,onBack,onReturnWork:returnToWork,readWorkContext:currentWorkContext});
      purposeMenu[kind]();
    }

    async function showConsole(initialized?: Awaited<ReturnType<typeof store.getGalaxyIntegrationStatus>>) {
      const status = nativeTools ? undefined : initialized?.integration ? initialized : await store.getGalaxyIntegrationStatus(dataDirectory);
      const chinese = activeLanguage === 'zh-CN';
      const reopen = () => showConsole(status);
      showSelect({
        title: chinese ? '✧ 银河' : '✧ Galaxy',
        options: [
          { number: '1', title: chinese ? '找帮助' : 'Find help', description: chinese ? '说明目标，直接查看当前可用的帮助。' : 'Describe a goal and read currently available help.' },
          { number: '2', title: chinese ? '发起求助' : 'Ask for help', description: chinese ? '沿用当前工作准备需要的协助。' : 'Prepare a request from the current work.' },
          { number: '3', title: chinese ? '消息' : 'Messages', description: chinese ? '查看对话，做必要回复。' : 'Read conversations and reply when needed.' },
          ...(nativeTools ? [{ number: '6', title: chinese ? '逛社区' : 'Browse community', description: chinese ? '按主题阅读讨论，保留原工作。' : 'Browse discussions by topic and retain your original work.' }] : []),
          { number: '4', title: chinese ? '我的与设置' : 'My settings', description: chinese ? '身份、连接、资料和显示偏好。' : 'Identity, connection, data and display preferences.' },
          { number: '5', title: chinese ? '回到原工作' : 'Return to original work', description: '' },
        ],
        routes: {
          1: () => purpose('search',reopen),
          2: () => purpose('publish',reopen),
          3: () => purpose('messages',reopen),
          4: () => showSettings(reopen),
          5: closeGalaxy,
          6: () => purpose('community',reopen),
          0: closeGalaxy,
        },
        onBack: closeGalaxy,
      });
    }

    async function openGalaxy() {
      if (closed) return;
      const page = ++pageGeneration;
      try {
        if(nativeTools){await showConsole();return;}
        const status = await store.getGalaxyIntegrationStatus(dataDirectory);
        if (closed || page !== pageGeneration) return;
        if (status.recoveryRequired) {
          showInfo('Galaxy / 本地恢复', '本地初始化或重置曾中断。请保留现有文件，检查待完成的操作后，再明确恢复初始化或重置。\n\n当前只读查看不会创建新身份、删除文件或自动恢复。', closeGalaxy);
          return;
        }
        if (status.initialized) {
          await showConsole(status);
          return;
        }
        await showConsole(status);
      } catch (error) {
        if (closed || page !== pageGeneration) return;
        showInfo('Galaxy', `无法打开本机 Galaxy：${String(error instanceof Error ? error.message : error)}`, closeGalaxy);
      }
    }

    const disposeRoot = api.keymap.registerLayer({
      commands: [{
        name: 'galaxy.open',
        title: 'Galaxy',
        desc: '进入 Galaxy：让真实工作中的难题找到更合适的协作路径。',
        category: 'Galaxy',
        namespace: 'palette',
        slashName: 'galaxy',
        slashAliases: ['Galaxy'],
        run: () => void openGalaxy(),
      }],
    });
    disposeHost = () => { closeGalaxy(); disposeRoot(); };
    } catch (error) { close(); throw error; }
  },
};
}

// OpenCode caches the plugin module across deactivate/activate. Each activation
// owns a fresh runtime; the factory itself remains a single-use adapter.
export function createGalaxyPlugin(createAdapter: () => ReturnType<typeof createGalaxyAdapter> | Promise<ReturnType<typeof createGalaxyAdapter>> = createGalaxyAdapter) {
  return { id: 'galaxy.opencode.stable.tui', tui: async (api: StableHostApi) => {
    const adapter = await createAdapter();
    await adapter.tui(api);
  } };
}

export default createGalaxyPlugin();
