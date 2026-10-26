export function createAssistanceModerationMenu(session) {
  function moderationList(target, after, back = session.home) {
    const filter =
      typeof target === 'string' ? { assistanceId: target } : (target ?? {});
    void session.run(
      () =>
        session.controller.queryModeration({
          ...filter,
          ...(after ? { after } : {}),
          limit: 8,
        }),
      (page) => {
        const entries = page.items.map((item) => [
          session.plain(item.reportId),
          () =>
            moderationDetail(item.reportId, () =>
              moderationList(target, after, back),
            ),
          `${item.caseId ? 'Case' : 'Assistance'} · ${session.plain(item.state)} · ${item.paused ? session.label('已暂停', 'Paused') : session.label('未暂停', 'Not paused')}`,
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批', 'Next results'),
            () => moderationList(target, page.nextAfter, back),
          ]);
        session.menu(
          session.label('举报与处理记录', 'Reports and moderation'),
          entries,
          back,
        );
      },
      back,
    );
  }

  function moderationDetail(reportId, back) {
    void session.run(
      () => session.controller.getModeration(reportId),
      (record) => {
        const refresh = () => moderationDetail(reportId, back),
          entries = [];
        const action = (kind) =>
          session.form(
            'Galaxy',
            [
              [
                'summary',
                session.label(
                  '处理或申诉说明',
                  'Decision or appeal explanation',
                ),
              ],
              ...(kind === 'resolve'
                ? [['verdict', 'upheld / dismissed']]
                : []),
            ],
            (value) =>
              session.confirm(
                {
                  kind,
                  reportId,
                  ...(kind === 'revalidate'
                    ? { evidenceId: record.revalidation.evidenceId }
                    : {}),
                  ...value,
                },
                refresh,
                'moderation',
              ),
            refresh,
          );
        if (session.controller.prepareModeration && session.has('consent')) {
          if (record.canSupplement)
            entries.push([
              session.label(
                '补充说明与引用',
                'Supplement statement and references',
              ),
              () =>
                session.form(
                  'Galaxy',
                  [
                    [
                      'summary',
                      session.label('补充说明', 'Supplement statement'),
                    ],
                  ],
                  (value) => {
                    const references = [];
                    const render = () => {
                      const choices = [
                        [
                          session.label('确认补充', 'Review supplement'),
                          () =>
                            session.confirm(
                              {
                                kind: 'supplement',
                                reportId,
                                summary: value.summary,
                                references: [...references],
                              },
                              refresh,
                              'moderation',
                            ),
                        ],
                      ];
                      if (references.length < 8)
                        for (const kind of [
                          'case',
                          'evidence',
                          'proof',
                          'event',
                          'artifact',
                        ])
                          choices.push([
                            `${session.label('添加引用', 'Add reference')}: ${kind}`,
                            () =>
                              session.form(
                                'Galaxy',
                                [
                                  [
                                    'reference',
                                    kind === 'artifact'
                                      ? session.label(
                                          '工件 SHA-256 摘要',
                                          'Artifact SHA-256 digest',
                                        )
                                      : `${kind} ID`,
                                  ],
                                ],
                                (input) => {
                                  references.push(
                                    kind === 'artifact'
                                      ? { kind, sha256: input.reference.trim() }
                                      : { kind, id: input.reference.trim() },
                                  );
                                  render();
                                },
                                render,
                              ),
                          ]);
                      if (references.length)
                        choices.push([
                          session.label(
                            '移除最后一项',
                            'Remove last reference',
                          ),
                          () => {
                            references.pop();
                            render();
                          },
                        ]);
                      session.menu(
                        `${session.label('补充引用（最多8项，不上传工件）', 'References (up to 8; no artifact upload)')}\n${references.map((item) => `${item.kind}: ${session.plain(item.id ?? item.sha256)}`).join('\n')}`,
                        choices,
                        refresh,
                      );
                    };
                    render();
                  },
                  refresh,
                ),
            ]);
          if (record.canCorrectEventIds?.length)
            entries.push([
              session.label('纠正自己的说明', 'Correct my statement'),
              () =>
                session.menu(
                  session.label(
                    '选择自己的原记录',
                    'Choose your original statement',
                  ),
                  record.canCorrectEventIds.map((id) => [
                    session.plain(id),
                    () =>
                      session.form(
                        'Galaxy',
                        [
                          [
                            'summary',
                            session.label(
                              '纠正后的说明',
                              'Corrected statement',
                            ),
                          ],
                          [
                            'reason',
                            session.label(
                              '更改原因；不会改写处理结论',
                              'Reason; does not change the decision',
                            ),
                          ],
                        ],
                        (value) =>
                          session.confirm(
                            {
                              kind: 'correct',
                              reportId,
                              correctsEventId: id,
                              ...value,
                            },
                            refresh,
                            'moderation',
                          ),
                        refresh,
                      ),
                  ]),
                  refresh,
                ),
            ]);
          if (record.canModerate) {
            entries.push([
              record.caseId
                ? record.paused
                  ? session.label(
                      '解除Case关联协作暂停',
                      'Resume Case-linked work',
                    )
                  : session.label(
                      '暂停Case关联协作与衍生资格',
                      'Hold Case-linked work and eligibility',
                    )
                : record.paused
                  ? session.label('恢复协作', 'Resume')
                  : session.label('暂停协作', 'Pause'),
              () => action(record.paused ? 'resume' : 'pause'),
            ]);
            if (record.state !== 'resolved')
              entries.push([
                session.label('记录处理结论', 'Resolve report'),
                () => action('resolve'),
              ]);
          }
          if (record.canAppeal && record.state === 'resolved')
            entries.push([
              session.label('提出申诉', 'Appeal'),
              () => action('appeal'),
            ]);
          if (
            record.canRevalidate &&
            !['pending', 'running'].includes(record.revalidation?.state)
          )
            entries.push([
              session.label('重新验证此Evidence', 'Revalidate this Evidence'),
              () => action('revalidate'),
            ]);
          if (record.canInviteVerifier)
            entries.push([
              session.label('邀请验证者参与', 'Invite a verifier'),
              () =>
                session.form(
                  'Galaxy',
                  [
                    ['verifierId', 'Galaxy ID'],
                    [
                      'scope',
                      session.label(
                        '复核范围；不授予来源或Context权限',
                        'Review scope; no source or Context access is granted',
                      ),
                    ],
                    [
                      'minutes',
                      session.label(
                        '邀请有效分钟数（1–60，仍受授权有效期限制）',
                        'Invitation minutes (1–60, subject to Consent expiry)',
                      ),
                    ],
                    [
                      'summary',
                      session.label('邀请说明', 'Invitation explanation'),
                    ],
                  ],
                  (value) => {
                    const minutes = Number(value.minutes);
                    if (
                      !Number.isInteger(minutes) ||
                      minutes < 1 ||
                      minutes > 60
                    )
                      return session.message(
                        session.label(
                          '请输入1至60的整数分钟数。',
                          'Enter an integer from 1 to 60.',
                        ),
                        refresh,
                      );
                    session.confirm(
                      {
                        kind: 'invite-verifier',
                        reportId,
                        verifierId: value.verifierId.trim(),
                        scope: value.scope,
                        summary: value.summary,
                        expiresAt: Math.floor(Date.now() / 1000) + minutes * 60,
                      },
                      refresh,
                      'moderation',
                    );
                  },
                  refresh,
                ),
            ]);
          for (const [enabled, kind, title] of [
            [
              record.canAcceptVerifier,
              'accept-verifier',
              session.label('接受验证者邀请', 'Accept verifier invitation'),
            ],
            [
              record.canDeclineVerifier,
              'decline-verifier',
              session.label('拒绝验证者邀请', 'Decline verifier invitation'),
            ],
            [
              record.canWithdrawVerifier,
              'withdraw-verifier',
              session.label('退出本次复核', 'Withdraw from this review'),
            ],
          ])
            if (enabled) entries.push([title, () => action(kind)]);
          if (record.canSubmitVerification)
            entries.push([
              session.label('提交复核意见', 'Submit verification response'),
              () =>
                session.menu(
                  session.label(
                    '复核意见；不自动认定能力或改写Evidence',
                    'Review opinion; does not certify capability or rewrite Evidence',
                  ),
                  ['supported', 'unsupported', 'inconclusive'].map(
                    (conclusion) => [
                      conclusion,
                      () =>
                        session.form(
                          'Galaxy',
                          [
                            [
                              'summary',
                              session.label(
                                '复核依据与限制',
                                'Review basis and limitations',
                              ),
                            ],
                          ],
                          (value) =>
                            session.confirm(
                              {
                                kind: 'verification-response',
                                reportId,
                                conclusion,
                                summary: value.summary,
                                references: [],
                              },
                              refresh,
                              'moderation',
                            ),
                          refresh,
                        ),
                    ],
                  ),
                  refresh,
                ),
            ]);
        }
        if (record.verifierParticipation?.own)
          entries.push([
            session.label(
              '查看我的验证者参与范围',
              'My verifier participation scope',
            ),
            () =>
              session.message(
                JSON.stringify(record.verifierParticipation, null, 2) +
                  '\n' +
                  session.label(
                    '本人签署的复核意见不等于独立能力认证；可拒绝、退出、补充说明和申诉。',
                    'A signed review is not independent capability certification; decline, withdrawal, statements and appeal remain available.',
                  ),
                refresh,
              ),
          ]);
        entries.push([
          session.label('查看处理事件', 'View decisions'),
          () =>
            session.message(
              record.events
                .map(
                  (e) =>
                    `${session.plain(e.id)} · ${session.plain(e.kind)} · ${session.plain(e.summary)} · ${session.plain(e.verdict ?? e.conclusion)}\n${e.scope ? `${session.label('复核范围', 'Review scope')}: ${session.plain(e.scope)} · ${session.plain(e.verifierId)}` : ''}${e.correctsEventId ? `${session.label('纠正对象', 'Corrects')}: ${session.plain(e.correctsEventId)} · ${session.plain(e.reason)}` : ''}${e.references ? `\n${session.label('引用（未自动核验）', 'References (not automatically verified)')}: ${session.plain(JSON.stringify(e.references))}` : ''}`,
                )
                .join('\n'),
              refresh,
            ),
        ]);
        if (record.caseId)
          entries.push([
            session.label(
              '查看Case来源与报告版本',
              'View Case source and reported version',
            ),
            () =>
              session.message(
                record.source
                  ? JSON.stringify(record.source, null, 2)
                  : session.label(
                      '当前无权查看完整来源；处理权限不授予来源访问。',
                      'Source unavailable; moderation authority does not grant source access.',
                    ),
                refresh,
              ),
          ]);
        if (record.revalidation)
          entries.push([
            session.label(
              '查看Evidence验证轮次',
              'View Evidence verification round',
            ),
            () =>
              session.message(
                JSON.stringify(record.revalidation, null, 2),
                refresh,
              ),
          ]);
        session.menu(
          `${session.plain(record.reportId)}\n${record.caseId ? `Case: ${session.plain(record.caseId)}\n` : ''}${session.plain(record.state)}\n${record.report ? session.plain(record.report.summary) : session.label('举报正文不可见', 'Report body unavailable')}\n${session.label('不保证响应、免费解决或交易保障', 'No guaranteed response, free resolution or transaction protection')}`,
          entries,
          back,
        );
      },
      back,
    );
  }

  function caseModeration(source) {
    const back = () => caseModeration(source);
    if (!session.has('moderation') || !session.controller.queryModeration) {
      session.message(
        session.label('需要争议处理Scope。', 'Moderation scope required.'),
        session.leave,
      );
      return;
    }
    const entries = [
      [
        session.label('Case举报与处理记录', 'Case reports and decisions'),
        () => moderationList({ caseId: source.caseId }, undefined, back),
      ],
    ];
    if (session.has('consent') && session.controller.prepareModeration)
      entries.push([
        session.label('就此Case提出争议', 'Report this Case'),
        () =>
          session.menu(
            session.label('选择争议来源事件', 'Choose the source event'),
            source.events.flatMap((event) => [
              [
                `${session.plain(event.kind)} · ${session.plain(event.id)}`,
                () =>
                  session.form(
                    session.label('Case争议', 'Case report'),
                    [
                      [
                        'category',
                        'abuse / privacy / misrepresentation / scope / other / malicious-artifact / data-extraction / work-fraud / false-verification',
                      ],
                      [
                        'summary',
                        session.label(
                          '争议说明；仅发送给配置的处理人',
                          'Report summary; shared only with configured moderators',
                        ),
                      ],
                    ],
                    (value) =>
                      session.confirm(
                        {
                          kind: 'report',
                          caseId: source.caseId,
                          caseVersion: source.sourceVersion,
                          targetEventId: event.id,
                          ...value,
                        },
                        back,
                        'moderation',
                      ),
                    back,
                  ),
              ],
              ...(event.kind === 'result'
                ? [
                    [
                      `${session.label('此结果的Evidence争议', 'Dispute Evidence for result')} · ${session.plain(event.id)}`,
                      () =>
                        session.form(
                          session.label('Evidence争议', 'Evidence dispute'),
                          [
                            [
                              'evidenceId',
                              session.label(
                                '关联且你有权读取的Evidence ID',
                                'Linked Evidence ID you are authorized to read',
                              ),
                            ],
                            [
                              'summary',
                              session.label(
                                '需要重验的原因',
                                'Reason to revalidate',
                              ),
                            ],
                          ],
                          (value) =>
                            session.confirm(
                              {
                                kind: 'report',
                                caseId: source.caseId,
                                caseVersion: source.sourceVersion,
                                targetEventId: event.id,
                                category: 'false-verification',
                                ...value,
                              },
                              back,
                              'moderation',
                            ),
                          back,
                        ),
                    ],
                  ]
                : []),
            ]),
            back,
          ),
      ]);
    session.menu(
      `${session.label('Case独立处理', 'Case independent review')}\n${session.plain(source.caseId)} · v${session.plain(source.sourceVersion)}\n${session.label('提出争议不等于裁决；原始Case及CI签名事实保留。', 'A report is not a decision; source Case and signed CI facts are retained.')}`,
      entries,
      session.leave,
    );
  }
  return { moderationList, moderationDetail, caseModeration };
}
