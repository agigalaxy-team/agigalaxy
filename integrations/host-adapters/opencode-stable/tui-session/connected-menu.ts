import type { Action } from '../adapter-types.ts';
import { createDeletionMenu } from '../deletion-menu.mjs';
import { createDataExportMenu } from '../data-export-menu.mjs';
import { createProfileMenu } from '../profile-menu.mjs';
import { createSearchMenu } from '../search-menu.mjs';
import { createBuilderMenu } from '../builder-menu.mjs';
import { createAuditMenu } from '../audit-menu.mjs';
import { createA2aMenu } from '../a2a-menu.mjs';
import { createAssistanceMenu } from '../assistance-menu.mjs';
import { createBindingManagementMenu } from '../binding-management-menu.mjs';
import { createIdentityMenu } from '../identity-menu.mjs';
import { describeConnectionState } from '../connection-state.mjs';
import type { GalaxyMenuSession } from './session-context.ts';

export function createConnectedMenu(session: GalaxyMenuSession) {
  async function showManagedConnection(onBack: Action) {
    const connectionController = session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const back = () => {
      session.connectionGeneration++;
      session.controllerMethod('cancel')();
      session.pendingConnection = null;
      onBack();
    };
    const reopen = () => void showManagedConnection(onBack);
    try {
      const status = await session.controllerMethod('status')();
      if (version !== session.connectionGeneration) return;
      const managesData = !!(
        connectionController.queryBindings ||
        connectionController.querySearchFeedback ||
        connectionController.listBindingReceipts ||
        (connectionController.queryHistory &&
          status.scopes?.includes('history')) ||
        (connectionController.readAudit && status.scopes?.includes('audit')) ||
        (connectionController.saveDataExport &&
          status.scopes?.includes('data-export')) ||
        (connectionController.readDeletion &&
          status.scopes?.includes('data-delete')) ||
        connectionController.prepareDeletionStatus
      );
      session.showSelect({
        title: `${chinese ? 'Galaxy / 连接与专业入口' : 'Galaxy / Connection and professional tools'}\n${describeConnectionState(status.state, session.activeLanguage)}\n${chinese ? '服务：' : 'Service: '}${status.endpoint}\n${session.discovery ? describeConnectionState(session.discovery.status().state, session.activeLanguage, 'discovery') : ''}\n${'receiptSaveState' in status && status.receiptSaveState === 'save-failed' ? (chinese ? '本机回执保存失败；请检查本机存储，不要重复绑定' : 'Local receipt save failed; check local storage, do not repeat binding') : ''}`,
        options: [
          {
            number: '1',
            title: chinese ? '预览连接' : 'Preview connection',
            description: chinese
              ? '先显示准确请求；确认前不联网或签名'
              : 'Review exact request before signing or network activity',
          },
          {
            number: '2',
            title: chinese ? '断开本机会话' : 'Disconnect local session',
            description: chinese
              ? '丢弃本机凭据；不声称已撤销远端绑定'
              : 'Discard local credential; does not revoke remote binding',
          },
          ...(connectionController.checkRemote || managesData
            ? [
                {
                  number: '3',
                  title: managesData
                    ? chinese
                      ? '设备与本人资料'
                      : 'Devices and my data'
                    : chinese
                      ? '核查远端绑定'
                      : 'Check remote binding',
                  description: chinese
                    ? '读取当前获准的原记录或处理本人资料。'
                    : 'Read currently authorized records or manage my data.',
                },
              ]
            : []),
          ...(((connectionController.querySearch &&
            ['history', 'proof', 'capsules', 'builders'].some((scope) =>
              status.scopes?.includes(scope),
            )) ||
            (connectionController.queryHistory &&
              status.scopes?.includes('history'))) &&
          status.state === 'session-local'
            ? [
                {
                  number: '4',
                  title: connectionController.querySearch
                    ? chinese
                      ? '分类型搜索'
                      : 'Search by source'
                    : chinese
                      ? '查询履历'
                      : 'Search history',
                  description: chinese
                    ? '向上方端点发送关键词，保留当前可见记录的来源类型'
                    : 'Send search terms and retain authorized source types',
                },
              ]
            : []),
          ...(connectionController.prepareCase &&
          session.readCaseSubmission &&
          status.scopes?.includes('case-teaser') &&
          status.state === 'session-local'
            ? [
                {
                  number: '5',
                  title: chinese ? '提交已授权草稿' : 'Submit authorized draft',
                  description: chinese
                    ? '预览宿主选中的 Case / 纠正记录；确认后提交'
                    : 'Preview the selected Case/review draft before submitting',
                },
              ]
            : []),
          ...(connectionController.listPublicationDrafts &&
          status.state === 'session-local' &&
          ['consent', 'case-teaser'].every((scope) =>
            status.scopes?.includes(scope),
          )
            ? [
                {
                  number: '6',
                  title: chinese ? '发布本地草稿' : 'Publish local draft',
                  description: chinese
                    ? '选择草稿和可见性，确认授权与内容后提交'
                    : 'Select a draft and visibility, then review Consent and content',
                },
              ]
            : []),
          ...(connectionController.queryBuilders &&
          status.state === 'session-local' &&
          status.scopes?.includes('builders')
            ? [
                {
                  number: '8',
                  title: chinese ? '建设者登记' : 'Builder registry',
                  description: chinese
                    ? '登记Worker、Bridge和Hub；查看兼容报告与维护状态'
                    : 'Register Worker, Bridge and Hub declarations; read reports and maintenance',
                },
              ]
            : []),
          ...(connectionController.queryAssistance &&
          status.state === 'session-local' &&
          status.scopes?.includes('assistance')
            ? [
                {
                  number: '7',
                  title: chinese ? '协作请求' : 'Collaboration',
                  description: chinese
                    ? '发现、申请和处理协作'
                    : 'Find, apply and manage requests',
                },
              ]
            : []),
          ...(connectionController.readA2a &&
          status.state === 'session-local' &&
          status.scopes?.includes('case-teaser')
            ? [
                {
                  number: '9',
                  title: chinese ? 'A2A 外部任务' : 'A2A external tasks',
                  description: chinese
                    ? '选择端点、发送内容与跟踪结果'
                    : 'Choose an endpoint, send selected text and track results',
                },
              ]
            : []),
        ],
        routes: {
          9: () => {
            if (
              version === session.connectionGeneration &&
              connectionController.readA2a
            ) {
              const current = ++session.connectionGeneration;
              createA2aMenu({
                controller: connectionController,
                select: session.showSelect,
                prompt: session.showPrompt,
                info: session.showInfo,
                language: session.activeLanguage,
                availableScopes: status.scopes,
                readWorkContext: session.readWorkContext,
                onReturnWork: session.closeGalaxy,
                onBack: reopen,
                isCurrent: () => current === session.connectionGeneration,
              }).open();
            }
          },
          8: () => {
            if (
              version === session.connectionGeneration &&
              connectionController.queryBuilders
            ) {
              const current = ++session.connectionGeneration;
              createBuilderMenu({
                controller: connectionController,
                select: session.showSelect,
                prompt: session.showPrompt,
                info: session.showInfo,
                language: session.activeLanguage,
                availableScopes: status.scopes,
                onReturnWork: session.closeGalaxy,
                onBack: reopen,
                isCurrent: () => current === session.connectionGeneration,
              }).open();
            }
          },
          1: () => void session.previewConnection(onBack),
          2: () => {
            session.controllerMethod('disconnect')();
            if (session.discovery) {
              session.clearConnectionController();
              session.showDiscovery(onBack);
            } else reopen();
          },
          3: () => {
            if (version !== session.connectionGeneration) return;
            if (!managesData) {
              if (connectionController.checkRemote)
                void session.checkRemoteBinding(onBack);
              return;
            }
            session.showSelect({
              title: chinese ? '设备与本人资料' : 'Devices and my data',
              options: [
                ...(connectionController.checkRemote
                  ? [
                      {
                        number: '1',
                        title: chinese
                          ? '核查远端绑定'
                          : 'Check remote binding',
                        description: '',
                      },
                    ]
                  : []),
                ...(connectionController.readIdentity &&
                status.state === 'session-local'
                  ? [
                      {
                        number: '9',
                        title: chinese ? '外部账户关联' : 'External accounts',
                        description: chinese
                          ? '关联或撤销OIDC账户'
                          : 'Link or unlink an OIDC account',
                      },
                    ]
                  : []),
                ...(connectionController.queryBindings &&
                status.state === 'session-local'
                  ? [
                      {
                        number: '8',
                        title: chinese
                          ? '本人设备与绑定'
                          : 'My installations and bindings',
                        description: chinese
                          ? '查看安装实例、当前绑定及撤销入口'
                          : 'View installations, current bindings and revocation',
                      },
                    ]
                  : []),
                ...(connectionController.readAudit &&
                status.scopes?.includes('audit')
                  ? [
                      {
                        number: '2',
                        title: chinese
                          ? '审计记录与授权'
                          : 'Audit records and approval',
                        description: '',
                      },
                    ]
                  : []),
                ...(connectionController.saveDataExport &&
                status.scopes?.includes('data-export')
                  ? [
                      {
                        number: '3',
                        title: chinese ? '导出本人资料' : 'Export my data',
                        description: '',
                      },
                    ]
                  : []),
                ...((connectionController.readDeletion &&
                  status.scopes?.includes('data-delete')) ||
                connectionController.prepareDeletionStatus
                  ? [
                      {
                        number: '4',
                        title: chinese
                          ? '数据删除申请'
                          : 'Data deletion requests',
                        description: '',
                      },
                    ]
                  : []),
                ...(connectionController.listBindingReceipts
                  ? [
                      {
                        number: '5',
                        title: chinese
                          ? '本机绑定回执'
                          : 'Local binding receipts',
                        description: chinese
                          ? '只读历史；不会恢复会话或联网'
                          : 'Read local history; no session restore or network',
                      },
                    ]
                  : []),
                ...(connectionController.queryHistory &&
                status.scopes?.includes('history') &&
                status.state === 'session-local'
                  ? [
                      {
                        number: '6',
                        title: chinese
                          ? '我的资料与自述'
                          : 'My Profile and self description',
                        description: chinese
                          ? '自述与事实履历分别展示'
                          : 'Self description and factual history shown separately',
                      },
                    ]
                  : []),
                ...(connectionController.querySearchFeedback
                  ? [
                      {
                        number: '7',
                        title: chinese
                          ? '本机反馈汇总'
                          : 'Local feedback summary',
                        description: chinese
                          ? '离线查看、修改或移除个人反馈'
                          : 'View, edit or remove personal feedback offline',
                      },
                    ]
                  : []),
              ],
              routes: {
                9: () => {
                  if (
                    version !== session.connectionGeneration ||
                    !connectionController.readIdentity
                  )
                    return;
                  const current = ++session.connectionGeneration;
                  createIdentityMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    isCurrent: () => current === session.connectionGeneration,
                    onBack: reopen,
                  }).open();
                },
                8: () => {
                  if (
                    version !== session.connectionGeneration ||
                    !connectionController.queryBindings
                  )
                    return;
                  const current = ++session.connectionGeneration;
                  createBindingManagementMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    isCurrent: () => current === session.connectionGeneration,
                    onBack: reopen,
                  }).open();
                },
                7: () => session.showLocalSearchFeedback(reopen),
                6: () => {
                  const current = ++session.connectionGeneration;
                  createProfileMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    onBack: reopen,
                    isCurrent: () => current === session.connectionGeneration,
                  }).open();
                },
                5: () => void session.showBindingReceipts(reopen),
                1: () => void session.checkRemoteBinding(onBack),
                2: () => {
                  const current = ++session.connectionGeneration;
                  createAuditMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    availableScopes: status.scopes,
                    onBack: reopen,
                    isCurrent: () => current === session.connectionGeneration,
                  }).open();
                },
                3: () => {
                  const current = ++session.connectionGeneration;
                  createDataExportMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    onBack: reopen,
                    isCurrent: () => current === session.connectionGeneration,
                  }).open();
                },
                4: () => {
                  const current = ++session.connectionGeneration;
                  createDeletionMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    canSubmit:
                      status.state === 'session-local' &&
                      status.scopes?.includes('data-delete'),
                    info: session.showInfo,
                    language: session.activeLanguage,
                    records: session.createDeletionRecords({
                      endpoint: status.endpoint,
                      isCurrent: () => current === session.connectionGeneration,
                    }),
                    onReturnWork: session.closeGalaxy,
                    onBack: reopen,
                    isCurrent: () => current === session.connectionGeneration,
                  }).open();
                },
              },
              onBack: reopen,
            });
          },
          4: () => {
            if (version !== session.connectionGeneration) return;
            if (connectionController.querySearch) {
              const current = ++session.connectionGeneration;
              createSearchMenu({
                controller: connectionController,
                select: session.showSelect,
                prompt: session.showPrompt,
                info: session.showInfo,
                language: session.activeLanguage,
                isCurrent: () => current === session.connectionGeneration,
                onReturnWork: session.closeGalaxy,
                readWorkContext: session.readWorkContext,
                onBack: reopen,
                onHistoryFilters: () => session.promptHistory(onBack),
                availableScopes: status.scopes,
              }).open();
            } else if (connectionController.queryHistory)
              void session.promptHistory(onBack);
          },
          5: () => {
            if (
              version === session.connectionGeneration &&
              connectionController.prepareCase &&
              session.readCaseSubmission
            )
              void session.previewCaseSubmission(onBack);
          },
          6: () => {
            if (
              version === session.connectionGeneration &&
              connectionController.listPublicationDrafts
            )
              void session.showPublicationDrafts(onBack);
          },
          7: () => {
            if (
              version === session.connectionGeneration &&
              connectionController.queryAssistance
            ) {
              const current = ++session.connectionGeneration;
              createAssistanceMenu({
                controller: connectionController,
                select: session.showSelect,
                prompt: session.showPrompt,
                info: session.showInfo,
                language: session.activeLanguage,
                availableScopes: status.scopes,
                readWorkContext: session.readWorkContext,
                onBack: reopen,
                isCurrent: () => current === session.connectionGeneration,
              }).open();
            }
          },
        },
        onBack: back,
      });
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese ? '连接状态不可用。' : 'Connection status unavailable.',
          onBack,
        );
    }
  }
  return { showManagedConnection };
}
