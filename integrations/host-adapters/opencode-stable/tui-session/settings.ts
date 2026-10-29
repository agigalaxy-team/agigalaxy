import type { Action } from '../adapter-types.ts';
import { createPurposeMenu } from '../purpose-menu.mjs';
import type { GalaxyMenuSession } from './session-context.ts';
import { divider, localBoundary, formatModules } from './presentation.ts';

export function createSettingsPages(session: GalaxyMenuSession) {
  async function showSettingsModules(onReturn: Action) {
    const status = await session.store.getGalaxyIntegrationStatus(
      session.dataDirectory,
    );
    const modules = status.integration?.modules ?? [];
    session.showInfo(
      'Galaxy / 模块与集成',
      `当前已启用的本机模块：\n${formatModules(modules, status.catalog?.modules, session.activeLanguage) || '• 尚未启用模块'}\n\n${localBoundary(session.activeLanguage)}\n\n${divider()}\nFounding Beta 不允许从设置页重新执行首次初始化，也不提供远程模块安装。`,
      onReturn,
    );
  }

  function showSettingsLanguage(onReturn: Action) {
    session.showSelect({
      title:
        'Galaxy / 显示语言\n这只影响当前 OpenCode 对话，不会修改 Galaxy ID、本机配置或初始化记录。',
      options: [
        {
          number: '1',
          title: '简体中文',
          description: '以中文显示此会话中的 Galaxy 页面。',
        },
        {
          number: '2',
          title: 'English',
          description: 'Show Galaxy pages in English for this conversation.',
        },
      ],
      routes: {
        1: () => {
          session.activeLanguage = 'zh-CN';
          session.showInfo(
            'Galaxy / 显示语言',
            '已切换为简体中文。\n\n这不会修改本机 Galaxy、身份或初始化记录。\n\n按 Enter 返回 Galaxy 控制台。',
            onReturn,
          );
        },
        2: () => {
          session.activeLanguage = 'en-US';
          session.showInfo(
            'Galaxy / Display language',
            'English is now used for this OpenCode conversation.\n\nThis does not change your local Galaxy, identity, or initialization record.\n\nPress Enter to return to the Galaxy console.',
            onReturn,
          );
        },
        0: onReturn,
      },
      onBack: onReturn,
    });
  }

  async function showReinitializeGalaxy(onReturn: Action) {
    const status = await session.store.getGalaxyIntegrationStatus(
      session.dataDirectory,
    );
    const count = (name: keyof NonNullable<typeof status.recordCounts>) =>
      status.recordCounts?.[name] ?? 0;
    const chinese = session.activeLanguage === 'zh-CN';
    const identity =
      status.galaxyId?.id ?? (chinese ? '尚未创建' : 'Not created');
    session.showSelect({
      title: chinese
        ? `Galaxy / 重新初始化\n\n这是一项不可恢复的本机清理操作。确认后将清除：\n• Galaxy ID：${identity}\n• 私钥与公钥\n• ${count('cases')} 个本地 Case、${count('disclosurePlans')} 个披露计划、${count('consentGrants')} 个授权记录、${count('localProofDrafts')} 个 Local Proof Draft\n• 初始化状态与本机审计记录\n\n不会删除 .galaxy 目录中不属于 Galaxy 托管文件的内容。清除后自动回到首次语言选择。`
        : `Galaxy / Reinitialize\n\nThis is an irreversible local cleanup. Confirming removes:\n• Galaxy ID: ${identity}\n• Private and public keys\n• ${count('cases')} local Cases, ${count('disclosurePlans')} disclosure plans, ${count('consentGrants')} consent grants, and ${count('localProofDrafts')} Local Proof Drafts\n• Initialization state and local audit history\n\nUnknown files inside .galaxy are not deleted. After cleanup, Galaxy returns to first-time language selection.`,
      options: [
        {
          number: '1',
          title: chinese
            ? '确认清除本机 Galaxy 并重新初始化'
            : 'Confirm local Galaxy cleanup and reinitialize',
          description: chinese
            ? '永久清除上述 Galaxy 托管数据；随后立即进入首次初始化。'
            : 'Permanently remove the Galaxy-managed data above, then enter first-time setup.',
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
            await session.store.resetGalaxyIntegration(session.dataDirectory);
            void session.showQuickInitialize(onReturn);
          } catch (error) {
            session.showInfo(
              chinese
                ? '重新初始化未完成'
                : 'Reinitialization did not complete',
              String(error instanceof Error ? error.message : error),
              onReturn,
            );
          }
        },
        0: onReturn,
      },
      onBack: onReturn,
    });
  }

  function showSettings(onReturn: Action): void {
    const chinese = session.activeLanguage === 'zh-CN';
    if (session.nativeTools) {
      const nativeEntry =
        (kind: 'identity' | 'methods' | 'external' | 'projects'): Action =>
        async () => {
          const version = ++session.connectionGeneration;
          session.purposeMenu?.close();
          session.purposeMenu = createPurposeMenu({
            nativeTools: session.nativeTools,
            controller: session.connectionController,
            select: session.showSelect,
            prompt: session.showPrompt,
            info: session.showInfo,
            language: session.activeLanguage,
            isCurrent: () =>
              !session.closed && version === session.connectionGeneration,
            onBack: () => showSettings(onReturn),
            onReturnWork: session.returnToWork,
            readWorkContext: session.currentWorkContext,
          });
          session.purposeMenu[kind]();
        };
      return session.showSelect({
        title: chinese ? 'Galaxy / 我的与设置' : 'Galaxy / My settings',
        options: [
          {
            number: '1',
            title: chinese ? '身份与设备' : 'Identity and devices',
            description: chinese
              ? '当前身份、设备与账户关联。'
              : 'Current identity, devices and account links.',
          },
          {
            number: '2',
            title: chinese ? '方法' : 'Methods',
            description: chinese
              ? '沿用实际工作整理、应用与验证方法。'
              : 'Prepare, apply and reverify methods from actual work.',
          },
          {
            number: '4',
            title: chinese ? '交给已有服务处理' : 'Use an existing service',
            description: chinese
              ? '选择现有工作与必要内容，接续已配置 A2A 服务。'
              : 'Select current work and necessary content for a configured A2A service.',
          },
          {
            number: '5',
            title: chinese ? '同行与联系' : 'People and contacts',
            description: chinese
              ? '从当前方向读项目、发起联系，接续对话。'
              : 'Read projects, contact people, and continue the conversation.',
          },
          {
            number: '3',
            title: chinese ? '显示语言' : 'Display language',
            description: chinese
              ? '更改这个 OpenCode 入口的显示语言。'
              : 'Change the language of this OpenCode entry.',
          },
        ],
        routes: {
          1: nativeEntry('identity'),
          2: nativeEntry('methods'),
          4: nativeEntry('external'),
          5: nativeEntry('projects'),
          3: () => showSettingsLanguage(() => showSettings(onReturn)),
        },
        onBack: onReturn,
      });
    }
    session.showSelect({
      title: chinese ? 'Galaxy / 我的与设置' : 'Galaxy / My settings',
      options: [
        {
          number: '6',
          title: chinese ? '连接与设备' : 'Connection and devices',
          description: chinese
            ? '按需要接入已有身份，查看当前连接。'
            : 'Connect an existing identity when needed and inspect this connection.',
        },
        {
          number: '5',
          title: chinese ? '创建本机身份' : 'Create local identity',
          description: chinese
            ? '仅在这台设备尚未准备身份时使用。'
            : 'Use only when this device has no local identity yet.',
        },
        {
          number: '1',
          title: chinese ? '本机身份与运行边界' : 'Local identity and boundary',
          description: chinese
            ? '查看本机身份卡及服务边界。'
            : 'Review the local identity card and service boundary.',
        },
        {
          number: '2',
          title: chinese ? '模块与集成' : 'Modules and integrations',
          description: chinese
            ? '查看已启用的本机模块，不安装或变更。'
            : 'Review enabled local modules; no installation or change.',
        },
        {
          number: '3',
          title: chinese ? '显示语言' : 'Display language',
          description: chinese
            ? '仅更改当前 OpenCode 对话语言。'
            : 'Change language only for this OpenCode conversation.',
        },
        {
          number: '4',
          title: chinese ? '重新初始化 Galaxy' : 'Reinitialize Galaxy',
          description: chinese
            ? '清除 Galaxy 托管数据与当前 ID，然后从首次初始化开始。'
            : 'Clear Galaxy-managed data and the current ID, then restart first-time setup.',
        },
      ],
      routes: {
        6: () => session.showConnection(onReturn),
        5: () => session.showQuickInitialize(onReturn),
        1: () => session.showStatus(onReturn),
        2: () => showSettingsModules(onReturn),
        3: () => showSettingsLanguage(onReturn),
        4: () => showReinitializeGalaxy(onReturn),
        0: onReturn,
      },
      onBack: onReturn,
    });
  }

  return {
    showSettingsModules,
    showSettingsLanguage,
    showReinitializeGalaxy,
    showSettings,
  };
}
