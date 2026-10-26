import { createExistingRecordSelection } from '../existing-record-selection.mjs';

export function createAssistanceQualificationsMenu(session) {
  function qualificationEvidence(done, back) {
    const evidence = { proofIds: [], assistanceIds: [] },
      records = createExistingRecordSelection({
        controller: session.controller,
        menu: session.menu,
        message: session.message,
        run: session.run,
        label: session.label,
        plain: session.plain,
      });
    const choose = (kind, key) =>
      void session.run(
        () => session.controller.status?.(),
        (status) => {
          if (kind === 'proof' && !status?.subjectId)
            return session.message(
              session.label(
                '当前未取得本人身份，请先恢复原连接。',
                'Your identity is currently unavailable. Restore the original connection first.',
              ),
              show,
            );
          records.select(
            kind,
            (item) => {
              if (!evidence[key].includes(item.id)) evidence[key].push(item.id);
              show();
            },
            show,
            {
              subjectId: status?.subjectId,
              assistanceView: 'participating',
              filter: (record) =>
                kind !== 'assistance' || record.state === 'accepted',
            },
          );
        },
        show,
      );
    const show = () =>
      session.menu(
        session.label(
          '选择已有参与依据',
          'Choose existing participation sources',
        ),
        [
          [
            session.label('使用已选来源', 'Use selected sources'),
            () => done(evidence),
            session.label('CI 来源', 'CI sources') +
              ': ' +
              evidence.proofIds.length +
              ' · ' +
              session.label('已验收协作', 'Accepted collaborations') +
              ': ' +
              evidence.assistanceIds.length,
          ],
          ...(session.controller.querySearch && evidence.proofIds.length < 16
            ? [
                [
                  session.label('选择本人 CI 来源', 'Choose my CI sources'),
                  () => choose('proof', 'proofIds'),
                ],
              ]
            : []),
          ...(session.controller.queryAssistance &&
          evidence.assistanceIds.length < 16
            ? [
                [
                  session.label(
                    '选择本人已验收协作',
                    'Choose my accepted collaborations',
                  ),
                  () => choose('assistance', 'assistanceIds'),
                ],
              ]
            : []),
          [
            session.label(
              '使用已掌握的原引用',
              'Use original references you already hold',
            ),
            () =>
              session.form(
                session.label('已有来源引用', 'Existing source references'),
                [
                  [
                    'proofIds',
                    session.label(
                      '已有 CI 来源引用，逗号分隔',
                      'Existing CI references, comma separated',
                    ),
                    evidence.proofIds.join(','),
                  ],
                  [
                    'assistanceIds',
                    session.label(
                      '已有验收工作引用，逗号分隔',
                      'Existing accepted work references, comma separated',
                    ),
                    evidence.assistanceIds.join(','),
                  ],
                ],
                (value) => {
                  for (const key of Object.keys(evidence))
                    evidence[key] = [
                      ...new Set(
                        value[key]
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      ),
                    ];
                  show();
                },
                show,
              ),
          ],
        ],
        back,
      );
    show();
  }

  function qualifications() {
    void session.run(
      () => session.controller.qualificationPolicies(),
      (result) =>
        session.menu(
          session.label('参与条件', 'Participation requirements'),
          result.policies.map((p) => [
            session.plain(p.title),
            () =>
              qualificationEvidence(
                (evidence) =>
                  void session.run(
                    () =>
                      session.controller.evaluateQualification({
                        policyId: p.id,
                        policyVersion: p.version,
                        capabilityId: p.capabilityId,
                        evidence,
                      }),
                    (result) =>
                      session.menu(
                        `${session.plain(p.title)}\n${result.eligible ? session.label('符合此次参与条件', 'Eligible for this participation') : session.label('暂不符合此次参与条件', 'Not currently eligible for this participation')}\n${result.reasons.map(session.plain).join('\n')}\n${session.label('已验收工作', 'Accepted work')}: ${result.acceptedCollaborations?.length ?? 0} · ${session.label('CI 来源', 'CI sources')}: ${result.proofs?.length ?? 0}\n${session.label('该结论仅适用于这份参与政策，不是个人能力认证。', 'This conclusion applies to this participation policy; it does not certify individual capability.')}`,
                        [
                          [
                            session.label(
                              '政策与来源详情',
                              'Policy and source details',
                            ),
                            () =>
                              session.message(
                                JSON.stringify({ policy: p, result }, null, 2),
                                qualifications,
                              ),
                          ],
                          [session.label('继续', 'Continue'), qualifications],
                        ],
                        qualifications,
                      ),
                    qualifications,
                  ),
                qualifications,
              ),
            session.label('版本 ', 'Version ') + session.plain(p.version),
          ]),
        ),
    );
  }

  function requesterFacts(assistanceId, after, back) {
    void session.run(
      () =>
        session.controller.queryRequesterHistoryFacts({
          assistanceId,
          limit: 8,
          ...(after ? { after } : {}),
        }),
      (page) => {
        const refresh = () => requesterFacts(assistanceId, after, back);
        const entries = [
          [
            session.label(
              '查看请求描述与响应来源',
              'Request description and response sources',
            ),
            () =>
              session.message(
                [
                  session.label('工作情况', 'Work context') +
                    '\n' +
                    session.plain(page.description.problem),
                  session.label('希望得到的协助', 'Requested help') +
                    '\n' +
                    session.plain(page.description.scope),
                  ...page.description.attemptedApproaches.map(session.plain),
                  `${session.label('可见响应间隔（秒）', 'Visible response interval (seconds)')}: ${page.responseSeconds ?? session.label('无可见记录', 'No visible record')}`,
                ].join('\n'),
                refresh,
              ),
          ],
          ...page.facts.map((fact) => [
            `${session.eventName(fact.kind)} · ${new Date(fact.at * 1000).toISOString()}`,
            () =>
              session.menu(
                `${session.eventName(fact.kind)}\n${session.plain(fact.summary)}\n${new Date(fact.at * 1000).toISOString()}${fact.descriptionClarity ? '\n' + session.clarityName(fact.descriptionClarity) : ''}${fact.scopeMatched === undefined ? '' : '\n' + session.label(fact.scopeMatched ? '符合协作范围' : '与协作范围不符', fact.scopeMatched ? 'Scope matched' : 'Scope differed')}`,
                [
                  [
                    session.label('来源详情', 'Source details'),
                    () =>
                      session.message(JSON.stringify(fact, null, 2), refresh),
                  ],
                  [session.label('继续查看', 'Keep reading'), refresh],
                ],
                refresh,
              ),
          ]),
        ];
        entries.push([
          session.label('来源与完整可见记录', 'Source and full visible record'),
          () => session.message(JSON.stringify(page, null, 2), refresh),
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批事实', 'Next facts'),
            () => requesterFacts(assistanceId, page.nextAfter, back),
          ]);
        session.menu(
          `${session.plain(page.title)}\n${session.label('当前可见事实', 'Currently visible facts')}: ${page.visibleFactCount}\n${session.label('验收／取消／争议事件', 'Acceptance / cancellation / dispute events')}: ${page.counts.acceptances} / ${page.counts.cancellations} / ${page.counts.disputes}\n${session.label('重复验收仍属于同一个请求；提供者反馈是其本人评价。', 'Repeated acceptance belongs to the same request; provider feedback is their own assessment.')}`,
          entries,
          back,
        );
      },
      back,
    );
  }

  function requesterHistory(subjectId, after) {
    const criteria = {
      limit: 8,
      ...(subjectId ? { subjectId } : {}),
      ...(after ? { after } : {}),
    };
    void session.run(
      () => session.controller.queryRequesterHistory(criteria),
      (page) => {
        const entries = page.items.map((item) => [
          session.plain(item.title),
          () =>
            item.factsSupported === 1 &&
            session.controller.queryRequesterHistoryFacts
              ? requesterFacts(item.assistanceId, undefined, () =>
                  requesterHistory(subjectId, after),
                )
              : void session.run(
                  () => session.controller.queryRequesterHistory(criteria),
                  (current) => {
                    const fresh = current.items.find(
                        (row) => row.assistanceId === item.assistanceId,
                      ),
                      back = () => requesterHistory(subjectId, after);
                    if (!fresh)
                      return session.message(
                        session.label(
                          '这份记录当前已不可读，请返回查看当前记录。',
                          'This record is no longer readable. Return to the current records.',
                        ),
                        back,
                      );
                    const body = [
                      session.requestText(fresh.description ?? {}),
                      ...(fresh.facts ?? []).map((fact) =>
                        [
                          session.eventName(fact.kind),
                          fact.summary ? session.plain(fact.summary) : '',
                          fact.descriptionClarity
                            ? session.label('描述', 'Description') +
                              '：' +
                              session.clarityName(fact.descriptionClarity)
                            : '',
                          fact.scopeMatched === undefined
                            ? ''
                            : session.label(
                                fact.scopeMatched
                                  ? '符合协作范围'
                                  : '与协作范围不符',
                                fact.scopeMatched
                                  ? 'Scope matched'
                                  : 'Scope differed',
                              ),
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      ),
                    ]
                      .filter(Boolean)
                      .join('\n\n');
                    const show = () =>
                      session.menu(
                        session.plain(fresh.title),
                        [
                          [
                            session.label(
                              '继续查看求助经历',
                              'Continue request history',
                            ),
                            back,
                          ],
                          [
                            session.label(
                              '来源与完整记录',
                              'Source and full record',
                            ),
                            () =>
                              session.message(
                                JSON.stringify(fresh, null, 2),
                                show,
                              ),
                          ],
                        ],
                        back,
                      );
                    const version = session.generation;
                    session.info(session.plain(fresh.title), body, () => {
                      if (session.alive() && session.generation === version)
                        show();
                    });
                  },
                  () => requesterHistory(subjectId, after),
                ),
          session.plain(item.description?.scope),
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批记录', 'Next records'),
            () => requesterHistory(subjectId, page.nextAfter),
          ]);
        entries.push([
          session.label(
            '查看其他身份的记录',
            'View another identity’s records',
          ),
          () =>
            session.form(
              session.label('原身份引用', 'Original identity reference'),
              [
                [
                  'subjectId',
                  session.label(
                    '已掌握的请求者稳定身份',
                    'Known requester identity',
                  ),
                ],
              ],
              (value) => requesterHistory(value.subjectId),
              () => requesterHistory(subjectId, after),
            ),
        ]);
        session.menu(
          session.label('求助经历', 'Request history'),
          entries,
          session.more,
        );
      },
    );
  }
  return {
    qualificationEvidence,
    qualifications,
    requesterFacts,
    requesterHistory,
  };
}
