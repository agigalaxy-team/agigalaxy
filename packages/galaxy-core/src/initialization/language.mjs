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

export {resolveGalaxyLanguage,localizedCopy,localizedInitializationPath};
