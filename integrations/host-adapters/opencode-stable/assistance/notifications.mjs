import { createCapsuleMenu } from '../capsule-menu.mjs';

export function createAssistanceNotificationsMenu(session) {
  function notifications(after) {
    void session.run(
      () =>
        session.controller.queryNotifications({
          limit: 8,
          ...(after ? { after } : {}),
        }),
      (page) => {
        const entries = page.items.map((item) => [
          session.plain(item.title),
          () => {
            session.message(
              `${session.plain(item.eventKind)}\n${session.plain(item.actorId)}\n${session.plain(item.summary)}\n${session.plain(item.at)}`,
              () => {
                void session.run(
                  () => session.controller.markNotificationRead(item.id),
                  () =>
                    item.incidentId
                      ? notifications()
                      : item.capsuleId
                        ? createCapsuleMenu({
                            controller: session.controller,
                            select: session.select,
                            prompt: session.prompt,
                            info: session.info,
                            language: session.language,
                            isCurrent: session.isCurrent,
                            onBack: () => notifications(),
                            availableScopes: session.availableScopes,
                            readWorkContext: session.readWorkContext,
                          }).openCapsule(item.capsuleId, item.versionId)
                        : session.detail(item.assistanceId, () =>
                            notifications(),
                          ),
                  () => notifications(),
                );
              },
            );
          },
          `${item.read ? session.label('已读', 'Read') : session.label('未读', 'Unread')} · ${session.plain(item.category)}`,
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批通知', 'Next notifications'),
            () => notifications(page.nextAfter),
          ]);
        session.menu(
          session.label('站内通知', 'Inbox') +
            (page.enabled ? '' : session.label('（已关闭）', ' (disabled)')),
          entries,
        );
      },
    );
  }

  function notificationPreferences() {
    void session.run(
      () => session.controller.notificationPreferences(),
      (saved) => {
        const settings = structuredClone(saved.settings);
        const render = () =>
          session.menu(session.label('通知偏好', 'Notification preferences'), [
            ...[
              ['enabled', session.label('站内通知总开关', 'Inbox enabled')],
              ['invitations', session.label('邀请', 'Invitations')],
              [
                'collaboration',
                session.label('协作事件', 'Collaboration events'),
              ],
              ['materials', session.label('材料授权', 'Material grants')],
              ['capsules', session.label('Capsule更新', 'Capsule updates')],
              ['incidents', session.label('事故通知', 'Incident updates')],
            ].map(([key, title]) => [
              title,
              () => {
                settings[key] = !settings[key];
                render();
              },
              settings[key]
                ? session.label('开启', 'On')
                : session.label('关闭', 'Off'),
            ]),
            [
              session.label('静音指定协作', 'Mute collaborations'),
              () =>
                session.form(
                  'Galaxy',
                  [
                    [
                      'ids',
                      session.label(
                        '协作ID，逗号分隔；留空清空',
                        'Assistance IDs, comma separated; empty clears',
                      ),
                      settings.mutedAssistanceIds.join(','),
                    ],
                  ],
                  (value) => {
                    settings.mutedAssistanceIds = value.ids
                      .split(/[,，]/)
                      .map((s) => s.trim())
                      .filter(Boolean);
                    render();
                  },
                  render,
                ),
            ],
            [
              session.label('保存偏好', 'Save preferences'),
              () =>
                void session.run(
                  () =>
                    session.controller.saveNotificationPreferences({
                      expectedRevision: saved.revision,
                      settings,
                    }),
                  () =>
                    session.message(
                      session.label('已保存通知偏好。', 'Preferences saved.'),
                    ),
                ),
            ],
            ...(saved.archiveSupported &&
            session.controller.archiveNotifications
              ? [
                  [
                    session.label(
                      '归档较早通知',
                      'Archive older notifications',
                    ),
                    () =>
                      session.form(
                        'Galaxy',
                        [
                          [
                            'days',
                            session.label(
                              '归档多少天前的通知（1–3650）',
                              'Archive notifications older than this many days (1–3650)',
                            ),
                            '30',
                          ],
                        ],
                        (value) => {
                          const days = Number(value.days);
                          if (
                            !Number.isInteger(days) ||
                            days < 1 ||
                            days > 3650
                          ) {
                            session.message(
                              session.label(
                                '请输入1–3650天。',
                                'Enter 1–3650 days.',
                              ),
                              render,
                            );
                            return;
                          }
                          const before =
                            Math.floor(Date.now() / 1000) - days * 86400;
                          session.menu(
                            `${session.label('归档时间界限', 'Archive cutoff')}: ${new Date(before * 1000).toISOString()}\n${session.label('此前通知将从收件箱移除，较早的已读标记会被清理。原协作、材料与事件仍保留；此界限不能回退。', 'Older notifications leave the inbox and older read markers are cleared. Source collaboration, materials and events remain; the cutoff cannot move backwards.')}`,
                            [
                              [
                                session.label('确认归档', 'Confirm archive'),
                                () =>
                                  void session.run(
                                    () =>
                                      session.controller.archiveNotifications({
                                        expectedRevision: saved.revision,
                                        before,
                                      }),
                                    (result) =>
                                      session.message(
                                        `${session.label('归档完成；清理已读标记', 'Archived; read markers cleared')}: ${result.removedReadMarkers}`,
                                        notificationPreferences,
                                      ),
                                    notificationPreferences,
                                  ),
                              ],
                            ],
                            render,
                          );
                        },
                        render,
                      ),
                    saved.archivedBefore ??
                      session.label('尚未归档', 'No archive cutoff'),
                  ],
                ]
              : []),
          ]);
        render();
      },
    );
  }
  return { notifications, notificationPreferences };
}
