import { createAssistanceModerationMenu } from './assistance/moderation.mjs';
import { createAssistanceNotificationsMenu } from './assistance/notifications.mjs';
import { createAssistanceQualificationsMenu } from './assistance/qualifications.mjs';
import { createAssistanceMaterialsMenu } from './assistance/materials.mjs';
import { createAssistanceRequestMenu } from './assistance/request.mjs';
import { createBuilderMenu } from './builder-menu.mjs';
import { createCapsuleMenu } from './capsule-menu.mjs';
import { createHonorMenu } from './honor-menu.mjs';
import { createAssistanceDraftMenu } from './assistance-draft-menu.mjs';
import { showExactChoice } from './exact-choice.mjs';
// Native host dialog composition; no web view, network access or signing here.
export function createAssistanceMenu({
  controller,
  select,
  prompt,
  info,
  language,
  onBack,
  isCurrent,
  availableScopes = null,
  readWorkContext,
}) {
  const zh = language !== 'en-US',
    label = (a, b) => (zh ? a : b);
  const plain = (value) =>
    String(value ?? '')
      .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .slice(0, 1200);
  let generation = 0,
    query = '';
  const alive = () => isCurrent();
  const has = (scope) => !availableScopes || availableScopes.includes(scope);
  const stateName = (value) =>
    ({
      open: label('等待参与', 'Open for participation'),
      'awaiting-confirmation': label(
        '等待确认参与',
        'Awaiting participation confirmation',
      ),
      active: label('协作中', 'Working together'),
      'awaiting-scope-confirmation': label(
        '等待确认新范围',
        'Awaiting scope confirmation',
      ),
      delivered: label('等待验收', 'Awaiting acceptance'),
      accepted: label('已验收', 'Accepted'),
      canceled: label('已取消', 'Canceled'),
      expired: label('招募已结束', 'Enrollment ended'),
      disputed: label('有待处理的异议', 'Dispute raised'),
      'awaiting-resolution-confirmation': label(
        '等待确认处理方案',
        'Awaiting resolution confirmation',
      ),
      resolved: label('已处理', 'Resolved'),
      pending: label('等待接收', 'Awaiting acceptance'),
    })[value] ?? plain(value);
  const eventName = (value) =>
    ({
      invite: label('邀请参与', 'Invitation'),
      offer: label('申请协助', 'Offer'),
      select: label('选择参与者', 'Participant selected'),
      confirm: label('确认参与', 'Participation confirmed'),
      'change-scope': label('调整协作范围', 'Scope changed'),
      'confirm-scope': label('确认新范围', 'Scope confirmed'),
      deliver: label('交付结果', 'Result delivered'),
      accept: label('验收交付', 'Delivery accepted'),
      cancel: label('取消协作', 'Collaboration canceled'),
      expire: label('结束招募', 'Enrollment ended'),
      dispute: label('提出异议', 'Dispute raised'),
      'propose-resolution': label('提出处理方案', 'Resolution proposed'),
      'confirm-resolution': label('确认处理方案', 'Resolution confirmed'),
      'requester-feedback': label(
        '评价请求说明',
        'Request description assessment',
      ),
    })[value] ?? plain(value);
  const clarityName = (value) =>
    ({
      clear: label('清楚', 'Clear'),
      'partly-clear': label('部分清楚', 'Partly clear'),
      unclear: label('不清楚', 'Unclear'),
    })[value] ?? plain(value);
  const budgetText = (budget) =>
    !budget
      ? ''
      : budget.mode === 'fixed'
        ? label('报酬', 'Compensation') +
          ': ' +
          plain(budget.amount) +
          ' ' +
          plain(budget.unit)
        : budget.mode === 'range'
          ? label('报酬区间', 'Compensation range') +
            ': ' +
            plain(budget.minimum) +
            '–' +
            plain(budget.maximum) +
            ' ' +
            plain(budget.unit)
          : label('请求报价', 'Request quote') + ' · ' + plain(budget.unit);
  const requestText = (req) =>
    [
      req.problem
        ? label('工作情况', 'Work context') + '\n' + plain(req.problem)
        : '',
      req.attemptedApproaches?.length
        ? label('已有尝试', 'Previous approaches') +
          '\n' +
          req.attemptedApproaches.map(plain).join('\n')
        : '',
      label('希望得到的协助', 'Requested help') + '\n' + plain(req.scope),
      budgetText(req.budget),
    ]
      .filter(Boolean)
      .join('\n\n');
  const leave = () => {
    generation++;
    controller.cancel();
    onBack();
  };
  const menu = (title, entries, back = home, offset = 0) => {
    if (!alive()) return;
    const routes = {},
      options = entries
        .slice(offset, offset + 8)
        .map(([title, action, description = ''], i) => {
          routes[i + 1] = () => {
            if (alive()) action();
          };
          return { number: String(i + 1), title, description };
        });
    if (offset + 8 < entries.length) {
      options.push({
        number: '9',
        title: label('下一页', 'Next page'),
        description: '',
      });
      routes[9] = () => menu(title, entries, back, offset + 8);
    }
    select({
      title,
      options,
      routes,
      onBack: offset
        ? () => menu(title, entries, back, Math.max(0, offset - 8))
        : back,
    });
  };
  const message = (text, back = home) => {
    if (alive()) info('Galaxy', text, back);
  };
  async function run(work, done, back = home) {
    const version = ++generation;
    message(
      label('正在读取或准备；Esc返回。', 'Reading or preparing; Esc returns.'),
      () => {
        generation++;
        controller.cancel();
        back();
      },
    );
    try {
      const result = await work();
      if (alive() && version === generation) done(result);
    } catch (error) {
      if (alive() && version === generation) {
        controller.cancel();
        message(plain(error.message), back);
      }
    }
  }
  function form(title, fields, done, back = home, draft = {}, index = 0) {
    if (!alive()) return;
    if (index === fields.length) {
      done(draft);
      return;
    }
    const [key, name, initial = ''] = fields[index];
    prompt({
      title: `${title} · ${index + 1}/${fields.length}\n${name}`,
      placeholder: name,
      value: String(draft[key] ?? initial),
      onCancel: index
        ? () => form(title, fields, done, back, draft, index - 1)
        : back,
      onConfirm: (value) => {
        if (!alive()) return;
        if (String(value).length > 1200) {
          message(label('最多1200字符。', 'Maximum 1200 characters.'), () =>
            form(title, fields, done, back, draft, index),
          );
          return;
        }
        draft[key] = value.trim();
        form(title, fields, done, back, draft, index + 1);
      },
    });
  }
  function confirm(input, back, context = false, retry = false) {
    void run(
      () =>
        controller[
          retry
            ? context
              ? 'prepareContextRetry'
              : 'prepareCollaborationRetry'
            : context === 'moderation'
              ? 'prepareModeration'
              : context
                ? 'prepareContext'
                : 'prepareCollaboration'
        ](input),
      (preview) => {
        let submitted = false;
        const cancel = () => {
          generation++;
          controller.cancel();
          back();
        };
        const previewVersion = generation;
        const show = () =>
          showExactChoice({
            preview,
            title: label(
              context === 'moderation'
                ? '保存这次处理记录'
                : context
                  ? '调整这份材料的授权'
                  : '继续这次协作',
              context === 'moderation'
                ? 'Save this handling record'
                : context
                  ? 'Change this material authorization'
                  : 'Continue this collaboration',
            ),
            select,
            info,
            language,
            isCurrent: () =>
              alive() && generation === previewVersion && !submitted,
            onCancel: cancel,
            onConfirm: async (value) => {
              if (!alive() || submitted) return;
              submitted = true;
              const version = ++generation;
              message(
                label(
                  '正在提交；Esc取消等待。',
                  'Submitting; Esc cancels waiting.',
                ),
                cancel,
              );
              try {
                const receipt = await controller[
                  context === 'moderation'
                    ? 'executeModeration'
                    : context
                      ? 'executeContext'
                      : 'executeCollaboration'
                ](preview, value);
                if (alive() && version === generation)
                  message(
                    label(
                      context === 'moderation'
                        ? '这次处理记录已保存。'
                        : context
                          ? '所选材料的授权已保存。'
                          : '这次协作已保存。',
                      context === 'moderation'
                        ? 'This handling record was saved.'
                        : context
                          ? 'The selected material authorization was saved.'
                          : 'This collaboration was saved.',
                    ),
                    context ? back : () => detail(receipt.assistanceId),
                  );
              } catch {
                if (alive() && version === generation)
                  message(
                    label(
                      '结果暂未确认；原内容已保留，继续时会读取同一次操作。',
                      'The outcome is unconfirmed. The original content is retained; continuing reads this same operation.',
                    ),
                    context || controller.listCollaborationOperations
                      ? back
                      : () => detail(preview.assistanceId),
                  );
              }
            },
          });
        show();
      },
      back,
    );
  }
  function budget(done, back, optional = false) {
    menu(
      label('协作与预算说明', 'Collaboration and budget'),
      [
        [
          label(
            optional ? '不报价' : '开放协助',
            optional ? 'No quote' : 'Open assistance',
          ),
          () => done(undefined),
        ],
        [
          label('固定金额', 'Fixed amount'),
          () =>
            form(
              'Budget',
              [
                ['amount', label('金额', 'Amount')],
                [
                  'unit',
                  label('结算单位（仅说明）', 'Unit (description only)'),
                ],
              ],
              (doneValue) => done({ mode: 'fixed', ...doneValue }),
              back,
            ),
        ],
        [
          label('预算区间', 'Budget range'),
          () =>
            form(
              'Budget',
              [
                ['minimum', label('最低金额', 'Minimum')],
                ['maximum', label('最高金额', 'Maximum')],
                ['unit', label('结算单位', 'Unit')],
              ],
              (doneValue) => done({ mode: 'range', ...doneValue }),
              back,
            ),
        ],
        [
          label('请求报价', 'Request quote'),
          () =>
            form(
              'Budget',
              [['unit', label('结算单位', 'Unit')]],
              (doneValue) => done({ mode: 'quote', ...doneValue }),
              back,
            ),
        ],
      ],
      back,
    );
  }
  function create() {
    if (controller.createAssistanceDraft) return drafts().create();
    form(
      label('发布求助', 'Create request'),
      [
        ['caseId', label('已发布Case的ID', 'ID of your published Case')],
        ['title', label('标题', 'Title')],
        ['problem', label('问题说明', 'Problem')],
        [
          'attempts',
          label(
            '已有尝试（每行一条，可留空）',
            'Previous approaches (one per line, optional)',
          ),
        ],
        ['scope', label('希望得到怎样的协助', 'What help would you like')],
      ],
      (draft) => {
        const request = {
          caseId: draft.caseId,
          title: draft.title,
          problem: draft.problem,
          attemptedApproaches: draft.attempts
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          scope: draft.scope,
          collaboration: 'open-assistance',
          enrollmentExpiresAt: Math.floor(Date.now() / 1000 + 86400),
        };
        const visibility = (value, viewers = []) =>
          confirm(
            { request: { ...request, visibility: value }, viewers },
            create,
          );
        menu(
          label('请求可见性', 'Request visibility'),
          [
            [label('仅自己', 'Only me'), () => visibility('Private')],
            [
              label('私有：指定参与者', 'Private: named participants'),
              () =>
                form(
                  'Private',
                  [
                    [
                      'viewers',
                      label(
                        '参与者Galaxy ID，逗号分隔；留空仅自己可见',
                        'Participant Galaxy IDs, comma separated; empty means only you',
                      ),
                    ],
                  ],
                  (value) =>
                    visibility(
                      'Private',
                      value.viewers
                        .split(/[,，]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ),
                  create,
                ),
            ],
            [
              label('公开请求说明', 'Public request description'),
              () => visibility('Public'),
            ],
          ],
          create,
        );
      },
    );
  }
  function listing(view, after) {
    void run(
      () =>
        controller.queryAssistance({
          view,
          query,
          limit: 8,
          ...(after ? { after } : {}),
        }),
      (page) => {
        const entries = [
          [
            label('查找', 'Find'),
            () =>
              form(
                label('查找求助', 'Find requests'),
                [
                  [
                    'query',
                    label(
                      '标题或问题中的文字；留空查看全部',
                      'Text in title or problem; empty shows all',
                    ),
                    query,
                  ],
                ],
                (value) => {
                  query = value.query;
                  listing(view);
                },
                () => listing(view, after),
              ),
            query,
          ],
          ...page.items.map((item) => [
            plain(item.request.title),
            () => detail(item.assistanceId, () => listing(view, after)),
            `${stateName(item.state)} · ${plain(item.request.scope)}`,
          ]),
        ];
        if (page.nextAfter)
          entries.push([
            label('下一批', 'Next results'),
            () => listing(view, page.nextAfter),
          ]);
        menu(
          `${view === 'requested' ? label('我发起的求助', 'My requests') : view === 'participating' ? label('我参与的协作', 'My participation') : label('找需要帮助的工作', 'Find requests')}\n${page.items.length ? '' : label('暂无匹配请求', 'No matching requests')}`,
          entries,
        );
      },
    );
  }
  function home() {
    menu(
      label('求助与协作', 'Help and collaboration'),
      [
        ...(controller.prepareCollaboration && has('consent')
          ? [[label('发起求助', 'Ask for help'), create]]
          : []),
        [label('我发起的求助', 'My requests'), () => listing('requested')],
        [
          label('我参与的协作', 'My participation'),
          () => listing('participating'),
        ],
        [label('找需要帮助的工作', 'Find requests'), () => listing('open')],
        ...(controller.listAssistanceDrafts &&
        controller.listCollaborationOperations
          ? [
              [
                label('继续未完成内容', 'Continue saved work'),
                () => drafts().open(),
              ],
            ]
          : []),
        ...(controller.queryNotifications && has('notifications')
          ? [[label('消息', 'Messages'), () => notifications()]]
          : []),
        [label('更多', 'More'), more],
      ],
      leave,
    );
  }
  function more() {
    menu(
      label('更多协作功能', 'More collaboration options'),
      [
        ...(controller.listContextDrafts && controller.listContextOperations
          ? [
              [
                label('继续准备协作材料', 'Continue saved materials'),
                () => materials().open(),
              ],
            ]
          : []),
        ...(controller.queryNotifications && has('notifications')
          ? [
              [
                label('通知偏好', 'Notification preferences'),
                notificationPreferences,
              ],
            ]
          : []),
        ...(controller.queryRequesterHistory
          ? [
              [
                label('我的求助经历', 'My request history'),
                () => requesterHistory(),
              ],
            ]
          : []),
        ...(controller.queryBuilders && has('builders')
          ? [
              [
                label('建设者登记与目录', 'Builder registry and directory'),
                () =>
                  createBuilderMenu({
                    controller,
                    select,
                    prompt,
                    info,
                    language,
                    isCurrent,
                    onBack: home,
                    availableScopes,
                  }).open(),
              ],
            ]
          : []),
        ...(controller.queryCapsules && has('capsules')
          ? [
              [
                label('解决方法', 'Methods'),
                () =>
                  createCapsuleMenu({
                    controller,
                    select,
                    prompt,
                    info,
                    language,
                    isCurrent,
                    onBack: home,
                    availableScopes,
                    readWorkContext,
                  }).open(),
              ],
            ]
          : []),
        ...(controller.honorRules && has('history')
          ? [
              [
                label('贡献与Honor', 'Contribution and Honor'),
                () =>
                  createHonorMenu({
                    controller,
                    select,
                    prompt,
                    info,
                    language,
                    isCurrent,
                    onBack: home,
                  }).open(),
              ],
            ]
          : []),
        ...(controller.qualificationPolicies
          ? [[label('参与条件', 'Participation requirements'), qualifications]]
          : []),
        ...(controller.queryModeration && has('moderation')
          ? [
              [
                label('举报处理队列', 'Moderation queue'),
                () => moderationList(),
              ],
            ]
          : []),
        [
          label('按原引用打开求助', 'Open a request by its original reference'),
          () =>
            form(
              label('已有求助引用', 'Existing request reference'),
              [
                [
                  'id',
                  label(
                    '你已掌握的原求助引用',
                    'Original request reference you already hold',
                  ),
                ],
              ],
              (value) => detail(value.id, more),
              more,
            ),
        ],
      ],
      home,
    );
  }
  function drafts() {
    return createAssistanceDraftMenu({
      controller,
      select,
      prompt,
      info,
      language,
      isCurrent,
      onBack: home,
      readWorkContext,
      onConfirm: (input, back, retry = false) =>
        confirm(input, back, false, retry),
      onOpenRequest: (id) => detail(id, () => drafts().open()),
    });
  }
  const session = {
    get alive() {
      return alive;
    },
    get availableScopes() {
      return availableScopes;
    },
    get budget() {
      return budget;
    },
    get clarityName() {
      return clarityName;
    },
    get confirm() {
      return confirm;
    },
    get controller() {
      return controller;
    },
    get detail() {
      return detail;
    },
    get drafts() {
      return drafts;
    },
    get eventName() {
      return eventName;
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
    get grantMaterials() {
      return grantMaterials;
    },
    get has() {
      return has;
    },
    get home() {
      return home;
    },
    get info() {
      return info;
    },
    get isCurrent() {
      return isCurrent;
    },
    get label() {
      return label;
    },
    get language() {
      return language;
    },
    get leave() {
      return leave;
    },
    get materialList() {
      return materialList;
    },
    get menu() {
      return menu;
    },
    get message() {
      return message;
    },
    get moderationList() {
      return moderationList;
    },
    get more() {
      return more;
    },
    get plain() {
      return plain;
    },
    get prompt() {
      return prompt;
    },
    get qualificationEvidence() {
      return qualificationEvidence;
    },
    get readWorkContext() {
      return readWorkContext;
    },
    get requestText() {
      return requestText;
    },
    get run() {
      return run;
    },
    get select() {
      return select;
    },
    get stateName() {
      return stateName;
    },
  };
  const { moderationList, caseModeration } =
    createAssistanceModerationMenu(session);
  const { notifications, notificationPreferences } =
    createAssistanceNotificationsMenu(session);
  const { qualificationEvidence, qualifications, requesterHistory } =
    createAssistanceQualificationsMenu(session);
  const { grantMaterials, materialList, materials } =
    createAssistanceMaterialsMenu(session);
  const { detail } = createAssistanceRequestMenu(session);
  return Object.freeze({
    open: home,
    openRequest: (id) => {
      if (alive()) detail(id, leave);
    },
    openCaseModeration: (source) => {
      if (alive()) caseModeration(source);
    },
  });
}
