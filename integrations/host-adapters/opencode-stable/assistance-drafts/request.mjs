import { showExactChoice } from '../exact-choice.mjs';
import { assistanceDraftApproaches } from "../../../../packages/galaxy-official/src/clients/local/assistance-store.mjs";

export function createAssistanceDraftsRequest(session) {
  function requestSettings(row) {
    const c = row.content,
      back = () => session.render(row);
    session.menu(
      session.label('求助设置', 'Request settings'),
      [
        [
          session.label('求助有效时间', 'Request duration'),
          () =>
            session.form(
              session.label('求助有效时间', 'Request duration'),
              [session.details[5]],
              (values) => {
                const hours = Number(values.hours);
                if (!Number.isFinite(hours) || hours <= 0 || hours > 720)
                  return session.message(
                    session.label(
                      '有效时间必须大于0且不超过720小时。',
                      'Duration must be over 0 and at most 720 hours.',
                    ),
                    () => requestSettings(row),
                  );
                session.save(row, { values, step: 'review', index: 0 });
              },
              back,
              { ...c.values },
            ),
        ],
        [
          session.label('选择其他已有工作', 'Choose another existing work'),
          () => session.save(row, { step: 'details', index: 0 }),
        ],
        [
          session.label('来源与完整草稿', 'Source and full draft'),
          () =>
            session.message(JSON.stringify(c, null, 2), () =>
              requestSettings(row),
            ),
        ],
      ],
      back,
    );
  }

  function editRequest(row) {
    session.menu(
      session.label('修改求助内容', 'Edit request'),
      [4, 1, 2, 3].map((index) => {
        const [key, title] = session.details[index];
        return [
          title,
          () =>
            key === 'attempts'
              ? session.editApproaches(
                  row,
                  (approaches) =>
                    session.save(row, {
                      attemptedApproaches: approaches,
                      values: { ...row.content.values, attempts: '' },
                      step: 'review',
                      index: 0,
                    }),
                  () => editRequest(row),
                )
              : session.form(
                  title,
                  [[key, title]],
                  (values) =>
                    session.save(row, { values, step: 'review', index: 0 }),
                  () => editRequest(row),
                  { ...row.content.values },
                ),
          key === 'attempts'
            ? assistanceDraftApproaches(row.content)
                .map(session.plain)
                .join('\n')
            : session.plain(row.content.values[key]),
        ];
      }),
      () => session.render(row),
    );
  }

  function requestPreview(row) {
    const back = () => session.openDraft(row.id);
    const approaches = assistanceDraftApproaches(row.content);
    if (
      approaches.length > 8 ||
      approaches.some((value) => value.length > 1200)
    )
      return session.message(
        session.label(
          '当前已有尝试超过这份求助允许的内容长度。原文仍保留，可以选择要附上的尝试。',
          'The current approaches exceed this request’s content limits. Original text is retained; choose the approaches to include.',
        ),
        () =>
          session.editApproaches(
            row,
            (items) =>
              session.save(row, {
                attemptedApproaches: items,
                values: { ...row.content.values, attempts: '' },
                step: 'review',
                index: 0,
              }),
            back,
          ),
      );
    void session.run(
      () =>
        session.controller.prepareCollaborationDraft({
          draftId: row.id,
          draftRevision: row.revision,
        }),
      (preview) => {
        const version = session.generation;
        const edit = (action) => {
          if (!session.active(version)) return;
          session.generation++;
          session.controller.cancel();
          action();
        };
        const request = JSON.parse(preview.payloadJson);
        showExactChoice({
          preview,
          title:
            session.plain(request.title) ||
            session.label('发布求助', 'Publish help request'),
          select: session.select,
          info: session.info,
          language: session.language,
          reviewInBody: true,
          showAuthorizationExpiry: false,
          allowLabel: session.label('发布求助', 'Publish request'),
          isCurrent: () => session.active(version),
          readableContent: {
            problem: request.problem,
            requestedScope: request.scope,
            attemptedApproaches: request.attemptedApproaches.join('\n'),
            ...(request.budget
              ? { notes: session.valuesText(row.content) }
              : {}),
          },
          note:
            session.label('求助有效至：', 'Request available until: ') +
            new Date(request.enrollmentExpiresAt * 1000).toLocaleString(
              session.zh ? 'zh-CN' : 'en-US',
            ),
          actions: [
            [
              session.label('修改内容', 'Edit content'),
              () => edit(() => editRequest(row)),
            ],
            [
              session.label('调整可见范围', 'Change visibility'),
              () =>
                edit(() => session.save(row, { step: 'visibility', index: 0 })),
            ],
            [
              session.label('更多设置', 'More settings'),
              () => edit(() => requestSettings(row)),
            ],
          ],
          onCancel: () => edit(back),
          onConfirm: async (confirmation) => {
            if (!session.active(version)) return;
            const submitted = ++session.generation;
            session.info(
              'Galaxy',
              session.label(
                '正在发布；Esc返回后会接续同一次操作。',
                'Publishing; after Esc, continue this same operation.',
              ),
              () => {
                if (session.active(submitted)) {
                  session.generation++;
                  session.controller.cancel();
                  session.operation(row.id);
                }
              },
            );
            try {
              const receipt = await session.controller.executeCollaboration(
                preview,
                confirmation,
              );
              if (session.active(submitted))
                session.message(
                  session.label(
                    '这份求助已发布。',
                    'This request was published.',
                  ),
                  () => session.onOpenRequest(receipt.assistanceId),
                );
            } catch {
              if (!session.active(submitted)) return;
              let saved;
              try {
                saved = await session.controller.getAssistanceDraft(row.id);
              } catch {
                /* Keep unavailable owner data closed. */
              }
              if (!session.active(submitted)) return;
              if (saved?.status === 'editing')
                return session.message(
                  session.label(
                    '暂时未能发布；已填内容保存在本机，可以返回当前草稿继续。',
                    'Publication did not complete. Your content is saved locally; continue the current draft.',
                  ),
                  () => session.openDraft(row.id),
                );
              session.message(
                session.label(
                  '暂未确认结果；继续时读取原操作，已填内容保留。',
                  'The outcome is unconfirmed. Continuing reads the original operation; your content is retained.',
                ),
                () => session.operation(row.id),
              );
            }
          },
        });
      },
      back,
    );
  }
  return { requestSettings, editRequest, requestPreview };
}
