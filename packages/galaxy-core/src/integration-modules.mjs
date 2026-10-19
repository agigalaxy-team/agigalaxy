import {listUploadPrivacyLevels,normalizeUploadPrivacy,selectUploadPrivacy} from './upload-privacy.mjs';

const MODULES = [
  {
    id: 'galaxy-id',
    title: 'Galaxy ID',
    category: 'foundation',
    availability: 'available',
    defaultSelected: true,
    requires: [],
    createsLocalData: true,
    description: 'Creates a local Galaxy ID and device-held key material. It is not an account, verified identity, or public profile.',
  },
  {
    id: 'case-workspace',
    title: 'Coding Case workspace',
    category: 'local-workflow',
    availability: 'available',
    defaultSelected: true,
    requires: ['galaxy-id'],
    createsLocalData: true,
    description: 'Lets an AI host create local Coding Case Drafts and preserve attempted approaches.',
  },
  {
    id: 'consent-controls',
    title: 'Disclosure and consent controls',
    category: 'local-workflow',
    availability: 'available',
    defaultSelected: true,
    requires: ['case-workspace'],
    createsLocalData: true,
    description: 'Adds local disclosure previews, expiry-limited consent receipts, revocation, and Local Proof Drafts.',
  },
  {
    id: 'agent-mcp',
    title: 'Galaxy MCP workspace',
    category: 'agent-integration',
    availability: 'available',
    defaultSelected: true,
    requires: ['galaxy-id', 'case-workspace', 'consent-controls'],
    createsLocalData: false,
    description: 'Makes the selected local workflow available to an MCP-capable AI host over stdio.',
  },
  {
    id: 'agent-guidance',
    title: 'AI-guided setup',
    category: 'agent-integration',
    availability: 'available',
    defaultSelected: true,
    requires: ['agent-mcp'],
    createsLocalData: false,
    description: 'Provides a Skill that guides module selection and requires an explicit user confirmation before initialization.',
  },
  {
    id: 'openclaw-adapter',
    title: 'OpenClaw adapter',
    category: 'adapter',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'agent-mcp'],
    createsLocalData: false,
    description: 'Reserved for a future local adapter. It is not implemented and cannot be initialized in Founding Beta.',
  },
  {
    id: 'github-ci-verification',
    title: 'GitHub / CI verification adapter',
    category: 'verification',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'case-workspace'],
    createsLocalData: false,
    description: 'Reserved for future Result and Verification ingestion. It is not implemented and must not be presented as Evidence.',
  },
  {
    id: 'remote-sync',
    title: 'Remote sync',
    category: 'network',
    availability: 'planned',
    defaultSelected: false,
    requires: ['galaxy-id', 'consent-controls'],
    createsLocalData: false,
    description: 'Reserved for a future separately authorized remote service. Founding Beta has no remote sync.',
  },
];

const MODULE_BY_ID = new Map(MODULES.map((module) => [module.id, module]));

// An initialization path is a product-facing starting topology, not an
// identity type. Normal clients create person/organization IDs; Agent subjects
// use an isolated Worker identity path instead of retyping an existing ID.
// Worker and Hub remain visible as architecture paths but are intentionally
// non-selectable until their runtimes and safety contracts exist.
const INITIALIZATION_PATHS = [
  {
    id: 'personal-galaxy',
    title: 'Personal Galaxy',
    category: 'personal-edge',
    availability: 'available',
    defaultSelected: true,
    moduleIds: ['galaxy-id', 'case-workspace', 'consent-controls', 'agent-mcp', 'agent-guidance'],
    serviceCommands: ['open', 'status', 'setup', 'history', 'case', 'privacy'],
    privacyDefault: 'history-overview',
    requiresContinuousRuntime: false,
    description: 'Start a normal local client with a person or organization identity, ordinary work recording, own-Agent summaries and optional network access.',
    doesNotMean: 'A remote account, public profile, Worker, Hub membership, verified capability, or automatic sharing.',
  },
  {
    id: 'galaxy-worker',
    title: 'Galaxy Worker',
    category: 'agent-runtime',
    availability: 'planned',
    defaultSelected: false,
    moduleIds: [],
    futureCapabilityIds: ['worker-runtime', 'worker-pack', 'worker-policy', 'worker-health'],
    serviceCommands: ['open', 'status', 'setup', 'worker'],
    privacyDefault: 'policy-controlled',
    requiresContinuousRuntime: true,
    description: 'Run a specialized Agent continuously under a Worker policy, with versioned configuration and human-authorized context.',
    doesNotMean: 'Automatic task acceptance, access to raw Case context, automatic settlement, or proof of capability.',
  },
  {
    id: 'galaxy-hub',
    title: 'Galaxy Hub',
    category: 'organization-network',
    availability: 'planned',
    defaultSelected: false,
    moduleIds: [],
    futureCapabilityIds: ['hub-core', 'hub-policy', 'hub-evidence-network', 'hub-administration'],
    serviceCommands: ['open', 'status', 'setup', 'hub'],
    privacyDefault: 'hub-policy-controlled',
    requiresContinuousRuntime: true,
    description: 'Operate a community or organization Galaxy with its own local policy, evidence network, data boundary, and optional Workers.',
    doesNotMean: 'Ownership of member Galaxy IDs, permission to rewrite facts, or authority to fabricate external Evidence.',
  },
];

const INITIALIZATION_PATH_BY_ID = new Map(INITIALIZATION_PATHS.map((path) => [path.id, path]));

// This is intentionally presentation data, not a renderer. Host adapters own
// their native slash-command UI and must not turn it into a Galaxy terminal,
// web page, ANSI screen, or a persisted source of truth.
export const GALAXY_INITIALIZATION_PRESENTATION = Object.freeze({
  version: '2026-08-31',
  hostOwnership: 'native-host-adapter',
  standaloneSurface: false,
  characterLogo: false,
  header: Object.freeze({
    title: 'Galaxy / 初始化',
    placement: 'top-center',
  }),
  footer: Object.freeze({
    placement: 'bottom-center',
    navigationPlacement: 'footer-sides',
    totalStages: 5,
    keyboardHint: '← → 切换　Enter 确认　Esc 返回',
  }),
  firstScreen: Object.freeze({
    title: '欢迎加入银河',
    functionalVision: 'Galaxy 从真实工作中的难题出发：当现有 AI 和工具反复无法推进时，它帮助你发现合适的人、Agent、团队与解决方案；被验证的协作经验会持续沉淀、复用并开放连接，让每一次解决都为下一次更快的发现、选择与协作创造价值。',
    selectionLabel: '请选择银河形态',
  }),
});

const GALAXY_LANGUAGE_OPTIONS = Object.freeze([
  {
    id: 'zh-CN',
    title: '简体中文',
    description: '以简体中文继续本次 Galaxy 配置引导。',
    inputAliases: ['中文', '简体中文', 'Chinese'],
  },
  {
    id: 'en-US',
    title: 'English',
    description: 'Continue this Galaxy setup in English.',
    inputAliases: ['English', '英文', '英语'],
  },
]);

function resolveGalaxyLanguage(language) {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
}

function localizedCopy(language) {
  if (resolveGalaxyLanguage(language) === 'en-US') {
    return {
      header: 'Galaxy / Setup',
      welcome: 'Welcome to Galaxy',
      purpose: 'When an important piece of real work stops moving with the AI and tools you already have, Galaxy helps you capture the hard point, find an appropriate person, Agent, team, or solution, and continue with clear boundaries.',
      vision: 'Over time, verified collaboration experience can be retained, reused, and openly connected, so every resolution improves future discovery, choice, and collaboration.',
      whatItDoes: 'What Galaxy helps you do',
      whyItMatters: 'Why it exists',
      shape: 'Choose your Galaxy form',
      shapePrompt: 'Choose the product form for your first Galaxy deployment.',
      modules: 'Local work and connection tools',
      modulesPrompt: 'Local work capabilities and network connection preparation are selected by default.',
      privacy: 'Allowed upload data types',
      privacyPrompt: 'Level 2 is preselected. This local selection starts no upload and does not set online public visibility.',
      identity: 'Galaxy ID',
      identityPrompt: 'Choose how to create or bind your Galaxy ID.',
      confirmation: 'Confirm initialization',
      confirmationPrompt: 'Review local effects and explicitly confirm. Nothing before this step writes local state.',
      keyboard: 'Enter confirm  Esc back',
      languageTitle: 'Choose language / 选择语言',
      languagePrompt: 'Choose the display language for this Galaxy setup. You can change it later.',
      languageFooter: 'Reply 1 or 2, or type 中文 / English.',
      listFooter: 'Reply with a number to continue, or Esc to go back.',
      planned: '(planned)',
      required: '(required by default)',
      selected: '●',
      unselected: '○',
    };
  }
  return {
    header: 'Galaxy / 初始化',
    welcome: '欢迎加入银河',
    purpose: '当重要的真实工作被现有 AI 和工具反复卡住时，Galaxy 帮助你记录难点、发现合适的人、Agent、团队或解决方案，并在清晰边界内继续推进。',
    vision: '被验证的协作经验会持续沉淀、复用并开放连接，让每一次解决都为下一次更快的发现、选择与协作创造价值。',
    whatItDoes: 'Galaxy 能做什么',
    whyItMatters: 'Galaxy 为什么存在',
    shape: '请选择银河形态',
    shapePrompt: '请选择你首次部署 Galaxy 的产品形态。',
    modules: '本地工作与接入工具',
    modulesPrompt: '默认预选本地工作能力与网络接入准备。',
    privacy: '允许上传的数据类型',
    privacyPrompt: '预选第 2 档。此本地选择不启动上传，也不设置在线账户对外公开范围。',
    identity: 'Galaxy ID',
    identityPrompt: '选择创建或绑定方式。',
    confirmation: '确认初始化',
    confirmationPrompt: '检查本地影响后明确确认；此前步骤不应写入本地状态。',
    keyboard: 'Enter 确认　Esc 返回',
    languageTitle: '选择语言 / Choose language',
    languagePrompt: '请选择本次 Galaxy 配置引导的显示语言；之后可随时更改。',
    languageFooter: '输入 1 或 2，或直接输入 中文 / English。',
    listFooter: '输入编号继续，或 Esc 返回。',
    planned: '（规划中）',
    required: '（默认必要）',
    selected: '●',
    unselected: '○',
  };
}

export function getGalaxyLanguageSelection() {
  return {
    id: 'language',
    title: '选择语言 / Choose language',
    prompt: '选择本次 Galaxy 配置引导的显示语言。 / Choose the display language for this Galaxy setup.',
    selection: 'single',
    options: GALAXY_LANGUAGE_OPTIONS.map((option) => ({ ...option })),
    note: '语言只影响当前对话的显示；不会创建 Galaxy ID、写入本地状态或开启服务。 / This only changes the current conversation display; it does not create or change anything.',
    interactionGuide: {
      title: '如何继续 / How to continue',
      rules: [
        '输入 1 或“中文 / 简体中文”进入中文引导；输入 2 或“English / 英文 / 英语”进入 English setup。',
        '输入“取消 / cancel”可结束本次引导；不会保存任何内容。',
        '随时输入 /Galaxy help 查看命令；输入 /Galaxy status 查看本机状态。',
      ],
      routes: [
        { input: ['1', '中文', '简体中文'], action: 'set-language', language: 'zh-CN', nextStage: 1 },
        { input: ['2', 'English', '英文', '英语'], action: 'set-language', language: 'en-US', nextStage: 1 },
        { input: ['取消', 'cancel'], action: 'exit-without-write' },
      ],
    },
  };
}

export const DEFAULT_MODULE_IDS = MODULES
  .filter((module) => module.defaultSelected)
  .map((module) => module.id);

export const MODULE_PROFILES = Object.freeze({
  minimal: ['galaxy-id'],
  'coding-case': ['galaxy-id', 'case-workspace', 'consent-controls'],
  'agent-workspace': DEFAULT_MODULE_IDS,
});

function cloneModule(module) {
  return { ...module, requires: [...module.requires] };
}

function cloneInitializationPath(path) {
  return {
    ...path,
    moduleIds: [...path.moduleIds],
    futureCapabilityIds: [...(path.futureCapabilityIds ?? [])],
    serviceCommands: [...path.serviceCommands],
  };
}

function uniqueIds(moduleIds) {
  if (moduleIds === undefined || moduleIds === null) {
    return [];
  }
  if (!Array.isArray(moduleIds)) {
    throw new Error('modules must be an array of module identifiers.');
  }
  return [...new Set(moduleIds.map((moduleId) => String(moduleId).trim()).filter(Boolean))];
}

export function listIntegrationModules() {
  return {
    modules: MODULES.map(cloneModule),
    initializationPaths: INITIALIZATION_PATHS.map(cloneInitializationPath),
    profiles: Object.fromEntries(
      Object.entries(MODULE_PROFILES).map(([name, moduleIds]) => [name, [...moduleIds]]),
    ),
  };
}

export function listGalaxyInitializationPaths() {
  return INITIALIZATION_PATHS.map(cloneInitializationPath);
}

export function getGalaxyInitializationPresentation({ stage = 1, language } = {}) {
  const resolvedLanguage = resolveGalaxyLanguage(language);
  const copy = localizedCopy(resolvedLanguage);
  const totalStages = GALAXY_INITIALIZATION_PRESENTATION.footer.totalStages;
  const normalizedStage = Number.isInteger(stage) && stage >= 1 && stage <= totalStages ? stage : 1;
  const footer = GALAXY_INITIALIZATION_PRESENTATION.footer;

  return {
    version: GALAXY_INITIALIZATION_PRESENTATION.version,
    hostOwnership: GALAXY_INITIALIZATION_PRESENTATION.hostOwnership,
    standaloneSurface: GALAXY_INITIALIZATION_PRESENTATION.standaloneSurface,
    characterLogo: GALAXY_INITIALIZATION_PRESENTATION.characterLogo,
    language: resolvedLanguage,
    header: { ...GALAXY_INITIALIZATION_PRESENTATION.header, title: copy.header },
    footer: {
      ...footer,
      stage: normalizedStage,
      progressText: resolvedLanguage === 'en-US'
        ? `Step ${normalizedStage} / ${footer.totalStages}  ${copy.keyboard}`
        : `阶段 ${normalizedStage} / ${footer.totalStages}　${copy.keyboard}`,
    },
    firstScreen: {
      ...GALAXY_INITIALIZATION_PRESENTATION.firstScreen,
      title: copy.welcome,
      functionalVision: `${copy.purpose} ${copy.vision}`,
      selectionLabel: copy.shape,
      initializationPaths: listGalaxyInitializationPaths(),
    },
  };
}

export const GALAXY_HOST_CAPABILITIES = Object.freeze({
  slashCommand: false,
  nativeSingleSelect: false,
  nativeMultiSelect: false,
  nativeConfirm: false,
  richDialog: false,
});

function normalizeHostCapabilities(capabilities = {}) {
  return Object.fromEntries(
    Object.entries(GALAXY_HOST_CAPABILITIES).map(([name, fallback]) => [
      name,
      capabilities[name] === undefined ? fallback : Boolean(capabilities[name]),
    ]),
  );
}

// A rich dialog is an optional host enhancement, never the product baseline.
// Any host can fall back to the same numbered list without inventing another
// Galaxy terminal, UI runtime, or state store.
export function resolveGalaxyInteractionMode(capabilities = {}) {
  const normalized = normalizeHostCapabilities(capabilities);
  if (normalized.richDialog && normalized.nativeSingleSelect && normalized.nativeConfirm) {
    return { id: 'rich-dialog', capabilities: normalized };
  }
  if (normalized.nativeSingleSelect && normalized.nativeConfirm) {
    return { id: 'native-select', capabilities: normalized };
  }
  return { id: 'numbered-list', capabilities: normalized };
}

function initializationStage(number, id, title, prompt, options, extras = {}) {
  return {
    number,
    id,
    title,
    prompt,
    options,
    ...extras,
  };
}

function initializationInteractionGuide(stage, language) {
  const english = resolveGalaxyLanguage(language) === 'en-US';
  const common = english
    ? ['Type /Galaxy help for all commands or /Galaxy status to inspect this device. Type cancel at any point to leave without writing local state.']
    : ['随时输入 /Galaxy help 查看全部命令，或输入 /Galaxy status 查看本机状态；输入“取消”会退出且不写入本地状态。'];
  const details = {
    1: english
      ? ['Enter 1 or “Personal Galaxy” to continue. Worker and Hub are shown for orientation only and cannot be selected.', 'Type back to return to language selection.']
      : ['输入 1 或“个人银河”继续。Agent 7×24 与 Galaxy Hub 仅供了解，当前不能选择。', '输入“返回”回到语言选择。'],
    2: english
      ? ['L3 is preselected. Type continue to choose allowed upload data types; nothing is saved yet.', 'Type back to revisit the Galaxy form.']
      : ['已预选 L3。输入“继续”选择允许上传的数据类型；此时不保存任何配置。', '输入“返回”回到银河形态。'],
    3: english
      ? ['Choose a level from 1 to 4; level 2 is preselected. Full conversations remain excluded unless separately enabled for selected sessions.', 'Type back to revisit the L3 package.']
      : ['选择第 1 至 4 档；预选第 2 档。完整会话仍默认排除，需要另行开启并选定会话。', '输入“返回”回到 L3 能力包。'],
    4: english
      ? ['Create a local ID with Person preselected, or choose Organization. Agent subjects use the separate Worker setup.', 'Type back to revisit privacy.']
      : ['创建本地 ID，默认个人，也可额外选择组织。Agent 主体通过独立 Worker 入口创建。', '输入“返回”回到隐私选择。'],
    5: english
      ? ['Type “Confirm initialization” to create the local Personal Galaxy. Type back to change an earlier choice, or cancel to exit without writing.', 'Nothing is written until this exact confirmation is received.']
      : ['输入“确认初始化”才会创建本地 Personal Galaxy。输入“返回”修改之前的选择，或输入“取消”直接退出。', '在收到这句明确确认前，不会写入任何本地状态。'],
  };
  const routes = {
    1: { select: ['1', english ? 'Personal Galaxy' : '个人银河'], nextStage: 2, backStage: 'language-selection' },
    2: { select: [english ? 'continue' : '继续'], nextStage: 3, backStage: 1 },
    3: { select: ['1', '2', '3', '4'], defaultSelection: 'history-overview', nextStage: 4, backStage: 2 },
    4: { select: ['1', english ? 'Create a new Galaxy ID' : '创建新的 Galaxy ID'], nextStage: 5, backStage: 3 },
    5: { confirm: [english ? 'Confirm initialization' : '确认初始化'], backStage: 4 },
  };
  return {
    title: english ? 'How to continue' : '如何继续',
    rules: [...details[stage], ...common],
    routes: routes[stage],
  };
}

function userModuleOptions(language) {
  const english = resolveGalaxyLanguage(language) === 'en-US';
  return [
    {
      id: 'galaxy-id',
      title: english ? 'Galaxy ID and local identity card' : '银河 ID 与本地身份卡',
      description: english ? 'A local Galaxy ID and device-held key material; not a remote account or public profile.' : '本机保存的 Galaxy ID 和设备持有的密钥材料；不是远程账户或公开资料。',
      selected: true,
      selectable: false,
      required: true,
      availability: 'available',
    },
    {
      id: 'case-workspace',
      title: english ? 'Galaxy Case and local history' : 'Galaxy Case 与本地历史',
      description: english ? 'Keeps local attempts and Case Drafts from work.' : '保留本地工作中的尝试与 Case Draft。',
      selected: true,
      selectable: false,
      required: true,
      availability: 'available',
    },
    {
      id: 'consent-controls',
      title: english ? 'Privacy consent and authorization records' : '隐私同意与授权记录',
      description: english ? 'Local disclosure previews, time-limited consent, revocation records, and Local Proof Drafts.' : '本地披露预览、限期授权、撤销记录和 Local Proof Draft。',
      selected: true,
      selectable: false,
      required: true,
      availability: 'available',
    },
    {
      id: 'agent-mcp',
      title: english ? 'Agent / MCP integration' : 'Agent / MCP 接入',
      description: english ? 'A required default Galaxy capability, called by a host through MCP or Skill.' : 'Galaxy 的默认必要能力，由宿主通过 MCP 或 Skill 调用。',
      selected: true,
      selectable: false,
      required: true,
      availability: 'available',
    },
    {
      id: 'local-service-discovery',
      title: english ? 'Local service discovery' : '本地服务发现',
      description: english ? 'Awaiting independent local discovery and authorization semantics.' : '等待独立的本地服务发现与授权语义。',
      selected: false,
      selectable: false,
      required: false,
      availability: 'planned',
    },
    {
      id: 'hub-connection',
      title: english ? 'Hub connection' : 'Hub 连接',
      description: english ? 'Awaiting Hub Core, member boundaries, data residency, and an evidence network.' : '等待 Hub Core、成员边界、数据驻留和证据网络。',
      selected: false,
      selectable: false,
      required: false,
      availability: 'planned',
    },
  ];
}

function localizedInitializationPath(path, language) {
  if (resolveGalaxyLanguage(language) === 'en-US') return path;
  const chinese = {
    'personal-galaxy': {
      title: '个人银河',
      description: '从本地 AI 工作、Case 记录、披露预览、授权与本地历史开始。',
    },
    'galaxy-worker': {
      title: 'Agent 7×24',
      description: '以版本化配置和受控规则持续运行专业 Agent。',
    },
    'galaxy-hub': {
      title: 'Galaxy Hub',
      description: '为组织或社区运行具有本地政策、证据网络、数据边界和可选 Worker 的银河。',
    },
  };
  const translation = chinese[path.id];
  return translation ? { ...path, ...translation } : { ...path };
}

function cloneContractOption(option) {
  return { ...option };
}

// This contract is the portable product contract. It is data only: it neither
// draws a terminal nor changes local state. The adapter must call preview and
// initialization tools separately, and only after the final confirmation.
export function getGalaxyInitializationContract({ stage = 1, hostCapabilities, language, subjectType = 'person', uploadPrivacy } = {}) {
  const totalStages = 5;
  if (!language) {
    return {
      version: '2026-08-31',
      product: 'Galaxy',
      phase: 'language-selection',
      language: null,
      standaloneSurface: false,
      interaction: resolveGalaxyInteractionMode(hostCapabilities),
      languageSelection: getGalaxyLanguageSelection(),
      actions: { status: 'galaxy_command' },
    };
  }
  const resolvedLanguage = resolveGalaxyLanguage(language);
  const copy = localizedCopy(resolvedLanguage);
  const normalizedStage = Number.isInteger(stage) && stage >= 1 && stage <= totalStages ? stage : 1;
  const interaction = resolveGalaxyInteractionMode(hostCapabilities);
  const privacy = normalizeUploadPrivacy(uploadPrivacy);
  const stages = [
    initializationStage(
      1,
      'shape',
      copy.shape,
      copy.shapePrompt,
      listGalaxyInitializationPaths().map((rawPath) => {
        const path = localizedInitializationPath(rawPath, resolvedLanguage);
        return ({
        id: path.id,
        title: path.title,
        description: path.description,
        selected: path.defaultSelected,
        selectable: path.availability === 'available',
        availability: path.availability,
        disabledReason: path.availability === 'available' ? null : resolvedLanguage === 'en-US' ? 'This runtime is not implemented in Founding Beta.' : 'Founding Beta 尚未实现此运行时。',
        });
      }),
      {
        welcome: {
          title: copy.welcome,
          purposeTitle: copy.whatItDoes,
          purpose: copy.purpose,
          visionTitle: copy.whyItMatters,
          vision: copy.vision,
        },
        intro: `${copy.purpose}\n\n${copy.vision}`,
        selection: 'single',
      },
    ),
    initializationStage(
      2,
      'capability-package',
      copy.modules,
      copy.modulesPrompt,
      userModuleOptions(resolvedLanguage),
      {
        selection: 'summary',
        capabilityProfile: 'l3-foundation',
        defaultSelected: true,
        note: resolvedLanguage === 'en-US' ? 'Local recording and own-Agent organization work without a network model. Service discovery and compatible Hub access are prepared; no endpoint is connected by initialization.' : '本地记录与自己的 Agent 整理可离线使用；准备官方服务发现与兼容 Hub 接入。初始化不会连接端点。',
      },
    ),
    initializationStage(
      3,
      'upload-privacy',
      copy.privacy,
      copy.privacyPrompt,
      listUploadPrivacyLevels().map(level => ({id: level.id, title: resolvedLanguage === 'en-US' ? level.titleEn : level.title,
        description: level.description, selected: privacy.level === level.id, selectable: true, availability: 'available', dataTypes: level.dataTypes})),
      { selection: 'single', uploadPrivacy: privacy, fullConversationSelectionRequired: true, note: resolvedLanguage === 'en-US'
        ? 'This controls upload data types only. A real selected service and permitted scope are also required. Public visibility is separately managed by the online account. Full conversations are excluded by default, including at level 4.'
        : '这里只限制允许上传的数据类型；实际发送还需已选择的服务与有效范围。在线账户另管公开查询。第 4 档也默认排除完整会话。' },
    ),
    initializationStage(
      4,
      'identity',
      copy.identity,
      copy.identityPrompt,
      [
        {
          id: 'create-local-id',
          title: resolvedLanguage === 'en-US' ? 'Create a new Galaxy ID' : '创建新的 Galaxy ID',
          description: resolvedLanguage === 'en-US' ? 'Create a new Galaxy ID on this device; no remote account is registered.' : '在本机创建新的 Galaxy ID；不注册远程账户。',
          selected: true,
          selectable: true,
          availability: 'available',
        },
        {
          id: 'bind-existing-id',
          title: resolvedLanguage === 'en-US' ? 'Bind an existing ID (planned)' : '绑定已有 ID（规划中）',
          description: resolvedLanguage === 'en-US' ? 'Requires possession proof, recovery, and binding semantics.' : '需要持有证明、恢复与绑定语义。',
          selected: false,
          selectable: false,
          availability: 'planned',
          disabledReason: resolvedLanguage === 'en-US' ? 'Existing-ID binding is not implemented.' : '已有 ID 绑定尚未实现。',
        },
      ],
      { selection: 'single', subjectType, subjectTypes: [
        {id: 'person', title: resolvedLanguage === 'en-US' ? 'Person' : '个人', selected: subjectType === 'person'},
        {id: 'organization', title: resolvedLanguage === 'en-US' ? 'Organization' : '组织', selected: subjectType === 'organization'},
      ], typeImmutable: true, workerIdentityTool: 'galaxy_local_worker_identity_create' },
    ),
    initializationStage(
      5,
      'confirmation',
      copy.confirmation,
      copy.confirmationPrompt,
      [],
      {
        selection: 'confirm',
        confirmationRequired: true,
        note: resolvedLanguage === 'en-US' ? 'Confirm L3: enable local modules and save the capability snapshot and empty connection intentions. No remote connection or data transfer.' : '确认 L3：启用本地模块，保存能力快照与空的连接意图。未连接远程端点，不传输数据。',
      },
    ),
  ];
  const routedStages = stages.map((item) => ({
    ...item,
    interactionGuide: initializationInteractionGuide(item.number, resolvedLanguage),
  }));
  const currentStage = routedStages[normalizedStage - 1];

  return {
    version: '2026-09-06',
    product: 'Galaxy',
    phase: 'initialization',
    language: resolvedLanguage,
    standaloneSurface: false,
    interaction,
    header: { title: copy.header },
    progress: {
      current: normalizedStage,
      total: totalStages,
      keyboardHint: copy.keyboard,
    },
    richLayoutHint: {
      headerPlacement: 'top-center',
      progressPlacement: 'bottom-center',
      navigationPlacement: 'footer-sides',
      characterLogo: false,
    },
    currentStage: {
      ...currentStage,
      options: currentStage.options.map(cloneContractOption),
    },
    stages: routedStages.map((item) => ({
      ...item,
      options: item.options.map(cloneContractOption),
    })),
    actions: {
      preview: 'galaxy_integration_preview_initialization',
      confirm: 'galaxy_integration_initialize',
      status: 'galaxy_command',
    },
  };
}

// This is the lowest common rendering form. It is ordinary host text that a
// user answers inside the host conversation, not an ANSI screen or shell UI.
export function renderGalaxyNumberedList(contract) {
  if (contract.phase === 'language-selection') {
    const selection = contract.languageSelection;
    const lines = [selection.title, '', selection.prompt, ''];
    for (const [index, option] of selection.options.entries()) {
      lines.push(`[${index + 1}] ${option.title}`, `    ${option.description}`);
    }
    lines.push('', selection.note, '', selection.interactionGuide.title);
    for (const rule of selection.interactionGuide.rules) lines.push(`• ${rule}`);
    return lines.join('\n');
  }
  const stage = contract.currentStage;
  const copy = localizedCopy(contract.language);
  const lines = [
    contract.header.title,
    contract.language === 'en-US' ? `Step ${contract.progress.current} / ${contract.progress.total}` : `阶段 ${contract.progress.current} / ${contract.progress.total}`,
    '',
  ];
  if (stage.welcome) {
    lines.push(stage.welcome.title, '', stage.welcome.purposeTitle, stage.welcome.purpose, '', stage.welcome.visionTitle, stage.welcome.vision, '');
  } else if (stage.intro) {
    lines.push(stage.intro, '');
  }
  lines.push(stage.title, stage.prompt, '');
  for (const [index, option] of stage.options.entries()) {
    const marker = option.selected ? copy.selected : copy.unselected;
    const unavailable = option.availability !== 'available' && !option.title.includes(copy.planned) ? ` ${copy.planned}` : '';
    const required = option.required ? copy.required : '';
    lines.push(`[${index + 1}] ${marker} ${option.title}${unavailable}${required}`);
    if (option.description) lines.push(`    ${option.description}`);
  }
  if (stage.note) lines.push('', stage.note);
  if (stage.confirmationRequired) {
    lines.push(
      '',
      contract.language === 'en-US'
        ? 'Type the exact phrase “Confirm initialization” to create the local Personal Galaxy.'
        : '请输入精确的“确认初始化”以创建本地 Personal Galaxy。',
    );
  }
  lines.push('', stage.interactionGuide.title);
  for (const rule of stage.interactionGuide.rules) lines.push(`• ${rule}`);
  lines.push('', `${copy.listFooter} ${contract.progress.keyboardHint}`);
  return lines.join('\n');
}

export function resolveModuleSelection({ modules, profile } = {}) {
  if (profile && !MODULE_PROFILES[profile]) {
    throw new Error(`Unknown Galaxy Integration profile: ${profile}.`);
  }
  if (profile && modules && modules.length > 0) {
    throw new Error('Choose either a profile or an explicit module list, not both.');
  }

  const explicitModuleIds = profile
    ? [...MODULE_PROFILES[profile]]
    : uniqueIds(modules);
  const requestedModuleIds = explicitModuleIds.length > 0 ? explicitModuleIds : [...DEFAULT_MODULE_IDS];
  const resolvedIds = [];
  const impliedBy = new Map();

  function add(moduleId, requiredBy = null) {
    const definition = MODULE_BY_ID.get(moduleId);
    if (!definition) {
      throw new Error(`Unknown Galaxy Integration module: ${moduleId}.`);
    }
    if (definition.availability !== 'available') {
      throw new Error(`${definition.title} is ${definition.availability} and cannot be initialized in Founding Beta.`);
    }
    for (const dependencyId of definition.requires) {
      add(dependencyId, moduleId);
    }
    if (!resolvedIds.includes(moduleId)) {
      resolvedIds.push(moduleId);
    }
    if (requiredBy && !explicitModuleIds.includes(moduleId)) {
      const dependencies = impliedBy.get(moduleId) ?? [];
      impliedBy.set(moduleId, [...new Set([...dependencies, requiredBy])]);
    }
  }

  for (const moduleId of requestedModuleIds) {
    add(moduleId);
  }

  return {
    profile: profile ?? null,
    requestedModuleIds,
    modules: resolvedIds.map((moduleId) => ({
      ...cloneModule(MODULE_BY_ID.get(moduleId)),
      impliedBy: impliedBy.get(moduleId) ?? [],
    })),
    localOnly: true,
    remoteEffects: 'none',
    notes: [
      'Initialization writes only local configuration and, when Galaxy ID is selected, local key material.',
      'No selected module uploads Case content, publishes Proof, creates a remote account, or enables remote sync.',
    ],
  };
}

export function resolveGalaxyInitialization({ initializationPath, modules, profile, allowPlanned = false, subjectType, uploadPrivacy } = {}) {
  if (subjectType !== undefined && !['person', 'organization'].includes(subjectType)) throw Object.assign(new Error('local_identity_subject_type_invalid'), {code: 'local_identity_subject_type_invalid'});
  const localSelection = {subjectType: subjectType ?? 'person', uploadPrivacy: uploadPrivacy === undefined ? normalizeUploadPrivacy() : selectUploadPrivacy(undefined, uploadPrivacy)};
  if (!initializationPath && modules === undefined && profile === undefined) {
    return resolveGalaxyInitialization({ initializationPath: 'personal-galaxy', subjectType, uploadPrivacy });
  }
  if (!initializationPath) {
    return {
      ...resolveModuleSelection({ modules, profile }),
      initializationPath: null,
      operation: 'module-change',
      ...localSelection,
    };
  }
  if (profile || (Array.isArray(modules) && modules.length > 0)) {
    throw new Error('Choose either an initialization path or a legacy profile/module list, not both.');
  }

  const path = INITIALIZATION_PATH_BY_ID.get(String(initializationPath).trim());
  if (!path) throw new Error(`Unknown Galaxy initialization path: ${initializationPath}.`);
  if (path.availability !== 'available' && !allowPlanned) {
    throw new Error(`${path.title} is planned and cannot be initialized in Founding Beta.`);
  }

  if (path.availability !== 'available') {
    return {
      profile: null,
      requestedModuleIds: [],
      modules: [],
      localOnly: true,
      remoteEffects: 'none',
      notes: [
        'This is a read-only architecture preview. No runtime, local configuration, or Galaxy ID will be created.',
        `${path.title} is planned and cannot be initialized in Founding Beta.`,
      ],
      initializationPath: cloneInitializationPath(path),
      operation: 'future-path-preview',
      canInitialize: false,
    };
  }

  return {
    ...resolveModuleSelection({ modules: path.moduleIds }),
    capabilityProfile: 'l3-foundation',
    initializationPath: cloneInitializationPath(path),
    operation: 'first-run-or-path-change',
    canInitialize: true,
    ...localSelection,
  };
}
