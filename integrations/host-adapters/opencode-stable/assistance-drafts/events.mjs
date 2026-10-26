import {
  eventDraftFields,
  eventFromDraft,
  checkEventDraftTarget,
} from '../../../../packages/galaxy-official/src/shared/assistance-event-draft.mjs';
import { publicContributionEventKinds } from '../../../../packages/galaxy-official/src/shared/assistance-schema.mjs';

export function createAssistanceDraftsEvents(session) {
  function renderEvent(row) {
    const c = row.content,
      back = () => session.openDraft(row.id),
      prompts = eventDraftFields[c.eventKind].map((key) => [
        key,
        session.label(...session.eventLabels[key]),
      ]);
    const afterFields =
      c.eventKind === 'offer'
        ? c.source.qualification
          ? 'qualification'
          : c.source.collaboration === 'basic-bounty'
            ? 'budget'
            : 'review'
        : 'review';
    if (c.step === 'fields')
      return prompts.length
        ? session.fields(row, prompts, afterFields, back)
        : session.save(row, { step: 'review', index: 0 });
    if (c.step === 'qualification')
      return session.fields(
        row,
        ['proofIds', 'assistanceIds'].map((key) => [
          key,
          session.label(...session.eventLabels[key]),
        ]),
        c.source.collaboration === 'basic-bounty' ? 'budget' : 'review',
        () =>
          session.save(row, {
            step: 'fields',
            index: Math.max(0, prompts.length - 1),
          }),
      );
    if (c.step === 'budget')
      return session.menu(
        session.label('申请报价', 'Offer quote'),
        [
          ['open', session.label('不报价', 'No quote')],
          ['fixed', session.label('固定金额', 'Fixed amount')],
          ['range', session.label('预算区间', 'Budget range')],
          ['quote', session.label('请求报价', 'Request quote')],
        ].map(([mode, title]) => [
          title,
          () =>
            session.save(row, {
              mode,
              step: mode === 'open' ? 'review' : 'budget-fields',
              index: 0,
            }),
        ]),
        () =>
          session.save(row, {
            step: c.source.qualification ? 'qualification' : 'fields',
            index: 0,
          }),
      );
    if (c.step === 'budget-fields')
      return session.fields(
        row,
        [
          ...(c.mode === 'fixed'
            ? [['amount', session.label('金额', 'Amount')]]
            : c.mode === 'range'
              ? [
                  ['minimum', session.label('最低金额', 'Minimum')],
                  ['maximum', session.label('最高金额', 'Maximum')],
                ]
              : []),
          [
            'unit',
            session.label('结算单位（仅说明）', 'Unit (description only)'),
          ],
        ],
        'review',
        () => session.save(row, { step: 'budget', index: 0 }),
      );
    session.menu(
      `${session.eventName(c.eventKind)}\n${session.plain(c.source.title)}\n${session.plain(c.source.agreedScope)}\n${c.eventKind === 'deliver' ? `${session.label('工作纠正/复核版本', 'Work correction/review version')}: ${session.plain(c.source.caseReviewVersion ?? session.label('未绑定；不能用于纠正后恢复', 'Unbound; cannot restore corrected work'))}\n` : ''}${(c.target.outcome ?? c.source.resolutionOutcome) === 'resume-work' ? session.label('双方确认后继续工作，需重新交付与验收。', 'Both parties confirm resuming work; a new delivery and acceptance are required.') + '\n' : ''}${session.valuesText(c)}`,
      [
        ...(session.canSubmit
          ? [
              [
                session.label('预览事件与授权', 'Preview event and Consent'),
                () => checkEventVersion(row, submitEvent),
              ],
            ]
          : []),
        ...(session.canSubmit &&
        c.source.visibility === 'Public' &&
        publicContributionEventKinds.includes(c.eventKind)
          ? [
              [
                c.eventKind === 'requester-feedback'
                  ? session.label('预览公开反馈', 'Preview public feedback')
                  : session.label(
                      '预览公开贡献事件',
                      'Preview public contribution event',
                    ),
                () =>
                  checkEventVersion(row, (current) =>
                    submitEvent(current, 'Public'),
                  ),
                c.eventKind === 'requester-feedback'
                  ? session.label(
                      '提供者本人评价；不计入贡献或能力分。',
                      'The provider’s own assessment; no contribution or capability points.',
                    )
                  : session.label(
                      '此次事件用于公开履历；确认前展示全部内容。',
                      'This event may support public history; review all content before confirming.',
                    ),
              ],
            ]
          : []),
        ...(prompts.length
          ? [
              [
                session.label('修改草稿', 'Edit draft'),
                () => session.save(row, { step: 'fields', index: 0 }),
              ],
            ]
          : []),
        [
          session.label(
            '查看原草稿字段与来源',
            'Inspect original draft fields and source',
          ),
          () =>
            session.message(JSON.stringify(c, null, 2), () => renderEvent(row)),
        ],
        [session.label('留待以后继续', 'Continue later'), session.open],
      ],
      back,
    );
  }

  function checkEventVersion(row, done) {
    const back = () => session.openDraft(row.id);
    void session.run(
      () => session.controller.getAssistance(row.content.source.assistanceId),
      (current) => {
        try {
          checkEventDraftTarget(row.content, current);
        } catch (error) {
          return session.message(session.plain(error.message), back);
        }
        if (
          current.version === row.content.source.version &&
          (row.content.eventKind !== 'deliver' ||
            current.deliverySource?.reviewVersion ===
              row.content.source.caseReviewVersion)
        )
          return done(row);
        const old = row.content.source;
        session.menu(
          `${session.label('协作版本已变化；已填内容保留', 'Collaboration changed; saved text is retained')}\n${session.label('原记录', 'Saved')}: v${old.version} · ${session.plain(old.state)} · Case ${session.plain(old.caseReviewVersion)}\n${session.plain(old.selected?.providerId)} · ${session.plain(old.agreedScope)}\n${session.label('当前记录', 'Current')}: v${current.version} · ${session.plain(current.state)} · Case ${session.plain(current.deliverySource?.reviewVersion)}\n${session.plain(current.selected?.providerId)} · ${session.plain(current.agreedScope)}\n${session.label('待确认范围', 'Pending scope')}: ${session.plain(current.pendingScope)}`,
          [
            [
              session.label(
                '按当前版本继续编辑',
                'Continue editing against current version',
              ),
              () =>
                void session.run(
                  () =>
                    session.controller.rebaseAssistanceDraft({
                      id: row.id,
                      expectedRevision: row.revision,
                      record: current,
                    }),
                  session.render,
                  back,
                ),
            ],
            [
              session.label('查看已保存内容', 'View saved content'),
              () => session.message(JSON.stringify(row.content, null, 2), back),
            ],
            [
              session.label('打开当前协作请求', 'Open current request'),
              () => {
                session.generation++;
                session.onOpenRequest(old.assistanceId);
              },
            ],
          ],
          back,
        );
      },
      back,
    );
  }

  function submitEvent(row, eventVisibility = 'Private') {
    let event;
    try {
      event = eventFromDraft(row);
    } catch (error) {
      return session.message(session.plain(error.message), () =>
        session.openDraft(row.id),
      );
    }
    session.generation++;
    session.onConfirm(
      {
        draftId: row.id,
        draftRevision: row.revision,
        assistanceId: row.content.source.assistanceId,
        event,
        ...(eventVisibility === 'Public' ? { eventVisibility } : {}),
      },
      () => session.openDraft(row.id),
    );
  }

  function createEvent(input) {
    void session.run(
      () => session.controller.createAssistanceEventDraft(input),
      session.render,
    );
  }
  return { renderEvent, checkEventVersion, submitEvent, createEvent };
}
