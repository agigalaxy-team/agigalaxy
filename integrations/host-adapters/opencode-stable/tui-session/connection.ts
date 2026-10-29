import type {
  Action,
  Routes,
  MenuOption,
  BindingReceiptView,
} from '../adapter-types.ts';
import { createSearchFeedbackMenu } from '../search-feedback-menu.mjs';
import { createAssistanceDraftMenu } from '../assistance-draft-menu.mjs';
import { createContextDraftMenu } from '../context-draft-menu.mjs';
import { describeConnectionState } from '../connection-state.mjs';
import type { GalaxyMenuSession } from './session-context.ts';
import { divider, localBoundary, formatModules } from './presentation.ts';
import { createPurposeMenu } from '../purpose-menu.mjs';
import { unwrap, plain } from '../purpose/presentation.mjs';
import { nativeConnectionMessage } from '../../../native-v2/presentation/native-result.mjs';

export function createConnectionPages(session: GalaxyMenuSession) {
  async function showStatus(onBack: Action) {
    if (session.nativeTools) {
      const generation = session.pageGeneration;
      try {
        const status = unwrap(await session.nativeTools.call('galaxy_native_status', {}));
        if (session.closed || generation !== session.pageGeneration) return;
        session.showInfo(
          session.activeLanguage === 'zh-CN' ? 'Galaxy / 本机状态' : 'Galaxy / Local status',
          [nativeConnectionMessage(status, session.activeLanguage),
            ...(status.identity ? [plain(status.identity)] : []),
            ...(status.endpoint ? [plain(status.endpoint)] : [])].join('\n\n'),
          onBack,
        );
      } catch {
        if (!session.closed && generation === session.pageGeneration)
          session.showInfo('Galaxy', session.activeLanguage === 'zh-CN' ? '当前本机状态暂不可读，已有资料保留。' : 'Local status is currently unavailable. Existing material is retained.', onBack);
      }
      return;
    }
    const status = await session.store.getGalaxyIntegrationStatus(
      session.dataDirectory,
    );
    const id = status.galaxyId?.id ?? '尚未创建';
    const modules = status.integration?.modules ?? [];
    session.showInfo(
      'Galaxy / 本机状态',
      `Galaxy ID：${id}\n\n${localBoundary(session.activeLanguage)}\n\n${divider()}\n当前本机能力\n${formatModules(modules, status.catalog?.modules, session.activeLanguage) || '• 尚未启用模块'}\n\n状态查询只读；按 Enter 返回控制台。`,
      onBack,
    );
  }

  async function showConnection(onBack: Action) {
    if (session.nativeTools) {
      const generation = ++session.connectionGeneration;
      session.purposeMenu?.close();
      session.purposeMenu = createPurposeMenu({
        nativeTools: session.nativeTools,
        controller: session.connectionController,
        select: session.showSelect,
        prompt: session.showPrompt,
        info: session.showInfo,
        language: session.activeLanguage,
        isCurrent: () => !session.closed && generation === session.connectionGeneration,
        onBack,
        onReturnWork: session.returnToWork,
        readWorkContext: session.currentWorkContext,
      });
      session.purposeMenu.identity();
      return;
    }
    if (session.connectionController)
      return session.showManagedConnection(onBack);
    if (session.discovery) return showDiscovery(onBack);
    const chinese = session.activeLanguage === 'zh-CN';
    try {
      const contract = await session.connection.getGalaxyConnectionStatus(
        session.dataDirectory,
      );
      const targetLines = contract.targets.map(
        (target: { kind: string; endpoint: string }) =>
          `${target.kind}: ${target.endpoint}\n  ${chinese ? '已配置，未验证、未连接' : 'Configured, unverified, disconnected'}`,
      );
      const scopeLines = contract.scopes.map(
        (scope: {
          action: string;
          state: string;
          recipient: string;
          purpose: string;
          visibleFields: string[];
          expiresAt: string;
        }) =>
          `${scope.action}: ${scope.state}\n  ${scope.recipient} · ${scope.purpose}\n  ${scope.visibleFields.join(', ')}\n  ${scope.expiresAt}\n  ${chinese ? '不具备外发权限' : 'No transfer permission'}`,
      );
      session.showInfo(
        chinese ? 'Galaxy / 接入银河' : 'Galaxy / Connect to Galaxy',
        [
          chinese ? '连接状态：未连接' : 'Connection: not connected',
          contract.appliedCapabilityProfile === 'l3-foundation'
            ? chinese
              ? 'L3 本地能力包已确认'
              : 'L3 local package confirmed'
            : chinese
              ? 'L3 尚未应用；保留现有本地配置'
              : 'L3 not applied; existing local configuration retained',
          '',
          chinese
            ? 'Official：默认公共信息入口，尚未读取 Manifest。\nHub：可选自治端点；本页仅查看配置。'
            : 'Official: default public entry; Manifest not fetched.\nHub: optional autonomous endpoints; this page is read-only.',
          ...targetLines,
          ...(targetLines.length
            ? []
            : [
                chinese
                  ? '尚未配置远程端点。'
                  : 'No remote endpoints configured.',
              ]),
          '',
          ...scopeLines,
          ...(scopeLines.length
            ? []
            : [chinese ? '没有 Scope 授权。' : 'No Scope grants.']),
          '',
          chinese
            ? '不读取远程信息、不签名、不绑定、不传输。\n按 Enter 返回控制台；Esc 退出。'
            : 'No remote reads, signing, binding or transfer.\nEnter returns to console; Esc exits.',
        ].join('\n'),
        onBack,
      );
    } catch (error) {
      session.showInfo(
        chinese ? '连接配置无法读取' : 'Connection configuration unavailable',
        String(error instanceof Error ? error.message : error),
        onBack,
      );
    }
  }

  function showLocalSearchFeedback(onBack: Action) {
    const source = session.discovery ?? session.connectionController;
    if (!source?.querySearchFeedback || !source.editSearchFeedback) return;
    const current = ++session.connectionGeneration;
    void createSearchFeedbackMenu({
      controller: source,
      select: session.showSelect,
      info: session.showInfo,
      language: session.activeLanguage,
      isCurrent: () => current === session.connectionGeneration,
      onBack,
    }).open();
  }

  function showDiscovery(onBack: Action) {
    if (!session.discovery) return;
    const source = session.discovery;
    const chinese = session.activeLanguage === 'zh-CN';
    const version = ++session.connectionGeneration;
    const back = () => {
      session.connectionGeneration++;
      session.discoveryAbort?.abort();
      onBack();
    };
    session.showSelect({
      title: `${chinese ? 'Galaxy / 服务信息' : 'Galaxy / Service information'}\n${source.endpoint}\n${source.scopes.join(', ')}\n${describeConnectionState(source.status().state, session.activeLanguage, 'discovery')}`,
      options: [
        {
          number: '1',
          title: chinese ? '读取服务信息' : 'Read service information',
          description: chinese
            ? '匿名读取 Manifest；连接另行预览确认'
            : 'Read Manifest anonymously; connection requires a separate preview',
        },
        {
          number: '2',
          title: chinese ? '本机绑定回执' : 'Local binding receipts',
          description: chinese
            ? '离线查看，不读取远端信息'
            : 'Read offline; no remote request',
        },
        {
          number: '3',
          title: chinese ? '本机反馈汇总' : 'Local feedback summary',
          description: chinese
            ? '离线查看、修改或移除个人反馈'
            : 'View, edit or remove personal feedback offline',
        },
        {
          number: '4',
          title: chinese ? '本地协作草稿' : 'Local collaboration drafts',
          description: chinese
            ? '离线续填与查看提交记录'
            : 'Edit offline and inspect local submission records',
        },
        {
          number: '5',
          title: chinese ? '本地材料草稿' : 'Local material drafts',
          description: chinese
            ? '离线编辑选定材料，不重新开放授权'
            : 'Edit selected materials offline without reopening access',
        },
      ],
      routes: {
        5: () => {
          if (version !== session.connectionGeneration) return;
          const current = ++session.connectionGeneration;
          createContextDraftMenu({
            controller: source,
            select: session.showSelect,
            prompt: session.showPrompt,
            info: session.showInfo,
            language: session.activeLanguage,
            canSubmit: false,
            isCurrent: () => current === session.connectionGeneration,
            onBack: () => showDiscovery(onBack),
            onConfirm: undefined,
            onOpenGrant: undefined,
          }).open();
        },
        4: () => {
          if (version !== session.connectionGeneration) return;
          const current = ++session.connectionGeneration;
          createAssistanceDraftMenu({
            controller: source,
            select: session.showSelect,
            prompt: session.showPrompt,
            info: session.showInfo,
            language: session.activeLanguage,
            readWorkContext: session.readWorkContext,
            canSubmit: false,
            isCurrent: () => current === session.connectionGeneration,
            onBack: () => showDiscovery(onBack),
            onConfirm: undefined,
            onOpenRequest: undefined,
          }).open();
        },
        3: () => {
          if (version === session.connectionGeneration)
            showLocalSearchFeedback(() => showDiscovery(onBack));
        },
        2: () => void showBindingReceipts(() => showDiscovery(onBack)),
        1: async () => {
          if (version !== session.connectionGeneration) return;
          const current = ++session.connectionGeneration;
          session.discoveryAbort?.abort();
          const abort = new AbortController();
          session.discoveryAbort = abort;
          session.showSelect({
            title: chinese
              ? '正在读取服务信息…'
              : 'Reading service information…',
            options: [],
            routes: {},
            onBack: back,
          });
          try {
            const result = await source.read(abort.signal);
            if (
              abort.signal.aborted ||
              current !== session.connectionGeneration
            )
              return;
            session.connectionController = result.controller;
            const clean = (text: string) =>
              text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ');
            session.showInfo(
              chinese ? '服务信息已验证' : 'Service information verified',
              `${result.networkType === 'hub' ? 'Hub' : 'Official'}\n${clean(result.displayName)}\n${clean(result.operator)}\n${source.endpoint}\n${new Date(result.checkedAt * 1000).toISOString()}\n${chinese ? '信息签名有效；尚未连接或授权' : 'Valid signature; not connected or authorized'}`,
              () => {
                if (current === session.connectionGeneration)
                  void session.showManagedConnection(onBack);
              },
            );
          } catch {
            if (
              !abort.signal.aborted &&
              current === session.connectionGeneration
            )
              session.showInfo(
                chinese
                  ? '服务信息读取失败'
                  : 'Service information unavailable',
                describeConnectionState(
                  source.status().state,
                  session.activeLanguage,
                  'discovery',
                ),
                () => {
                  if (current === session.connectionGeneration)
                    showDiscovery(onBack);
                },
              );
          } finally {
            if (session.discoveryAbort === abort) session.discoveryAbort = null;
          }
        },
      },
      onBack: back,
    });
  }

  async function showBindingReceipts(onBack: Action, offset = 0) {
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    try {
      const read =
        session.connectionController?.listBindingReceipts ??
        session.discovery?.listBindingReceipts;
      if (!read) throw new Error('Local receipt reader unavailable.');
      const result = await read();
      if (version !== session.connectionGeneration) return;
      const routes: Routes = {},
        reopen = () => void showBindingReceipts(onBack, offset);
      const options: MenuOption[] = result.records
        .slice(offset, offset + 8)
        .map((record: BindingReceiptView, index: number) => {
          const number = String(index + 1);
          routes[number] = () =>
            session.showInfo(
              chinese ? '本机绑定回执' : 'Local binding receipt',
              [
                record.endpoint,
                record.bindingId,
                record.subjectId,
                record.installationId,
                record.scopes.join(', '),
                `${chinese ? '本机记录时间' : 'Local recorded time'}: ${new Date(record.receivedAt * 1000).toISOString()}`,
                `${chinese ? '回执到期时间' : 'Receipt expiry'}: ${new Date(record.bindingExpiresAt * 1000).toISOString()}`,
                record.verification === 'unverified'
                  ? chinese
                    ? '签名未通过当前信任配置核验'
                    : 'Signature unverified with current trust configuration'
                  : chinese
                    ? '签名在所记录时间有效'
                    : 'Signature valid at recorded time',
                record.lifetime === 'expired'
                  ? chinese
                    ? '回执已过期'
                    : 'Receipt expired'
                  : chinese
                    ? '未超过回执声明期限'
                    : 'Within receipt stated lifetime',
                record.configurationMatches
                  ? chinese
                    ? '安装实例与请求范围匹配当前配置'
                    : 'Installation and requested scopes match configuration'
                  : chinese
                    ? '历史配置与当前不同'
                    : 'Historical configuration differs',
                chinese
                  ? '仅本机历史；远端状态未核查，不提供访问权限。'
                  : 'Local history only; remote state not checked; grants no access.',
              ].join('\n'),
              reopen,
            );
          return {
            number,
            title: record.bindingId,
            description: new Date(record.receivedAt * 1000).toISOString(),
          };
        });
      if (offset + 8 < result.records.length) {
        options.push({ number: '9', title: chinese ? '下一页' : 'Next page' });
        routes[9] = () => void showBindingReceipts(onBack, offset + 8);
      }
      session.showSelect({
        title: `${chinese ? '本机绑定回执' : 'Local binding receipts'}\n${result.records.length}\n${chinese ? '历史记录不代表当前绑定或会话有效' : 'History does not establish current binding or session validity'}`,
        options,
        routes,
        onBack: offset
          ? () => void showBindingReceipts(onBack, Math.max(0, offset - 8))
          : onBack,
      });
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese
            ? '本机回执无法读取，请检查身份和存储。'
            : 'Local receipts unavailable; check identity and storage.',
          onBack,
        );
    }
  }

  async function checkRemoteBinding(onBack: Action) {
    session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const reopen = () => void session.showManagedConnection(onBack);
    session.showInfo(
      'Galaxy',
      chinese
        ? '正在核查远端绑定；Esc取消。'
        : 'Checking remote binding; Esc cancels.',
      () => {
        session.controllerMethod('cancel')();
        reopen();
      },
    );
    try {
      const result = await session.controllerMethod('checkRemote')();
      if (version !== session.connectionGeneration) return;
      session.showInfo(
        'Galaxy',
        `${result.endpoint}\n${result.state}\n${chinese ? '仅代表本次查询，不代表持续在线或业务授权。' : 'This check does not establish continuing connectivity or business authorization.'}`,
        reopen,
      );
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese
            ? '核查未完成，不会自动重试。'
            : 'Check incomplete; no automatic retry.',
          reopen,
        );
    }
  }

  async function previewConnection(onBack: Action) {
    session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    try {
      const preview = await session.controllerMethod('prepare')();
      if (version !== session.connectionGeneration) {
        session.controllerMethod('cancel')();
        return;
      }
      session.pendingConnection = preview;
      const cancel = () => {
        if (version !== session.connectionGeneration) return;
        session.controllerMethod('cancel')();
        session.pendingConnection = null;
        void session.showManagedConnection(onBack);
      };
      let started = false;
      const prompt = () => {
        if (
          version !== session.connectionGeneration ||
          session.pendingConnection !== preview
        )
          return;
        let request: { scopes?: string[] } = {};
        try {
          request = JSON.parse(preview.requestJson);
        } catch {
          /* The exact original still stays in its preview. */
        }
        const scopes: Record<string, string> = {
          binding: '设备连接',
          consent: '所选内容授权',
          history: '可见履历',
          assistance: '求助与参与',
          context: '所选材料',
          notifications: '消息通知',
          capsules: '知识胶囊',
          builders: '开放节点信息',
          'case-teaser': '当前工作记录',
          proof: '来源证据',
          evidence: '提交的材料',
          moderation: '已获准的处理记录',
          audit: '本人操作记录',
          'audit-review': '本人授权记录',
          'data-export': '本人资料导出',
          'data-delete': '本人资料删除',
        };
        session.showSelect({
          title: `${chinese ? '连接到银河' : 'Connect to Galaxy'}\n${preview.endpoint}\n${chinese ? '本次选择的权限' : 'Selected permissions'}：${request.scopes?.map((scope) => (chinese ? (scopes[scope] ?? scope) : scope)).join('、') ?? (chinese ? '宿主已选择的设备连接' : 'The device connection selected by the host')}\n${chinese ? '私人笔记与原工作全文不会由这次连接上传。' : 'This connection does not upload private notes or the original work in full.'}`,
          options: [
            {
              number: '1',
              title: chinese ? '允许这次连接' : 'Allow this connection',
            },
            {
              number: '2',
              title: chinese ? '查看连接来源' : 'Inspect connection source',
              description: chinese
                ? '需要诊断时查看准确请求。'
                : 'Inspect the exact request when diagnosing.',
            },
          ],
          onBack: cancel,
          routes: {
            2: () =>
              session.showInfo(
                chinese
                  ? '连接来源与诊断'
                  : 'Connection source and diagnostics',
                preview.requestJson,
                prompt,
              ),
            1: async () => {
              if (
                version !== session.connectionGeneration ||
                session.pendingConnection !== preview ||
                started
              )
                return;
              started = true;
              session.showInfo(
                'Galaxy',
                chinese
                  ? '正在连接；Esc可取消，已送达请求不保证撤回。'
                  : 'Connecting; Esc cancels locally but cannot undo delivered requests.',
                cancel,
              );
              try {
                // This action comes from the actual native selection. The exact
                // host preview remains the same object and checks its own expiry.
                await session.controllerMethod('execute')(
                  preview,
                  preview.confirmation,
                );
                if (version !== session.connectionGeneration) return;
                session.pendingConnection = null;
                void session.showManagedConnection(onBack);
              } catch {
                if (version !== session.connectionGeneration) return;
                session.pendingConnection = null;
                session.showInfo(
                  'Galaxy',
                  chinese
                    ? '连接未完成；远端结果可能需复核，不会自动重试。'
                    : 'Connection incomplete; remote outcome may need review. No automatic retry.',
                  () => void session.showManagedConnection(onBack),
                );
              }
            },
          },
        });
      };
      prompt();
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese
            ? '无法准备连接；没有发送。'
            : 'Cannot prepare connection; nothing sent.',
          onBack,
        );
    }
  }

  return {
    showStatus,
    showConnection,
    showLocalSearchFeedback,
    showDiscovery,
    showBindingReceipts,
    checkRemoteBinding,
    previewConnection,
  };
}
