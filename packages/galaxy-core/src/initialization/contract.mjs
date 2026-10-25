import {listUploadPrivacyLevels,normalizeUploadPrivacy} from '../upload-privacy.mjs';
import {listGalaxyInitializationPaths} from './catalog.mjs';
import {getGalaxyLanguageSelection,resolveGalaxyLanguage,localizedCopy,localizedInitializationPath} from './language.mjs';

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
