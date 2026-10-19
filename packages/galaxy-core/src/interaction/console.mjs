import {getGalaxyInitializationContract,getGalaxyInitializationPresentation,listGalaxyInitializationPaths} from '../integration-modules.mjs';
import {getGalaxyIntegrationStatus,getLocalUploadPrivacy} from '../application/local-operations.mjs';
import {createLocalWorkHistory} from '../work-history/index.mjs';

export const GALAXY_COMMANDS = Object.freeze({
  open: { route: 'galaxy-service-home', title: 'Open Galaxy' },
  help: { route: 'galaxy-command-help', title: 'Galaxy commands' },
  language: { route: 'galaxy-language', title: 'Galaxy language' },
  status: { route: 'galaxy-status', title: 'Galaxy status' },
  connect: { route: 'galaxy-connection', title: 'Connect to Galaxy' },
  setup: { route: 'galaxy-configuration-change', title: 'Change Galaxy setup' },
  history: { route: 'galaxy-work-history', title: 'Local work history' },
  work: { route: 'galaxy-work-history', title: 'Local work history' },
  case: { route: 'galaxy-case-workspace', title: 'Galaxy Case workspace', requires: ['case-workspace'] },
  privacy: { route: 'galaxy-privacy-controls', title: 'Galaxy upload settings' },
  worker: { route: 'galaxy-worker-service', title: 'Galaxy Worker', futurePath: 'galaxy-worker' },
  hub: { route: 'galaxy-hub-service', title: 'Galaxy Hub', futurePath: 'galaxy-hub' },
  website: { route: 'galaxy-website-entry', title: 'Open the Galaxy website' },
});

export const GALAXY_COMMAND_HELP = Object.freeze([
  { command: '/Galaxy', action: 'open', title: '打开 Galaxy / Open Galaxy' },
  { command: '/Galaxy status', action: 'status', title: '查看本机状态 / Check local status' },
  { command: '/Galaxy connect', action: 'connect', title: '接入银河 / Connect to Galaxy' },
  { command: '/Galaxy setup', action: 'setup', title: '调整初始化配置 / Review setup changes' },
  { command: '/Galaxy history', action: 'history', title: '阅读本地工作履历 / Read local work history' },
  { command: '/Galaxy worker', action: 'worker', title: '独立 Worker 身份入口 / Separate Worker identity' },
  { command: '/Galaxy case', action: 'case', title: '进入本地 Case / Open local Cases' },
  { command: '/Galaxy privacy', action: 'privacy', title: '查看隐私控制 / Open privacy controls' },
  { command: '/Galaxy language', action: 'language', title: '切换显示语言 / Choose display language' },
  { command: '/Galaxy website', action: 'website', title: '打开 Galaxy 官网 / Open Galaxy website' },
]);

export function getGalaxyConsoleCopy(language) {
  if (language === 'en-US') {
    return {
      title: 'Galaxy Console',
      welcome: 'Welcome back to Galaxy',
      summary: 'Your local Galaxy is ready for real work that needs a clearer path forward.',
      purpose: 'Read ordinary local work and environment facts, and use your own Agent to organize the unprocessed observations. A Case is available when you need a separate help request.',
      boundary: 'Reading local work starts no network connection or model. Upload selections and online public visibility are separate.',
      available: 'Available now',
      next: 'Suggested next steps',
      future: 'Coming later',
      interactionTitle: 'How to use this console',
      status: 'Check local status',
      history: 'Read local work history',
      historyDescription: 'Read real observations and their sources; let your own Agent organize pending increments.',
      case: 'Start or continue a Case',
      privacy: 'Review privacy controls',
      setup: 'Review setup changes',
      language: 'Change display language',
      website: 'Open official website',
      worker: 'Galaxy Worker',
      hub: 'Galaxy Hub',
      workerDescription: 'A policy-controlled 7×24 Agent runtime; not implemented in Founding Beta.',
      hubDescription: 'An organization or community Galaxy with its own policy and evidence boundary; not implemented in Founding Beta.',
      caseDescription: 'Record the difficult point in local work without publishing it.',
      privacyDescription: 'Read or adjust the four upload levels. Full conversations remain excluded unless separately selected.',
      setupDescription: 'Preview changes before enabling any additional local capability.',
      languageDescription: 'This affects only the current host conversation.',
      websiteDescription: 'Opens a configured official HTTPS site only on explicit request.',
      guidance: [
        'Use history for ordinary work; local recording and your own Agent’s summaries do not require a formal Case.',
        'Review privacy controls before any future disclosure decision.',
        'Use setup only for an explicit, previewed configuration change.',
      ],
      interactionRules: [
        'Type /Galaxy status to inspect your local Galaxy without changing anything.',
        'Type /Galaxy history to read local work; /Galaxy privacy shows the saved upload selection.',
        'Type /Galaxy setup only when you intend to review a configuration change. Type /Galaxy help at any time for the full command list.',
      ],
    };
  }
  return {
    title: 'Galaxy 控制台',
    welcome: '欢迎回到银河',
    summary: '你的本地 Galaxy 已准备好承接需要更清晰路径的真实工作。',
    purpose: '阅读普通工作的本地记录与环境事实，由你自己的 Agent 整理尚未处理的增量；需要求助时再使用独立的 Case。',
    boundary: '阅读本地履历不会启动联网或模型。上传类型与在线账户的公开查询分别设置。',
    available: '当前可用',
    next: '建议下一步',
    future: '后续能力',
    interactionTitle: '如何使用控制台',
    status: '查看本机状态',
    history: '阅读本地工作履历',
    historyDescription: '查看真实观察及来源，由自己的 Agent 整理尚未处理的增量。',
    case: '开始或继续一个 Case',
    privacy: '检查隐私控制',
    setup: '检查设置变更',
    language: '切换显示语言',
    website: '打开 Galaxy 官网',
    worker: 'Galaxy Worker',
    hub: 'Galaxy Hub',
    workerDescription: '在受控政策下运行的 7×24 Agent Runtime；Founding Beta 尚未实现。',
    hubDescription: '具有自身政策和证据边界的组织或社区银河；Founding Beta 尚未实现。',
    caseDescription: '记录本地工作真正卡住的位置，不会发布内容。',
    privacyDescription: '查看和调整四档上传类型；完整会话默认排除，需要另行选择。',
    setupDescription: '任何新增本地能力都必须先预览，再明确确认。',
    languageDescription: '只影响当前宿主对话的显示。',
    websiteDescription: '仅在明确请求时打开已配置的 HTTPS 官网。',
    guidance: [
      '普通工作使用本地履历，不需要先创建正式 Case；摘要由自己的 Agent 整理。',
      '在任何未来披露决定前，先检查隐私控制。',
      '只有需要显式变更本地能力时，才进入设置。',
    ],
    interactionRules: [
      '输入 /Galaxy status 查看本机 Galaxy，不会改变任何内容。',
      '输入 /Galaxy history 阅读本地工作；输入 /Galaxy privacy 查看已保存的上传选择。',
      '只有准备检查设置变更时才输入 /Galaxy setup；随时输入 /Galaxy help 查看完整命令。',
    ],
  };
}

export function getGalaxyConsoleContract(status, interaction = {}) {
  const copy = getGalaxyConsoleCopy(interaction.language);
  const enabledModuleIds = new Set(status.integration?.modules?.map((module) => module.id) ?? []);
  const path = status.integration?.initializationPath ?? null;
  return {
    version: '2026-08-31',
    product: 'Galaxy',
    type: 'galaxy-console',
    language: interaction.language === 'en-US' ? 'en-US' : 'zh-CN',
    standaloneSurface: false,
    header: { title: copy.title },
    welcome: {
      title: copy.welcome,
      summary: copy.summary,
      purpose: copy.purpose,
      boundary: copy.boundary,
    },
    localStatus: {
      initializationPath: path,
      galaxyId: status.galaxyId?.id ?? null,
      subjectType: status.galaxyId?.subjectType ?? null,
      uploadPrivacy: status.uploadPrivacy,
      localOnly: true,
    },
    interactionGuide: {
      title: copy.interactionTitle,
      rules: copy.interactionRules,
      routes: [
        { input: '/Galaxy status', command: 'status', effect: 'show-local-status' },
        { input: '/Galaxy history', command: 'history', effect: 'read-local-work-history' },
        { input: '/Galaxy case', command: 'case', effect: 'open-local-case-workspace' },
        { input: '/Galaxy privacy', command: 'privacy', effect: 'open-local-privacy-controls' },
        { input: '/Galaxy setup', command: 'setup', effect: 'preview-configuration-change' },
        { input: '/Galaxy language', command: 'language', effect: 'choose-conversation-language' },
        { input: '/Galaxy website', command: 'website', effect: 'request-official-website-open' },
        { input: '/Galaxy help', command: 'help', effect: 'show-command-directory' },
        { input: '/Galaxy connect', command: 'connect', effect: 'show-local-connection-contract' },
      ],
    },
    sections: [
      {
        id: 'available',
        title: copy.available,
        actions: [
          { id: 'status', command: 'status', title: copy.status, selectable: true },
          { id: 'connect', command: 'connect', title: interaction.language === 'en-US' ? 'Connect to Galaxy' : '接入银河', selectable: true },
          { id: 'history', command: 'history', title: copy.history, description: copy.historyDescription, selectable: true },
          { id: 'case', command: 'case', title: copy.case, description: copy.caseDescription, selectable: enabledModuleIds.has('case-workspace') },
          { id: 'privacy', command: 'privacy', title: copy.privacy, description: copy.privacyDescription, selectable: true },
          { id: 'worker-identity', command: 'worker', title: interaction.language === 'en-US' ? 'Separate Worker identity' : '独立 Worker 身份',
            description: interaction.language === 'en-US' ? 'Create an isolated Agent identity; does not start a Worker runtime.' : '通过独立路径创建 Agent 主体，不改变普通客户端身份，也不启动 Worker 运行时。', selectable: true },
        ],
      },
      {
        id: 'guidance',
        title: copy.next,
        guidance: copy.guidance,
        actions: [
          { id: 'setup', command: 'setup', title: copy.setup, description: copy.setupDescription, selectable: true },
          { id: 'language', command: 'language', title: copy.language, description: copy.languageDescription, selectable: true },
          { id: 'website', command: 'website', title: copy.website, description: copy.websiteDescription, selectable: true },
        ],
      },
      {
        id: 'future',
        title: copy.future,
        actions: [
          { id: 'hub', command: 'hub', title: copy.hub, description: copy.hubDescription, selectable: false, availability: 'planned' },
        ],
      },
    ],
  };
}

export function normalizeGalaxyCommand(command) {
  const value = typeof command === 'string' && command.trim() ? command.trim().toLowerCase() : 'open';
  if (!Object.hasOwn(GALAXY_COMMANDS, value)) {
    throw new Error(`Unknown Galaxy command: ${value}.`);
  }
  return value;
}

export async function getGalaxyCommandSurface(dataDirectory, command = 'open', interaction = {}) {
  const normalizedCommand = normalizeGalaxyCommand(command);
  const commandDefinition = GALAXY_COMMANDS[normalizedCommand];
  const status = await getGalaxyIntegrationStatus(dataDirectory);
  const initializationPaths = listGalaxyInitializationPaths();
  if (status.recoveryRequired) return {
    command: normalizedCommand, route: 'galaxy-local-recovery', state: 'recovery-required',
    title: 'Local Galaxy recovery required',
    message: 'A local initialization or reset was interrupted. Preserve the local files and explicitly resume initialization or reset after reviewing the pending operation. This read performs no recovery.',
    recoveryRequired: true, nextTools: [], localOnly: true,
  };

  if (normalizedCommand === 'connect') {
    const { getGalaxyConnectionStatus } = await import('../connection-profile.mjs');
    return {
      command: normalizedCommand, route: commandDefinition.route, state: 'not-connected',
      connectionContract: await getGalaxyConnectionStatus(dataDirectory),
      nextTools: ['galaxy_connection_preview', 'galaxy_connection_status'], localOnly: true,
    };
  }

  if (normalizedCommand === 'help') {
    return {
      command: normalizedCommand,
      state: 'ready',
      route: commandDefinition.route,
      title: commandDefinition.title,
      message: 'Choose a Galaxy command. Commands do not create a Galaxy ID unless the final initialization confirmation is completed.',
      commands: GALAXY_COMMAND_HELP,
      localOnly: true,
    };
  }

  if (normalizedCommand === 'language') {
    return {
      command: normalizedCommand,
      state: 'language-selection',
      route: commandDefinition.route,
      title: commandDefinition.title,
      message: 'Choose the display language for this Galaxy interaction. This choice is not stored in your Galaxy ID or local initialization state.',
      initializationContract: getGalaxyInitializationContract(),
      localOnly: true,
    };
  }

  if (normalizedCommand === 'website') {
    return {
      command: normalizedCommand,
      state: 'website-entry',
      route: commandDefinition.route,
      title: commandDefinition.title,
      message: 'On Windows, the Galaxy website can be opened only after you explicitly confirm the configured official HTTPS address. No URL is inferred or opened automatically.',
      nextTools: ['galaxy_open_official_website'],
      localOnly: true,
    };
  }

  // These are local reads and remain useful for an existing identity whose
  // optional integration modules have not been enabled.
  if (normalizedCommand === 'privacy') return {
    command: normalizedCommand, route: commandDefinition.route, state: 'ready', title: commandDefinition.title,
    privacy: await getLocalUploadPrivacy(dataDirectory), nextTools: ['galaxy_local_upload_privacy_get', 'galaxy_local_upload_privacy_set'], localOnly: true,
  };
  if (normalizedCommand === 'worker') return {
    command:normalizedCommand,route:'galaxy-worker-identity',state:'identity-setup-available',title:'Separate Worker identity',
    message:'Agent subjects use an isolated Worker directory. Creating that local identity preserves the normal client ID/history and starts no Worker, model, connection or upload.',
    runtimeStarted:false,nextTools:['galaxy_local_worker_identity_create'],localOnly:true,
  };
  if ((normalizedCommand === 'history' || normalizedCommand === 'work') && status.galaxyId) return {
    command: normalizedCommand, route: commandDefinition.route, state: 'ready', title: commandDefinition.title,
    history: await createLocalWorkHistory({dataDirectory}).list(),
    nextTools: ['galaxy_local_work_list', 'galaxy_local_work_get', 'galaxy_local_work_pending', 'galaxy_local_work_summary', 'galaxy_local_work_note'], localOnly: true,
  };

  if (!status.initialized) {
    if (normalizedCommand === 'status') {
      return {
        command: normalizedCommand,
        state: 'not-initialized',
        route: commandDefinition.route,
        title: commandDefinition.title,
        message: 'Galaxy is not initialized on this device. No Galaxy ID, remote account, sync, Worker, Hub, or uploaded data exists.',
        initializationPaths,
        nextTools: ['galaxy_command', 'galaxy_integration_preview_initialization'],
        localOnly: true,
      };
    }
    return {
      command: normalizedCommand,
      state: 'needs-initialization',
      route: 'galaxy-initialization',
      title: 'Set up Galaxy once',
      message: 'Galaxy has not been initialized on this device. Choose an initialization path, preview its local effects, then confirm once.',
      initializationPaths,
      initializationContract: getGalaxyInitializationContract(interaction),
      initializationPresentation: getGalaxyInitializationPresentation(interaction),
      nextTools: ['galaxy_integration_preview_initialization', 'galaxy_integration_initialize'],
      localOnly: true,
    };
  }

  const enabledModuleIds = new Set(status.integration.modules.map((module) => module.id));
  const missingModules = (commandDefinition.requires ?? []).filter((moduleId) => !enabledModuleIds.has(moduleId));
  const requestedFuturePath = commandDefinition.futurePath
    ? initializationPaths.find((path) => path.id === commandDefinition.futurePath) ?? null
    : null;

  if (requestedFuturePath) {
    return {
      command: normalizedCommand,
      state: 'planned-service',
      route: 'galaxy-configuration-change',
      title: requestedFuturePath.title,
      message: `${requestedFuturePath.title} is a future initialization path. The current local Galaxy remains active; no Worker or Hub runtime has been created.`,
      currentInitializationPath: status.integration.initializationPath ?? null,
      requestedInitializationPath: requestedFuturePath,
      nextTools: ['galaxy_integration_preview_initialization'],
      localOnly: true,
    };
  }

  if (missingModules.length > 0) {
    return {
      command: normalizedCommand,
      state: 'needs-configuration-change',
      route: 'galaxy-configuration-change',
      title: commandDefinition.title,
      message: 'This local Galaxy is initialized, but the requested service is not enabled. Preview a configuration change before enabling it.',
      missingModules,
      currentInitializationPath: status.integration.initializationPath ?? null,
      nextTools: ['galaxy_integration_preview_initialization', 'galaxy_integration_initialize'],
      localOnly: true,
    };
  }

  const consoleContract = normalizedCommand === 'open' ? getGalaxyConsoleContract(status, interaction) : null;
  return {
    command: normalizedCommand,
    state: 'ready',
    route: commandDefinition.route,
    title: consoleContract?.header.title ?? commandDefinition.title,
    message: normalizedCommand === 'open'
      ? consoleContract.welcome.summary
      : normalizedCommand === 'setup'
      ? 'Galaxy is already initialized. Use setup only to preview and confirm a configuration change; normal work does not rerun initialization.'
      : 'Galaxy is already initialized. Continue with the requested local service without rerunning setup.',
    currentInitializationPath: status.integration.initializationPath ?? null,
    enabledModules: status.integration.modules,
    console: consoleContract,
    localOnly: true,
  };
}
