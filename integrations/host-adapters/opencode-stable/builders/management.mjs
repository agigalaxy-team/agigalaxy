export function createBuildersManagement(session) {
  function notices(builderId, after = 0, back = session.home) {
    void session.run(
      () =>
        session.controller.queryBuilderNotices({ builderId, after, limit: 8 }),
      (page) => {
        const entries = page.items.map((row) => [
          `${row.revision} · ${session.plain(row.action)}`,
          () =>
            session.message(
              `${session.plain(row.summary, 2000)}\n${session.plain(row.eventId)}\n${session.plain(row.declarationId)}\n${session.label('这是维护沿革，不证明当前声明有效或端点可达。', 'Maintenance history; not evidence of current declaration validity or reachability.')}`,
              () => notices(builderId, after, back),
            ),
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批', 'Next results'),
            () => notices(builderId, page.nextAfter, back),
          ]);
        session.menu(
          session.label('可见维护公告', 'Visible maintenance notices'),
          entries,
          back,
        );
      },
      back,
    );
  }

  function management(builderId) {
    void session.run(
      () => session.controller.getBuilderManagement({ builderId }),
      (current) => {
        const back = () => management(builderId),
          entries = [
            [
              session.label('查看管理状态', 'Read management state'),
              () => session.message(JSON.stringify(current, null, 2), back),
            ],
            [
              session.label('查看维护公告', 'Read maintenance notices'),
              () => notices(builderId, 0, back),
            ],
          ];
        if (session.controller.prepareBuilder && session.has('consent')) {
          entries.push([
            session.label('重新发布准确声明', 'Publish a reviewed declaration'),
            () => session.publish(current.type, current),
          ]);
          const actions = [
            ['delist', session.label('从目录下架', 'Delist')],
            ['relist', session.label('恢复目录展示', 'Relist')],
            ['correction', session.label('发布纠正说明', 'Publish correction')],
            [
              'security-issue',
              session.label('发布安全公告', 'Publish security notice'),
            ],
            [
              'resolve-security',
              session.label('解决安全问题', 'Resolve security issue'),
            ],
          ];
          for (const [action, title] of actions) {
            if (
              !current.allowedActions.includes(action) ||
              (action === 'delist' && current.delisted) ||
              (action === 'relist' && !current.delisted) ||
              (action === 'security-issue' && current.securityIssue) ||
              (action === 'resolve-security' && !current.securityIssue)
            )
              continue;
            entries.push([
              title,
              () =>
                session.form(
                  title,
                  [
                    [
                      'summary',
                      session.label(
                        '本次公开或私有说明',
                        'Explanation for this notice',
                      ),
                      '',
                      2000,
                    ],
                  ],
                  (value) => {
                    const input = {
                      management: true,
                      kind: 'maintenance',
                      builderId,
                      baseDeclarationId: current.declarationId,
                      baseRevision: current.revision,
                      action,
                      summary: value.summary,
                    };
                    if (current.disclosure) session.confirm(input, back);
                    else session.disclosure(input, back);
                  },
                  back,
                ),
            ]);
          }
        }
        session.menu(
          `${session.label('管理我的登记', 'Manage my registration')} · ${session.plain(current.type)}\n${session.plain(current.declaration?.name ?? builderId)}\n${current.declarationState === 'readable' ? session.label('声明授权有效', 'Declaration authorization current') : session.label('旧声明不可读；可重新授权声明、下架或发布新说明', 'Prior declaration unavailable; review a new declaration or publish a control notice')}`,
          entries,
        );
      },
    );
  }

  function owned(after) {
    void session.run(
      () =>
        session.controller.queryOwnedBuilders({
          limit: 8,
          ...(after ? { after } : {}),
        }),
      (page) => {
        const entries = page.items.map((item) => [
          session.plain(item.name ?? item.builderId),
          () => management(item.builderId),
          `${session.plain(item.type)} · ${session.plain(item.declarationState)}`,
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批', 'Next results'),
            () => owned(page.nextAfter),
          ]);
        session.menu(
          session.label(
            '我的登记（含不可读声明）',
            'My registrations (including unavailable declarations)',
          ),
          entries,
        );
      },
    );
  }

  function operations() {
    void session.run(
      () => session.controller.listBuilderOperations(),
      (page) => {
        session.menu(
          session.label('本机建设者待办', 'Local Builder operations'),
          page.items.map((row) => [
            `${session.plain(row.kind)} · ${session.plain(row.action ?? row.eventId)}`,
            () => {
              const back = operations,
                entries = [
                  [
                    session.label('核对远端事件结果', 'Reconcile remote event'),
                    () =>
                      void session.run(
                        () => session.controller.reconcileBuilder(row.eventId),
                        (result) =>
                          session.message(
                            `${JSON.stringify(result, null, 2)}\n${session.label('回执只说明事件是否被接收，不代表当前公开或有效。', 'Receipt describes event acceptance, not current publication or validity.')}`,
                            back,
                          ),
                        back,
                      ),
                  ],
                  ...(row.status !== 'acknowledged'
                    ? [
                        [
                          session.label(
                            '预览原事件重试',
                            'Preview exact event retry',
                          ),
                          () =>
                            session.confirmPrepared(
                              () =>
                                session.controller.prepareBuilderRetry(
                                  row.eventId,
                                ),
                              back,
                            ),
                        ],
                      ]
                    : []),
                  ...(['prepared', 'acknowledged'].includes(row.status)
                    ? [
                        [
                          session.label(
                            '移除此本机记录',
                            'Remove this local record',
                          ),
                          () =>
                            void session.run(
                              () =>
                                session.controller.forgetBuilderOperation(
                                  row.eventId,
                                ),
                              () =>
                                session.message(
                                  session.label(
                                    '本机记录已移除；远端数据未删除。',
                                    'Local record removed; remote data was not deleted.',
                                  ),
                                  back,
                                ),
                              back,
                            ),
                        ],
                      ]
                    : []),
                ];
              session.menu(
                `${session.plain(row.eventId)}\n${session.plain(row.builderId)}\n${session.plain(row.status)}`,
                entries,
                back,
              );
            },
            session.plain(row.status),
          ]),
        );
      },
    );
  }
  return { notices, management, owned, operations };
}
