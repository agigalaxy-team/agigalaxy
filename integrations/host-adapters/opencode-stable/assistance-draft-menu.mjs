import { createAssistanceDraftsRequestFields } from './assistance-drafts/request-fields.mjs';
import { createAssistanceDraftsRequest } from './assistance-drafts/request.mjs';
import { createAssistanceDraftsEvents } from './assistance-drafts/events.mjs';
import { createLegacyWorkSelection } from './legacy-work-selection.mjs';
import { createExistingRecordSelection } from './existing-record-selection.mjs';
import { assistanceDraftApproaches } from "../../../packages/galaxy-contracts/src/assistance-schema.mjs";
// Native persisted collaboration wizard. Saving fields is local.
export function createAssistanceDraftMenu({
  controller,
  select,
  prompt,
  info,
  language,
  isCurrent,
  onBack,
  onConfirm,
  onOpenRequest,
  canSubmit = true,
  readWorkContext,
}) {
  const zh = language !== 'en-US',
    label = (a, b) => (zh ? a : b);
  const plain = (value) =>
    String(value ?? '')
      .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .slice(0, 1200);
  let generation = 0;
  const active = (version) => isCurrent() && version === generation;
  function menu(title, entries, back = onBack, offset = 0) {
    if (!isCurrent()) return;
    const version = ++generation,
      routes = {};
    const once = (fn) => () => {
      if (active(version)) {
        generation++;
        fn();
      }
    };
    const options = entries
      .slice(offset, offset + 8)
      .map(([title, action, description = ''], i) => {
        routes[i + 1] = once(action);
        return { number: String(i + 1), title, description };
      });
    if (offset + 8 < entries.length) {
      options.push({ number: '9', title: label('下一页', 'Next page') });
      routes[9] = once(() => menu(title, entries, back, offset + 8));
    }
    select({
      title,
      options,
      routes,
      onBack: once(
        offset
          ? () => menu(title, entries, back, Math.max(0, offset - 8))
          : back,
      ),
    });
  }
  function message(text, back) {
    if (!isCurrent()) return;
    const version = ++generation;
    info('Galaxy', text, () => {
      if (active(version)) {
        generation++;
        back();
      }
    });
  }
  async function run(work, done, back = onBack) {
    if (!isCurrent()) return;
    const version = ++generation;
    info(
      'Galaxy',
      label('正在保存或读取；Esc返回。', 'Saving or reading; Esc returns.'),
      () => {
        if (active(version)) {
          generation++;
          controller.cancel();
          back();
        }
      },
    );
    try {
      const result = await work();
      if (active(version)) done(result);
    } catch (error) {
      if (active(version)) message(plain(error.message), back);
    }
  }
  function save(row, changes) {
    const content = { ...row.content, ...changes };
    void run(
      () =>
        controller.saveAssistanceDraft({
          id: row.id,
          expectedRevision: row.revision,
          content,
        }),
      render,
      () => openDraft(row.id),
    );
  }
  function form(title, items, done, back, draft = {}, index = 0) {
    if (index === items.length) return done(draft);
    const [key, name, initial = ''] = items[index],
      version = ++generation;
    prompt({
      title: title === name ? title : title + '\n' + name,
      placeholder: name,
      value: String(draft[key] ?? initial),
      onCancel: () => {
        if (active(version)) {
          generation++;
          back();
        }
      },
      onConfirm: (value) => {
        if (!active(version)) return;
        generation++;
        draft[key] = String(value).trim();
        form(title, items, done, back, draft, index + 1);
      },
    });
  }
  const workSelection = createLegacyWorkSelection({
    controller,
    menu,
    form,
    message,
    run,
    label,
    plain,
    readWorkContext,
  });
  const records = createExistingRecordSelection({
    controller,
    menu,
    message,
    run,
    label,
    plain,
  });
  const split = (value) =>
    String(value ?? '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const eventName = (kind) =>
    ({
      invite: label('邀请参与', 'Invite participation'),
      offer: label('申请协助', 'Offer help'),
      'withdraw-offer': label('撤回申请', 'Withdraw offer'),
      shortlist: label('选择候选人', 'Choose candidates'),
      select: label('选择参与者', 'Choose participant'),
      confirm: label('确认参与', 'Confirm participation'),
      'change-scope': label('调整协作范围', 'Change scope'),
      'confirm-scope': label('确认新范围', 'Confirm scope'),
      deliver: label('交付结果', 'Deliver result'),
      accept: label('验收交付', 'Accept delivery'),
      cancel: label('取消协作', 'Cancel collaboration'),
      expire: label('结束招募', 'End enrollment'),
      dispute: label('提出异议', 'Raise dispute'),
      'propose-resolution': label('提出处理方案', 'Propose resolution'),
      'confirm-resolution': label('确认处理方案', 'Confirm resolution'),
      'requester-feedback': label('评价请求说明', 'Assess request description'),
    })[kind] ?? plain(kind);
  const operationState = (value) =>
    ({
      prepared: label('尚未确认完成', 'Completion not confirmed'),
      acknowledged: label('已完成', 'Completed'),
      unknown: label('暂未确认结果', 'Outcome unconfirmed'),
      absent: label('原内容尚未收到', 'Original content not received'),
    })[value] ?? plain(value);
  const details = [
    ['caseId', label('已保存的原工作引用', 'Saved original work reference')],
    ['title', label('标题', 'Title')],
    ['problem', label('问题说明', 'Problem')],
    ['attempts', label('已有尝试（可留空）', 'Previous approaches (optional)')],
    ['scope', label('希望得到怎样的协助', 'What help would you like')],
    [
      'hours',
      label(
        '招募有效小时数（大于0，最多720）',
        'Enrollment hours (over 0, at most 720)',
      ),
    ],
  ];
  function render(row) {
    if (!isCurrent()) return;
    if (row.status !== 'editing') return operation(row.id);
    if (row.content.eventKind) return renderEvent(row);
    const content = row.content,
      back = () => openDraft(row.id);
    switch (content.step) {
      case 'details':
        return fields(row, details, 'visibility', back);
      case 'visibility':
        return menu(
          label('请求可见性', 'Request visibility'),
          [
            [
              label('仅自己', 'Only me'),
              () =>
                save(row, {
                  visibility: 'Private',
                  values: { ...content.values, viewers: '' },
                  mode: content.mode ?? 'open',
                  step: 'review',
                  index: 0,
                }),
            ],
            [
              label('私有：指定参与者', 'Private: named participants'),
              () =>
                save(row, { visibility: 'Private', step: 'viewers', index: 0 }),
            ],
            [
              label('公开请求说明', 'Public request description'),
              () =>
                save(row, {
                  visibility: 'Public',
                  values: { ...content.values, viewers: '' },
                  step: 'review',
                  mode: content.mode ?? 'open',
                  index: 0,
                }),
            ],
          ],
          () => save(row, { step: 'details', index: 4 }),
        );
      case 'viewers':
        return fields(
          row,
          [
            [
              'viewers',
              label(
                '已有参与者的稳定身份，逗号分隔；留空仅自己',
                'Existing participant identities, comma separated; empty means yourself',
              ),
            ],
          ],
          'review',
          () => save(row, { step: 'visibility', index: 0 }),
        );
      case 'budget':
        return menu(
          label('协作与预算说明', 'Collaboration and budget'),
          [
            ['open', label('开放协助', 'Open assistance')],
            ['fixed', label('固定金额', 'Fixed amount')],
            ['range', label('预算区间', 'Budget range')],
            ['quote', label('请求报价', 'Request quote')],
          ].map(([mode, title]) => [
            title,
            () =>
              save(row, {
                mode,
                qualification: null,
                step: mode === 'open' ? 'qualification' : 'budget-fields',
                index: 0,
              }),
          ]),
          () =>
            save(row, {
              step: controller.queryHistory
                ? 'review'
                : content.visibility === 'Private'
                  ? 'viewers'
                  : 'visibility',
              index: 0,
            }),
        );
      case 'budget-fields':
        return fields(
          row,
          [
            ...(content.mode === 'fixed'
              ? [['amount', label('金额', 'Amount')]]
              : content.mode === 'range'
                ? [
                    ['minimum', label('最低金额', 'Minimum')],
                    ['maximum', label('最高金额', 'Maximum')],
                  ]
                : []),
            ['unit', label('结算单位（仅说明）', 'Unit (description only)')],
          ],
          'qualification',
          () => save(row, { step: 'budget', index: 0 }),
        );
      case 'qualification': {
        if (!content.values.capabilityId)
          return save(row, { qualification: null, step: 'review', index: 0 });
        if (!controller.qualificationPolicies)
          return menu(
            label(
              '连接后可读取参与资格政策；草稿已保存。',
              'Connect to read participation policies; the draft is saved.',
            ),
            [
              [
                label(
                  '暂不设置资格政策',
                  'Continue without a qualification policy',
                ),
                () =>
                  save(row, { qualification: null, step: 'review', index: 0 }),
              ],
            ],
            back,
          );
        return void run(
          () => controller.qualificationPolicies(),
          (result) =>
            menu(
              label('参与资格政策', 'Participation policy'),
              [
                [
                  label('不设资格政策', 'No qualification policy'),
                  () =>
                    save(row, {
                      qualification: null,
                      step: 'review',
                      index: 0,
                    }),
                ],
                ...result.policies
                  .filter(
                    (p) =>
                      p.capabilityId === content.values.capabilityId &&
                      p.collaboration ===
                        (content.mode === 'open'
                          ? 'open-assistance'
                          : 'basic-bounty'),
                  )
                  .map((p) => [
                    plain(p.title),
                    () =>
                      save(row, {
                        qualification: {
                          policyId: p.id,
                          policyVersion: p.version,
                        },
                        step: 'review',
                        index: 0,
                      }),
                    label('版本 ', 'Version ') + plain(p.version),
                  ]),
              ],
              () => save(row, { step: 'budget', index: 0 }),
            ),
          back,
        );
      }
      case 'review':
        if (canSubmit && controller.prepareCollaborationDraft)
          return requestPreview(row);
        return menu(
          `${plain(content.values.title) || label('准备求助', 'Prepare help request')}\n${valuesText({ ...content, values: { ...content.values, title: '' } })}\n${content.visibility === 'Public' ? label('公开所选说明', 'Public selected description') : content.values.viewers ? label('自己与指定参与者', 'You and named participants') : label('仅自己', 'Only me')}`,
          [
            ...(canSubmit
              ? [[label('发布求助', 'Publish request'), () => submit(row)]]
              : []),
            ...(controller.queryHistory
              ? [
                  [label('修改内容', 'Edit content'), () => editRequest(row)],
                  [
                    label('调整可见范围', 'Change visibility'),
                    () => save(row, { step: 'visibility', index: 0 }),
                  ],
                  [
                    label('更多设置', 'More settings'),
                    () => requestSettings(row),
                  ],
                ]
              : [
                  [
                    label('修改草稿', 'Edit draft'),
                    () => save(row, { step: 'details', index: 0 }),
                  ],
                ]),
            [label('稍后继续', 'Continue later'), open],
          ],
          back,
        );
    }
  }
  function submit(row) {
    const { values, visibility, mode, qualification } = row.content,
      hours = Number(values.hours);
    if (!values.caseId)
      return message(
        label(
          '草稿已保存。连接后选择原工作，再提交这份求助。',
          'The draft is saved. Connect and choose the original work before submitting.',
        ),
        () => save(row, { step: 'details', index: 0 }),
      );
    if (!Number.isFinite(hours) || hours <= 0 || hours > 720)
      return message(
        label('请修改招募有效小时数。', 'Edit enrollment hours.'),
        () => render(row),
      );
    const request = {
      id: row.id,
      caseId: values.caseId,
      title: values.title,
      problem: values.problem,
      attemptedApproaches: assistanceDraftApproaches(row.content),
      scope: values.scope,
      ...(values.capabilityId ? { capabilityId: values.capabilityId } : {}),
      visibility,
      collaboration: mode === 'open' ? 'open-assistance' : 'basic-bounty',
      ...(mode === 'open'
        ? {}
        : {
            budget: {
              mode,
              unit: values.unit,
              ...(mode === 'fixed'
                ? { amount: values.amount }
                : mode === 'range'
                  ? { minimum: values.minimum, maximum: values.maximum }
                  : {}),
            },
          }),
      ...(qualification ? { qualification } : {}),
      enrollmentExpiresAt: Math.floor(Date.now() / 1000 + hours * 3600),
    };
    const viewers =
      visibility === 'Private'
        ? (values.viewers ?? '')
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    generation++;
    onConfirm(
      { draftId: row.id, draftRevision: row.revision, request, viewers },
      () => openDraft(row.id),
    );
  }
  function openDraft(id) {
    void run(
      () => controller.getAssistanceDraft(id),
      (row) => {
        if (row.status !== 'editing') return operation(row.id);
        menu(
          `${label('本地草稿', 'Local draft')}: ${row.content.eventKind ? eventName(row.content.eventKind) + ' · ' + plain(row.content.source.title) : plain(row.content.values.title) || label('未命名草稿', 'Untitled draft')}`,
          [
            [
              label('继续填写', 'Continue editing'),
              () =>
                row.content.eventKind && canSubmit
                  ? checkEventVersion(row, render)
                  : render(row),
            ],
            ...(row.content.eventKind
              ? [
                  [
                    label('查看已保存内容', 'View saved content'),
                    () => message(valuesText(row.content), () => openDraft(id)),
                  ],
                  [
                    label(
                      '查看原草稿字段与来源',
                      'Inspect original draft fields and source',
                    ),
                    () =>
                      message(JSON.stringify(row.content, null, 2), () =>
                        openDraft(id),
                      ),
                  ],
                ]
              : []),
            [
              label('删除本地草稿', 'Remove local draft'),
              () => void run(() => controller.forgetAssistanceDraft(id), open),
            ],
          ],
          open,
        );
      },
      open,
    );
  }
  function operation(eventId) {
    void run(
      async () => {
        const page = await controller.listCollaborationOperations(),
          row = page.items.find((item) => item.eventId === eventId);
        let result, readError;
        if (row && canSubmit && controller.reconcileCollaboration) {
          try {
            result = await controller.reconcileCollaboration(eventId);
          } catch (error) {
            readError = plain(error.message);
          }
        }
        return { row, result, readError };
      },
      ({ row, result, readError }) => {
        if (!row)
          return message(
            label('本地提交记录不存在。', 'Local operation unavailable.'),
            open,
          );
        const again = () => operation(eventId),
          entries = [
            ...(canSubmit
              ? [
                  ...(readError
                    ? [[label('重试读取', 'Retry reading'), again]]
                    : []),
                  ...(result?.state === 'absent'
                    ? [
                        [
                          label(
                            '预览原内容并重试',
                            'Preview original content and retry',
                          ),
                          () => {
                            generation++;
                            onConfirm(eventId, again, true);
                          },
                        ],
                      ]
                    : []),
                  [
                    label('打开当前协作请求', 'Open current request'),
                    () => {
                      generation++;
                      onOpenRequest(row.assistanceId);
                    },
                  ],
                ]
              : []),
            [
              label('查看原提交来源', 'Inspect original submission source'),
              () =>
                message(
                  JSON.stringify(
                    { record: row, currentRead: result ?? null },
                    null,
                    2,
                  ),
                  again,
                ),
            ],
            ...(['prepared', 'acknowledged'].includes(row.status)
              ? [
                  [
                    label('删除本地提交记录', 'Remove local operation record'),
                    () =>
                      void run(
                        () => controller.forgetCollaborationOperation(eventId),
                        open,
                        again,
                      ),
                  ],
                ]
              : []),
          ];
        menu(
          `${plain(row.title) || eventName(row.kind)}\n${operationState(result?.state ?? row.status)}${readError ? '\n' + label('暂未取得当前结果；原内容已保留。', 'Current outcome unavailable; the original content is retained.') : ''}${canSubmit ? '' : '\n' + label('连接后才能读取当前结果或重试。', 'Connect before reading the current result or retrying.')}`,
          entries,
          open,
        );
      },
      open,
    );
  }
  function open() {
    void run(
      async () => ({
        drafts: await controller.listAssistanceDrafts(),
        operations: await controller.listCollaborationOperations(),
      }),
      ({ drafts, operations }) => {
        menu(label('继续未完成内容', 'Continue saved work'), [
          ...drafts.items
            .filter((row) => row.status === 'editing')
            .map((row) => [
              plain(row.title) || label('未命名草稿', 'Untitled draft'),
              () => openDraft(row.id),
              plain(row.updatedAt),
            ]),
          ...operations.items.map((row) => [
            `${plain(row.title) || eventName(row.kind)} · ${operationState(row.status)}`,
            () => operation(row.eventId),
            plain(row.updatedAt),
          ]),
          [label('发起求助', 'Ask for help'), create],
        ]);
      },
    );
  }
  function create() {
    void run(() => controller.createAssistanceDraft(), render);
  }
  const eventLabels = {
    participantId: ['参与者 Galaxy ID', 'Participant Galaxy ID'],
    note: ['说明', 'Note'],
    proposal: ['申请方案', 'Proposal'],
    scope: ['协作范围', 'Scope'],
    reason: ['原因', 'Reason'],
    attemptId: ['已保存的原尝试引用', 'Saved original attempt reference'],
    summary: ['说明与结果', 'Summary'],
    evidenceIds: [
      '已有原材料引用（可不引用）',
      'Existing original material references (optional)',
    ],
    proofIds: ['已有 CI 来源引用', 'Existing CI source references'],
    assistanceIds: ['已有验收工作引用', 'Existing accepted work references'],
    descriptionClarity: [
      '描述清晰度：clear / partly-clear / unclear',
      'Description clarity: clear / partly-clear / unclear',
    ],
    scopeMatched: [
      '实际工作符合范围：yes / no',
      'Work matched scope: yes / no',
    ],
  };
  const session = {
    get active() {
      return active;
    },
    get canSubmit() {
      return canSubmit;
    },
    get controller() {
      return controller;
    },
    get details() {
      return details;
    },
    get editApproaches() {
      return editApproaches;
    },
    get eventLabels() {
      return eventLabels;
    },
    get eventName() {
      return eventName;
    },
    get fields() {
      return fields;
    },
    get form() {
      return form;
    },
    get generation() {
      return generation;
    },
    set generation(value) {
      generation = value;
    },
    get info() {
      return info;
    },
    get label() {
      return label;
    },
    get language() {
      return language;
    },
    get menu() {
      return menu;
    },
    get message() {
      return message;
    },
    get onConfirm() {
      return onConfirm;
    },
    get onOpenRequest() {
      return onOpenRequest;
    },
    get open() {
      return open;
    },
    get openDraft() {
      return openDraft;
    },
    get operation() {
      return operation;
    },
    get plain() {
      return plain;
    },
    get prompt() {
      return prompt;
    },
    get records() {
      return records;
    },
    get render() {
      return render;
    },
    get run() {
      return run;
    },
    get save() {
      return save;
    },
    get select() {
      return select;
    },
    get split() {
      return split;
    },
    get valuesText() {
      return valuesText;
    },
    get workSelection() {
      return workSelection;
    },
    get zh() {
      return zh;
    },
  };
  const { valuesText, fields, editApproaches } =
    createAssistanceDraftsRequestFields(session);
  const { requestSettings, editRequest, requestPreview } =
    createAssistanceDraftsRequest(session);
  const { renderEvent, checkEventVersion, createEvent } =
    createAssistanceDraftsEvents(session);
  return Object.freeze({ open, create, openDraft, createEvent });
}
