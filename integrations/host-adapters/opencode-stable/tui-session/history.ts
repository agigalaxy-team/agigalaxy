import type {
  Action,
  Routes,
  MenuOption,
  HistoryFilters,
  HistoryItem,
} from '../adapter-types.ts';
import { createCaseReviewMenu } from '../case-review-menu.mjs';
import { createAssistanceMenu } from '../assistance-menu.mjs';
import { sourceReadingText } from '../source-reading.mjs';
import type { GalaxyMenuSession } from './session-context.ts';

export function createHistoryPages(session: GalaxyMenuSession) {
  async function promptHistory(onBack: Action) {
    session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    let status;
    try {
      status = await session.controllerMethod('status')();
    } catch {
      return void session.showManagedConnection(onBack);
    }
    if (version !== session.connectionGeneration) return;
    let draft: HistoryFilters = { query: '', limit: 8 };
    const ownerFields = [
      'sourceKind',
      'environment',
      'createdFrom',
      'createdBefore',
    ] as const;
    const back = () => void session.showManagedConnection(onBack);
    const current = () => version === session.connectionGeneration;
    const own = () => {
      draft.subjectId = status.subjectId;
    };
    const clean = (value: unknown) =>
      (typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : ''
      )
        .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .slice(0, 200);
    const choose = (
      field: Exclude<keyof HistoryFilters, 'limit'>,
      title: string,
      choices: string[][],
      owner = false,
    ) => {
      const routes: Routes = {};
      const options = choices.map(([value, label], index) => {
        routes[index + 1] = () => {
          if (!current()) return;
          if (value) {
            draft[field] = value;
            if (owner) own();
          } else delete draft[field];
          render();
        };
        return { number: String(index + 1), title: label, description: '' };
      });
      session.showSelect({ title, options, routes, onBack: render });
    };
    const edit = (
      field: Exclude<keyof HistoryFilters, 'limit'>,
      title: string,
      owner = false,
    ) =>
      session.showPrompt({
        title,
        placeholder: field.startsWith('created')
          ? (draft[field] ?? '').slice(0, 10)
          : (draft[field] ?? ''),
        onCancel: render,
        onConfirm: (value) => {
          if (!current()) return;
          const text = value.trim();
          if (
            field === 'query' &&
            (text.length > 200 ||
              new Set(text.toLowerCase().split(/\s+/).filter(Boolean)).size > 8)
          )
            return session.showInfo(
              'Galaxy',
              chinese
                ? '最多 200 字符、8 个空格分隔的关键词。'
                : 'Maximum 200 characters and 8 search terms.',
              render,
            );
          if (field === 'environment' && text.length > 160)
            return session.showInfo(
              'Galaxy',
              chinese
                ? '环境名称最多 160 字符。'
                : 'Environment name: maximum 160 characters.',
              render,
            );
          if (
            field === 'capabilityId' &&
            text &&
            !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(text)
          )
            return session.showInfo(
              'Galaxy',
              chinese
                ? 'Capability ID最多128字符，使用字母、数字或 : . _ / -。'
                : 'Capability ID: up to128 letters, digits or : . _ / -.',
              render,
            );
          if (field.startsWith('created') && text) {
            const iso = `${text}T00:00:00.000Z`;
            if (
              !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
              !Number.isFinite(Date.parse(iso)) ||
              new Date(iso).toISOString() !== iso
            )
              return session.showInfo(
                'Galaxy',
                chinese
                  ? '请输入有效日期，例如 2026-09-10。'
                  : 'Enter a valid date, e.g. 2026-09-10.',
                render,
              );
            draft[field] = iso;
          } else if (text) draft[field] = text;
          else delete draft[field];
          if (owner && text) own();
          render();
        },
      });
    const render = () => {
      if (!current()) return;
      const label = (zh: string, en: string) => (chinese ? zh : en);
      const summary = (field: Exclude<keyof HistoryFilters, 'limit'>) =>
        clean(draft[field] ?? label('不限', 'Any'));
      session.showSelect({
        title: label(
          'Galaxy / 履历筛选\n来源、环境、时间仅用于本人履历；日期以 UTC 零点为界。',
          'Galaxy / History filters\nSource, environment and dates filter your history. Dates use midnight UTC.',
        ),
        options: [
          {
            number: '1',
            title: label('查询范围', 'Scope'),
            description: draft.subjectId
              ? label('本人履历', 'My history')
              : label('全部可见履历', 'All visible history'),
          },
          {
            number: '2',
            title: label('关键词', 'Keywords'),
            description: summary('query'),
          },
          {
            number: '3',
            title: label('报告结果', 'Reported outcome'),
            description: summary('outcome'),
          },
          {
            number: '4',
            title: label('来源', 'Source'),
            description: summary('sourceKind'),
          },
          {
            number: '5',
            title: label('运行环境', 'Environment'),
            description: summary('environment'),
          },
          {
            number: '6',
            title: label('起始日期（包含）', 'From date (inclusive)'),
            description: summary('createdFrom'),
          },
          {
            number: '7',
            title: label('结束日期（不包含）', 'Before date (exclusive)'),
            description: summary('createdBefore'),
          },
          {
            number: '8',
            title: label('开始查询', 'Search'),
            description: label('提交以上筛选条件', 'Submit these filters'),
          },
          {
            number: '9',
            title: label(
              '能力、验证与清空',
              'Capability, verification and reset',
            ),
            description: `${summary('capabilityId')} · ${summary('verificationStrength')}`,
          },
        ],
        routes: {
          1: () => {
            if (draft.subjectId) {
              delete draft.subjectId;
              ownerFields.forEach((field) => delete draft[field]);
            } else own();
            render();
          },
          2: () =>
            edit(
              'query',
              label(
                '输入标题/摘要关键词；留空清除',
                'Title/summary keywords; empty clears',
              ),
            ),
          3: () =>
            choose('outcome', label('报告结果', 'Reported outcome'), [
              ['', label('不限', 'Any')],
              ['succeeded', label('成功', 'Succeeded')],
              ['partial', label('部分成功', 'Partial')],
              ['failed', label('失败', 'Failed')],
              ['inconclusive', label('无定论', 'Inconclusive')],
              ['conflicting', label('结果冲突', 'Conflicting')],
            ]),
          4: () =>
            choose(
              'sourceKind',
              label(
                '来源（选择后切换本人履历）',
                'Source (selecting switches to my history)',
              ),
              [
                ['', label('不限', 'Any')],
                ['local', label('本地', 'Local')],
                ['bridge', 'Bridge'],
                ['hub', 'Hub'],
              ],
              true,
            ),
          5: () =>
            edit(
              'environment',
              label(
                '完整环境名称；留空清除',
                'Full environment name; empty clears',
              ),
              true,
            ),
          6: () =>
            edit(
              'createdFrom',
              label(
                '登记起始日期 YYYY-MM-DD；留空清除',
                'Registered from YYYY-MM-DD; empty clears',
              ),
              true,
            ),
          7: () =>
            edit(
              'createdBefore',
              label(
                '登记结束日期 YYYY-MM-DD（不含）；留空清除',
                'Registered before YYYY-MM-DD (exclusive); empty clears',
              ),
              true,
            ),
          8: () => {
            if (
              draft.createdFrom &&
              draft.createdBefore &&
              draft.createdFrom >= draft.createdBefore
            )
              return session.showInfo(
                'Galaxy',
                label(
                  '结束日期必须晚于起始日期。',
                  'End date must follow start date.',
                ),
                render,
              );
            void showHistoryPage(onBack, { ...draft });
          },
          9: () =>
            session.showSelect({
              title: label(
                '更多检索条件（仍按Case ID排序）',
                'More search filters (Case ID order)',
              ),
              options: [
                {
                  number: '1',
                  title: 'Capability ID',
                  description: summary('capabilityId'),
                },
                {
                  number: '2',
                  title: label('验证强度', 'Verification strength'),
                  description: summary('verificationStrength'),
                },
                {
                  number: '3',
                  title: label('清空全部筛选', 'Clear all filters'),
                  description: '',
                },
              ],
              routes: {
                1: () =>
                  edit(
                    'capabilityId',
                    label(
                      '所需Capability ID；不代表已认证能力',
                      'Requested Capability ID; not certified proficiency',
                    ),
                  ),
                2: () =>
                  choose(
                    'verificationStrength',
                    label(
                      '当前可见证据强度',
                      'Current visible evidence strength',
                    ),
                    [
                      ['', label('不限', 'Any')],
                      [
                        'reported-only',
                        label(
                          '仅报告：此视图无当前CI Proof',
                          'Reports only: no current visible CI Proof',
                        ),
                      ],
                      [
                        'ci-execution-fact',
                        label(
                          '存在当前CI执行事实Proof',
                          'Current CI execution Proof',
                        ),
                      ],
                    ],
                  ),
                3: () => {
                  draft = { query: '', limit: 8 };
                  render();
                },
              },
              onBack: render,
            }),
        },
        onBack: back,
      });
    };
    render();
  }

  async function showHistoryPage(onBack: Action, query: HistoryFilters) {
    const connectionController = session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const back = () => {
      session.connectionGeneration++;
      session.controllerMethod('cancel')();
      void session.showManagedConnection(onBack);
    };
    const plain = (value: unknown) =>
      (typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : ''
      )
        .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
        .slice(0, 800);
    session.showInfo(
      'Galaxy',
      chinese ? '正在查询履历；Esc取消。' : 'Reading history; Esc cancels.',
      back,
    );
    try {
      const page = await session.controllerMethod('queryHistory')(query);
      if (version !== session.connectionGeneration) return;
      const items: HistoryItem[] = page.items;
      const outcomes: Record<string, [string, string]> = {
        succeeded: ['报告成功', 'Reported success'],
        partial: ['部分解决', 'Partial resolution'],
        failed: ['报告失败', 'Reported failure'],
        inconclusive: ['尚无定论', 'Inconclusive'],
        conflicting: ['结果冲突', 'Conflicting'],
      };
      const outcomeLabel = (value: unknown) =>
        outcomes[String(value)]?.[chinese ? 0 : 1] ?? plain(value);
      const refreshed = page.refresh
        ? `${chinese ? '按当前可见来源重算 / 检查时间' : 'Rebuilt from current visible sources / checked at'}: ${new Date(page.refresh.checkedAt * 1000).toISOString()}`
        : '';
      const ci = page.pageSummary?.ciSources;
      const ciSummary = ci
        ? `${chinese ? '本页 CI Proof / 来源组 / 重复记录' : 'Page CI proofs / source groups / duplicate records'}: ${ci.proofRecordCount} / ${ci.sourceGroupCount} / ${ci.duplicateProofRecordCount}; ${chinese ? '不作为独立证据计数' : 'not an independent evidence count'}`
        : '';
      const options = items.map((item, index) => ({
        number: String(index + 1),
        title: plain(item.title),
        description: `${plain(item.state)} · ${plain(item.summary)}`,
      }));
      const routes: Routes = {};
      const render = () =>
        session.showSelect({
          title: `${chinese ? 'Galaxy / 可见履历' : 'Galaxy / Visible history'}\n${chinese ? '端点报告的记录；不代表能力认证' : 'Endpoint-reported records; not capability certification'}\n${refreshed}\n${ciSummary}\n${page.search?.windowLimited ? (chinese ? '已达到本次扫描上限；请翻页继续，不代表全库无匹配。' : 'Scan window reached; continue to next page. This is not a complete search.') : ''}\n${items.length ? '' : chinese ? '本页暂无匹配履历' : 'No matching history on this page'}`,
          options,
          routes,
          onBack: back,
        });
      items.forEach((item, index) => {
        const feedback = () => {
          if (version !== session.connectionGeneration) return;
          const choices: [
            string,
            { relevance: string; helpedSelection: boolean | null } | null,
          ][] = [
            [
              chinese ? '相关，并帮助了选择' : 'Relevant and helped selection',
              { relevance: 'relevant', helpedSelection: true },
            ],
            [
              chinese
                ? '相关，但尚未帮助选择'
                : 'Relevant, has not helped selection',
              { relevance: 'relevant', helpedSelection: false },
            ],
            [
              chinese ? '不相关' : 'Not relevant',
              { relevance: 'not-relevant', helpedSelection: false },
            ],
            [
              chinese ? '不确定' : 'Unsure',
              { relevance: 'unsure', helpedSelection: null },
            ],
            [chinese ? '移除此前反馈' : 'Remove previous feedback', null],
          ];
          const routes: Routes = {};
          const options = choices.map(([title, verdict], index) => {
            routes[index + 1] = async () => {
              if (version !== session.connectionGeneration) return;
              try {
                await session.controllerMethod('recordSearchFeedback')(
                  item.caseId,
                  verdict,
                );
                if (version === session.connectionGeneration)
                  session.showInfo(
                    'Galaxy',
                    chinese
                      ? '反馈已在本机更新；不影响证明或能力评价。'
                      : 'Feedback updated locally; Proof and capability claims are unchanged.',
                    render,
                  );
              } catch {
                if (version === session.connectionGeneration)
                  session.showInfo(
                    'Galaxy',
                    chinese
                      ? '反馈未保存，请重新查询后再试。'
                      : 'Feedback not saved; query again before retrying.',
                    render,
                  );
              }
            };
            return { number: String(index + 1), title, description: '' };
          });
          session.showSelect({
            title: chinese
              ? '查询反馈（仅保存在本机）\n可按0跳过，不上传查询内容。'
              : 'Search feedback (local only)\nPress 0 to skip; search content is not uploaded.',
            options,
            routes,
            onBack: render,
          });
        };
        const actions = () => {
          const ownerReview =
            item.fieldPolicy?.view === 'owner' &&
            item.rebuild &&
            connectionController.getCase &&
            connectionController.prepareCaseReview &&
            connectionController.executeCaseReview;
          const caseModeration =
            item.rebuild && connectionController.queryModeration;
          const linked = item.collaborationContext?.items ?? [];
          void (async () => {
            try {
              const status = await session.controllerMethod('status')();
              if (version !== session.connectionGeneration) return;
              const entries: MenuOption[] = [
                {
                  number: '1',
                  title: chinese ? '返回结果列表' : 'Back to results',
                },
                {
                  number: '6',
                  title: chinese
                    ? '查看来源与完整记录'
                    : 'Inspect source and complete record',
                },
              ];
              const choices: Routes = {
                1: render,
                6: () =>
                  session.showInfo(plain(item.title), sourceText, actions),
              };
              if (connectionController.recordSearchFeedback) {
                entries.push({
                  number: '2',
                  title: chinese ? '查询反馈' : 'Search feedback',
                });
                choices[2] = feedback;
              }
              if (
                ownerReview &&
                ['case-teaser', 'consent'].every((scope) =>
                  status.scopes?.includes(scope),
                )
              ) {
                entries.push({
                  number: '3',
                  title: chinese
                    ? '纠正与争议记录（本人Case）'
                    : 'Correction and dispute records (my Case)',
                });
                choices[3] = () => {
                  const current = ++session.connectionGeneration;
                  createCaseReviewMenu({
                    controller: connectionController,
                    caseId: item.caseId,
                    sourceVersion: item.rebuild!.sourceVersion,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    isCurrent: () => current === session.connectionGeneration,
                    onBack: () => void showHistoryPage(onBack, query),
                  }).open();
                };
              }
              if (
                linked.length &&
                connectionController.getAssistance &&
                status.scopes?.includes('assistance')
              ) {
                entries.push({
                  number: '4',
                  title: chinese
                    ? '协作争议与处理'
                    : 'Collaboration disputes and moderation',
                });
                const chooseLinks = (offset = 0) => {
                  const options: MenuOption[] = [],
                    linkRoutes: Routes = {};
                  linked.slice(offset, offset + 8).forEach((link, i) => {
                    options.push({
                      number: String(i + 1),
                      title: plain(link.assistanceId),
                      description: plain(link.requestedScope),
                    });
                    linkRoutes[i + 1] = () => {
                      const current = ++session.connectionGeneration;
                      createAssistanceMenu({
                        controller: connectionController,
                        select: session.showSelect,
                        prompt: session.showPrompt,
                        info: session.showInfo,
                        language: session.activeLanguage,
                        availableScopes: status.scopes,
                        readWorkContext: session.readWorkContext,
                        isCurrent: () =>
                          current === session.connectionGeneration,
                        onBack: () => void showHistoryPage(onBack, query),
                      }).openRequest(link.assistanceId);
                    };
                  });
                  if (offset + 8 < linked.length) {
                    options.push({
                      number: '9',
                      title: chinese ? '下一页' : 'Next page',
                    });
                    linkRoutes[9] = () => chooseLinks(offset + 8);
                  }
                  session.showSelect({
                    title: chinese
                      ? '选择关联协作'
                      : 'Choose linked collaboration',
                    options,
                    routes: linkRoutes,
                    onBack: offset
                      ? () => chooseLinks(Math.max(0, offset - 8))
                      : actions,
                  });
                };
                choices[4] = () => chooseLinks();
              }
              if (caseModeration && status.scopes?.includes('moderation')) {
                entries.push({
                  number: '5',
                  title: chinese
                    ? 'Case独立争议处理'
                    : 'Case independent moderation',
                });
                choices[5] = () => {
                  const current = ++session.connectionGeneration;
                  createAssistanceMenu({
                    controller: connectionController,
                    select: session.showSelect,
                    prompt: session.showPrompt,
                    info: session.showInfo,
                    language: session.activeLanguage,
                    availableScopes: status.scopes,
                    readWorkContext: session.readWorkContext,
                    isCurrent: () => current === session.connectionGeneration,
                    onBack: () => void showHistoryPage(onBack, query),
                  }).openCaseModeration({
                    caseId: item.caseId,
                    sourceVersion: item.rebuild!.sourceVersion,
                    events: item.rebuild!.sources.events,
                  });
                };
              }
              session.showSelect({
                title: chinese ? '履历后续操作' : 'History actions',
                options: entries,
                routes: choices,
                onBack: render,
              });
            } catch {
              if (version === session.connectionGeneration)
                session.showInfo(
                  'Galaxy',
                  chinese
                    ? '请重新查询后操作。'
                    : 'Query history again before acting.',
                  render,
                );
            }
          })();
        };
        const sourceText = [
          plain(item.summary),
          `Case: ${plain(item.caseId)}`,
          ...(item.fieldPolicy
            ? [
                `${chinese ? '字段视图' : 'Field view'}: ${plain(item.fieldPolicy.view)} / ${plain(item.fieldPolicy.id)}@${item.fieldPolicy.version}`,
              ]
            : []),
          ...(item.participants ?? []).map(
            (person) =>
              `${chinese ? 'Case中声明的参与者' : 'Case-declared participant'}: ${plain(person.subjectId)} · ${plain(person.role)}`,
          ),
          ...(item.attempts ?? [])
            .filter((attempt) => attempt.configuration)
            .map(
              (attempt) =>
                `${chinese ? '尝试配置' : 'Attempt configuration'}: ${plain(attempt.id)} · ${plain(attempt.configuration?.environment)} / ${plain(attempt.configuration?.version)}`,
            ),
          ...(item.collaborationContext?.items ?? []).flatMap((link) => [
            `${chinese ? '协作来源 / 声明的能力需求（非认证）' : 'Collaboration source / declared capability requirement (not certification)'}: ${plain(link.assistanceId)} / ${plain(link.capabilityId ?? '—')}`,
            `${chinese ? '请求范围' : 'Requested scope'}: ${plain(link.requestedScope)}`,
            ...link.participantLinks.map(
              (person) =>
                `${chinese ? '签署参与记录' : 'Signed participation record'}: ${plain(person.subjectId)} · ${plain(person.role)} · ${plain(person.eventId)}`,
            ),
          ]),
          ...(item.rebuild
            ? [
                `${chinese ? '重建规则 / 来源版本' : 'Rebuild rule / source version'}: ${plain(item.rebuild.rule.id)}@${item.rebuild.rule.version} / ${item.rebuild.sourceVersion}`,
                `${chinese ? '可见内容摘要' : 'Visible content hash'}: ${plain(item.rebuild.contentHash)}`,
                `${chinese ? '与本次会话上次查询比较' : 'Compared with last query in this session'}: ${item.rebuildComparison?.state === 'unchanged' ? (chinese ? '无变化' : 'Unchanged') : item.rebuildComparison?.state === 'changed' ? (chinese ? '来源或可见内容有变化' : 'Sources or visible content changed') : chinese ? '暂无可比较记录' : 'No comparable baseline'}`,
                `${chinese ? '来源事件（最多显示最近10条）' : 'Source events (last 10 shown)'}: ${item.rebuild.sources.events.length}`,
                ...item.rebuild.sources.events
                  .slice(-10)
                  .map(
                    (event) =>
                      `${event.version} · ${plain(event.kind)} · ${plain(event.id)}`,
                  ),
              ]
            : []),
          ...item.results.flatMap((result) => [
            `${outcomeLabel(result.outcome)}: ${plain(result.summary)}${result.corrected ? (chinese ? '（有纠正）' : ' (corrected)') : ''}`,
            ...(result.failureReason
              ? [
                  `${chinese ? '失败说明' : 'Failure reason'}: ${plain(result.failureReason)}`,
                ]
              : []),
            ...(result.limitations ?? []).map(
              (value) => `${chinese ? '限制' : 'Limitation'}: ${plain(value)}`,
            ),
          ]),
          ...(item.reportedProgress
            ? [
                `${chinese ? '结果报告时间线（事件顺序；不构成能力评分）' : 'Result timeline (event order; not a capability score)'}`,
                ...item.reportedProgress.timeline.map(
                  (report) =>
                    `${report.sourceEventVersion} · ${outcomeLabel(report.outcome)} · ${plain(report.resultId)}${report.corrected ? (chinese ? '（原报告有纠正）' : ' (original report corrected)') : ''}`,
                ),
                ...item.reportedProgress.subsequentReports.map(
                  (report) =>
                    `${chinese ? '成功报告后的后续结果（回归未核验）' : 'Subsequent report after success (regression not verified)'}: ${plain(report.previousSuccessId)} → ${plain(report.resultId)} · ${report.attemptRelation === 'same-attempt' ? (chinese ? '同一尝试' : 'same attempt') : chinese ? '不同尝试' : 'different attempt'}`,
                ),
              ]
            : []),
          ...(item.corrections ?? []).map(
            (correction) =>
              `${chinese ? '纠正' : 'Correction'}: ${plain(correction.summary)}`,
          ),
          ...(item.reviews ?? []).flatMap((review) => [
            `${plain(review.type)}: ${plain(review.state)} · ${chinese ? 'Case 所有者报告' : 'Case owner reported'}`,
            ...(review.changes ?? []).map(
              (change) => `${plain(change.state)}: ${plain(change.summary)}`,
            ),
          ]),
          ...(item.proofs ?? []).map(
            (proof) =>
              `Proof: ${plain(proof.proofId)} · ${plain(proof.caseContext?.status ?? proof.status)}${proof.provenance ? '\n' + plain(proof.provenance.sourceKey) + '\n' + (proof.provenance.sourceControl?.repositoryOwner ? plain(proof.provenance.sourceControl.repositoryOwner.login) + ' / ' + proof.provenance.sourceControl.repositoryOwner.id + (chinese ? '（GitHub 所有者记录，未证明提交者控制权）' : ' (GitHub owner record; submitter control unverified)') : chinese ? '仓库所有者资料未记录' : 'Repository owner metadata not recorded') : ''}`,
          ),
          ...(item.searchExplanation
            ? [
                `${chinese ? '检索解释' : 'Search explanation'} · ${plain(item.searchExplanation.sourceType)} · ${plain(item.searchExplanation.order)}`,
                ...item.searchExplanation.textMatches.map(
                  (match) =>
                    `${plain(match.term)} → ${match.fields.map(plain).join(', ')}`,
                ),
                ...item.searchExplanation.capabilityMatches.map(
                  (match) =>
                    `Capability ${plain(match.capabilityId)} → Assistance ${plain(match.assistanceId)} (${chinese ? '请求者声明的工作需求' : 'requester-declared requirement'})`,
                ),
                `${chinese ? '当前可见验证强度' : 'Current visible verification strength'}: ${plain(item.searchExplanation.verification.strength)}`,
                `${chinese ? '检查时间' : 'Checked at'}: ${new Date(item.searchExplanation.checkedAt * 1000).toISOString()}`,
                ...item.searchExplanation.limitations.map(plain),
              ]
            : []),
          ...(item.moderationContext?.items.length
            ? [
                chinese
                  ? '独立处理沿革（按授权展示；过程决定不等于自动验证）'
                  : 'Independent review history (authorized view; decisions are not automatic verification)',
                ...item.moderationContext.items.flatMap((record) => [
                  `${plain(record.reportId)} · ${plain(record.state)}${record.paused ? ' · paused' : ''}`,
                  ...record.events.map(
                    (event) =>
                      `${plain(event.kind)} · ${plain(event.verdict)} · ${plain(event.summary)}`,
                  ),
                  ...(record.revalidation
                    ? [
                        `${chinese ? 'Evidence验证轮次' : 'Evidence verification round'}: ${record.revalidation.generation} · ${plain(record.revalidation.state)}`,
                      ]
                    : []),
                ]),
              ]
            : []),
          ...item.matchReasons.map(plain),
        ].join('\n');
        routes[index + 1] = () =>
          session.showInfo(
            plain(item.title),
            [
              sourceReadingText(
                { type: 'history', record: item, summary: item.summary },
                (cn: string, en: string) => (chinese ? cn : en),
                plain,
              ),
              ...(item.corrections?.length
                ? [
                    chinese
                      ? '原工作有纠正，具体内容可从来源记录继续阅读。'
                      : 'The original work has corrections. Read their source records for details.',
                  ]
                : []),
              ...(item.moderationContext?.items.some((record) => record.paused)
                ? [
                    chinese
                      ? '当前可见处理记录标明暂停，请查看处理详情后继续。'
                      : 'A visible handling record reports a pause. Inspect its details before continuing.',
                  ]
                : []),
            ].join('\n\n'),
            actions,
          );
      });
      if (page.nextCursor) {
        const number = String(items.length + 1);
        options.push({
          number,
          title: chinese ? '下一页' : 'Next page',
          description: '',
        });
        routes[number] = () =>
          void showHistoryPage(onBack, { ...query, after: page.nextCursor });
      }
      render();
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese
            ? '查询未完成，请检查会话权限或关键词。'
            : 'Query incomplete; check session scopes or search terms.',
          back,
        );
    }
  }
  return { promptHistory, showHistoryPage };
}
