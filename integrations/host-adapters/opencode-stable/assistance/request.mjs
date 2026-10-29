import { publicContributionEventKinds } from '../../../../packages/galaxy-contracts/src/assistance-schema.mjs';

export function createAssistanceRequestMenu(session) {
  function detail(id, back = session.home, readFirst = true) {
    void session.run(
      () => session.controller.getAssistance(id),
      (record) => {
        const requester = record.view === 'requester',
          provider = record.view === 'selected-provider';
        const reload = () => detail(id, back, false),
          entries = [];
        const command = (event) => {
          if (
            session.controller.createAssistanceEventDraft &&
            [
              'select',
              'shortlist',
              'confirm',
              'confirm-scope',
              'expire',
              'confirm-resolution',
            ].includes(event.kind)
          ) {
            const { kind, ...target } = event;
            return session
              .drafts()
              .createEvent({ record, eventKind: kind, target });
          }
          if (
            record.request.visibility === 'Public' &&
            publicContributionEventKinds.includes(event.kind)
          )
            return session.menu(
              session.label(
                '此次贡献事件的可见性',
                'Visibility of this contribution event',
              ),
              [
                [
                  session.label(
                    '私有：仅协作参与者',
                    'Private: collaboration participants',
                  ),
                  () => session.confirm({ assistanceId: id, event }, reload),
                ],
                [
                  session.label(
                    '公开：用于公开履历',
                    'Public: available for public history',
                  ),
                  () =>
                    session.confirm(
                      { assistanceId: id, event, eventVisibility: 'Public' },
                      reload,
                    ),
                  session.label(
                    '仅本次事件；下一步审阅全部内容并确认。',
                    'This event only; review all content and confirm next.',
                  ),
                ],
              ],
              reload,
            );
          session.confirm({ assistanceId: id, event }, reload);
        };
        const fields = (
          kind,
          prompts,
          extra = {},
          convert = (values) => values,
        ) =>
          session.controller.createAssistanceEventDraft
            ? session
                .drafts()
                .createEvent({ record, eventKind: kind, target: extra })
            : session.form(
                kind,
                prompts,
                (values) => command({ kind, ...extra, ...convert(values) }),
                reload,
              );
        const choice = (kind, offers) =>
          session.menu(
            session.label('选择申请', 'Choose offer'),
            offers.map((offer) => [
              session.plain(offer.providerId),
              () =>
                command({
                  kind,
                  ...(kind === 'shortlist'
                    ? {
                        offerIds: [
                          ...new Set([...(record.shortlist ?? []), offer.id]),
                        ],
                      }
                    : { offerId: offer.id }),
                }),
              `${session.plain(offer.proposal)} · ${session.plain(offer.scope)} · ${session.plain(JSON.stringify(offer.quote))}`,
            ]),
            reload,
          );
        if (
          session.controller.prepareCollaboration &&
          session.has('consent') &&
          !record.paused
        ) {
          if (record.state === 'open' && requester) {
            const offers = record.offers.filter((offer) => !offer.withdrawn);
            entries.push([
              session.label('邀请参与者', 'Invite participant'),
              () =>
                fields('invite', [
                  ['participantId', 'Galaxy ID'],
                  ['note', session.label('邀请说明', 'Invitation note')],
                ]),
            ]);
            if (offers.length)
              entries.push([
                session.label('查看申请并选择', 'Review and select offer'),
                () => choice('select', offers),
              ]);
            if (offers.length > 1)
              entries.push([
                session.label('比较候选人', 'Compare candidates'),
                () => choice('shortlist', offers),
              ]);
          }
          if (
            record.state === 'open' &&
            !requester &&
            !record.offers.some((offer) => !offer.withdrawn)
          )
            entries.push([
              session.label('申请协助', 'Apply'),
              () =>
                session.controller.createAssistanceEventDraft
                  ? session.drafts().createEvent({ record, eventKind: 'offer' })
                  : session.form(
                      session.label('申请', 'Offer'),
                      [
                        ['proposal', session.label('方案说明', 'Proposal')],
                        [
                          'scope',
                          session.label('可承担的范围', 'Offered scope'),
                        ],
                      ],
                      (values) => {
                        const submit = (evidence) => {
                          const fields = {
                            ...values,
                            ...(evidence
                              ? { qualificationEvidence: evidence }
                              : {}),
                          };
                          if (record.request.collaboration === 'basic-bounty')
                            session.budget(
                              (quote) =>
                                command({
                                  kind: 'offer',
                                  ...fields,
                                  ...(quote ? { quote } : {}),
                                }),
                              reload,
                              true,
                            );
                          else command({ kind: 'offer', ...fields });
                        };
                        if (record.request.qualification)
                          session.qualificationEvidence(submit, reload);
                        else submit();
                      },
                      reload,
                    ),
            ]);
          if (
            !requester &&
            ['open', 'awaiting-confirmation'].includes(record.state)
          ) {
            const own = record.offers.find((offer) => !offer.withdrawn);
            if (own)
              entries.push([
                session.label('撤回申请', 'Withdraw offer'),
                () =>
                  fields(
                    'withdraw-offer',
                    [['reason', session.label('原因', 'Reason')]],
                    { offerId: own.id },
                  ),
              ]);
          }
          if (provider && record.state === 'awaiting-confirmation')
            entries.push([
              session.label('确认参与', 'Confirm participation'),
              () => command({ kind: 'confirm' }),
            ]);
          if (provider && record.state === 'awaiting-scope-confirmation')
            entries.push([
              session.label('确认范围变更', 'Confirm scope change'),
              () => command({ kind: 'confirm-scope' }),
            ]);
          if (requester && record.state === 'active')
            entries.push([
              session.label('提出范围变更', 'Change scope'),
              () =>
                fields('change-scope', [
                  ['scope', session.label('新范围', 'New scope')],
                  ['reason', session.label('原因', 'Reason')],
                ]),
            ]);
          if (
            provider &&
            (record.state === 'active' ||
              (record.state === 'delivered' &&
                record.eventFeatures?.deliveryCaseReview === 1))
          )
            entries.push([
              session.label('提交交付', 'Deliver'),
              () =>
                fields(
                  'deliver',
                  [
                    ['attemptId', 'Attempt ID'],
                    ['summary', session.label('交付说明', 'Delivery summary')],
                    [
                      'evidenceIds',
                      session.label(
                        'Evidence ID，逗号分隔，可留空',
                        'Evidence IDs, comma separated, optional',
                      ),
                    ],
                  ],
                  {},
                  (values) => ({
                    ...values,
                    evidenceIds: values.evidenceIds
                      .split(/[,，]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }),
                ),
            ]);
          if (requester && record.state === 'delivered')
            entries.push([
              session.label('验收交付', 'Accept delivery'),
              () =>
                fields(
                  'accept',
                  [
                    [
                      'summary',
                      session.label('验收说明', 'Acceptance summary'),
                    ],
                  ],
                  { deliveryId: record.delivery.id },
                ),
            ]);
          if (
            (requester || provider) &&
            [
              'open',
              'awaiting-confirmation',
              'active',
              'awaiting-scope-confirmation',
              'delivered',
            ].includes(record.state)
          )
            entries.push([
              session.label('取消协作', 'Cancel collaboration'),
              () =>
                fields('cancel', [['reason', session.label('原因', 'Reason')]]),
            ]);
          if (
            requester &&
            ['open', 'awaiting-confirmation'].includes(record.state) &&
            record.request.enrollmentExpiresAt <= Date.now() / 1000
          )
            entries.push([
              session.label('记录招募到期', 'Record expiration'),
              () => command({ kind: 'expire' }),
            ]);
          if (
            (requester || provider) &&
            [
              'active',
              'awaiting-scope-confirmation',
              'delivered',
              'accepted',
              'resolved',
            ].includes(record.state)
          )
            entries.push([
              session.label('提出争议', 'Raise dispute'),
              () =>
                fields('dispute', [
                  ['reason', session.label('原因', 'Reason')],
                ]),
            ]);
          if (
            (requester || provider) &&
            ['disputed', 'awaiting-resolution-confirmation'].includes(
              record.state,
            )
          )
            entries.push([
              session.label('提出解决方案', 'Propose resolution'),
              () =>
                fields('propose-resolution', [
                  ['summary', session.label('解决方案', 'Resolution')],
                ]),
            ]);
          if (
            (requester || provider) &&
            record.eventFeatures?.resumeWorkResolution === 1 &&
            ['disputed', 'awaiting-resolution-confirmation'].includes(
              record.state,
            )
          )
            entries.push([
              session.label('提出继续工作方案', 'Propose resuming work'),
              () =>
                fields(
                  'propose-resolution',
                  [
                    [
                      'summary',
                      session.label(
                        '继续工作的方案；双方确认后重新交付与验收',
                        'Plan to resume; both parties confirm before a new delivery and acceptance',
                      ),
                    ],
                  ],
                  { outcome: 'resume-work' },
                ),
            ]);
          if (
            provider &&
            ['accepted', 'canceled', 'resolved'].includes(record.state) &&
            !record.events?.some(
              (item) => item.event.kind === 'requester-feedback',
            )
          )
            entries.push([
              session.label('记录请求者协作反馈', 'Record requester feedback'),
              () =>
                session.controller.createAssistanceEventDraft
                  ? session
                      .drafts()
                      .createEvent({ record, eventKind: 'requester-feedback' })
                  : session.form(
                      session.label(
                        '协作反馈（提供者评价）',
                        'Feedback (provider-reported)',
                      ),
                      [
                        [
                          'descriptionClarity',
                          session.label(
                            '描述清晰度：clear / partly-clear / unclear',
                            'Description clarity: clear / partly-clear / unclear',
                          ),
                        ],
                        [
                          'scopeMatched',
                          session.label(
                            '实际工作是否符合范围：yes / no',
                            'Did work match scope: yes / no',
                          ),
                        ],
                        ['note', session.label('来源说明', 'Feedback note')],
                      ],
                      (value) => {
                        if (!['yes', 'no'].includes(value.scopeMatched))
                          return session.message(
                            session.label(
                              '请输入yes或no。',
                              'Enter yes or no.',
                            ),
                            reload,
                          );
                        command({
                          kind: 'requester-feedback',
                          ...value,
                          scopeMatched: value.scopeMatched === 'yes',
                        });
                      },
                      reload,
                    ),
            ]);
          if (
            (requester || provider) &&
            record.state === 'awaiting-resolution-confirmation' &&
            record.resolution.proposerId !==
              (requester ? record.requesterId : record.selected.providerId)
          )
            entries.push([
              session.label(
                '确认对方解决方案',
                'Confirm other party resolution',
              ),
              () =>
                command({
                  kind: 'confirm-resolution',
                  proposalId: record.resolution.id,
                }),
            ]);
        }
        if (
          !record.paused &&
          session.controller.queryContext &&
          session.has('context') &&
          (requester || provider) &&
          record.state === 'active'
        ) {
          if (requester && session.controller.prepareContext)
            entries.push([
              session.label('授权选定文本材料', 'Grant selected text'),
              () => session.grantMaterials(id, reload, record),
            ]);
          entries.push([
            session.label('查看材料授权', 'View material grants'),
            () => session.materialList(id, requester, reload),
          ]);
        }
        if (
          record.paused &&
          session.controller.prepareCollaboration &&
          session.has('consent') &&
          (requester || provider) &&
          !['accepted', 'canceled', 'expired', 'resolved'].includes(
            record.state,
          )
        )
          entries.push([
            session.label('取消协作', 'Cancel collaboration'),
            () =>
              fields('cancel', [['reason', session.label('原因', 'Reason')]]),
          ]);
        if (session.controller.queryModeration && session.has('moderation')) {
          entries.push([
            session.label('举报与处理记录', 'Reports and moderation'),
            () => session.moderationList(id, undefined, reload),
          ]);
          if (session.controller.prepareModeration && session.has('consent'))
            entries.push([
              session.label('举报该协作', 'Report collaboration'),
              () =>
                session.form(
                  'Galaxy',
                  [
                    [
                      'category',
                      session.label(
                        '类别：abuse / privacy / scope / other\nmisrepresentation / malicious-artifact\ndata-extraction / work-fraud / false-verification',
                        'Category: abuse / privacy / scope / other\nmisrepresentation / malicious-artifact\ndata-extraction / work-fraud / false-verification',
                      ),
                    ],
                    ['summary', session.label('说明', 'Summary')],
                  ],
                  (value) =>
                    session.confirm(
                      { kind: 'report', assistanceId: id, ...value },
                      reload,
                      'moderation',
                    ),
                  reload,
                ),
            ]);
        }
        entries.push([
          session.label('查看协作记录', 'View collaboration record'),
          () =>
            session.message(
              (record.events ?? [])
                .map(
                  (row) =>
                    `${session.eventName(row.event.kind)}\n${session.plain(row.event.summary ?? row.event.reason ?? row.event.scope)}`,
                )
                .join('\n\n') ||
                session.label('没有可见事件', 'No visible events'),
              reload,
            ),
        ]);
        const req = record.request;
        entries.push(
          [
            session.label('阅读全文', 'Read full request'),
            () => detail(id, back),
          ],
          [
            session.label('求助内容与条件', 'Request content and conditions'),
            () => requestDetails(record, reload),
          ],
          [
            session.label('来源与详细记录', 'Source and detailed record'),
            () => session.message(JSON.stringify(record, null, 2), reload),
          ],
        );
        if (record.deliverySource)
          entries.push([
            session.label('查看当前交付依据', 'Current delivery source'),
            () =>
              session.message(
                `Case: ${session.plain(record.deliverySource.caseId)}\n${session.label('纠正/复核版本', 'Correction/review version')}: ${record.deliverySource.reviewVersion}\n${session.label('文字纠正次数', 'Text corrections')}: ${record.deliverySource.correctionCount}\n${session.label('已交付引用版本', 'Delivered version')}: ${session.plain(record.delivery?.caseReviewVersion)}\n${session.label('纠正/复核记录变化后须重新交付；恢复贡献仍需请求者验收。', 'Correction/review changes require a new delivery; contribution restoration still requires requester acceptance.')}`,
                reload,
              ),
          ]);
        if (record.resolution?.outcome === 'resume-work')
          entries.push([
            session.label(
              '方案结果：继续工作',
              'Resolution outcome: resume work',
            ),
            () =>
              session.message(
                session.label(
                  '双方确认后返回工作中；原交付和验收保留在历史中，不自动恢复为已验收。',
                  'Both parties confirm returning to active work; previous delivery and acceptance remain in history and are not automatically restored.',
                ),
                reload,
              ),
          ]);
        const heading = session.plain(req.title),
          state =
            (record.paused
              ? session.label('管理暂停 · ', 'Moderation paused · ')
              : '') + session.stateName(record.state),
          showActions = () =>
            session.menu(heading + ' · ' + state, entries, back);
        const body = `${state}\n\n${session.requestText(req)}${record.agreedScope ? '\n\n' + session.label('已约定范围', 'Agreed scope') + '\n' + session.plain(record.agreedScope) : ''}${record.pendingScope ? '\n\n' + session.label('待确认的新范围', 'Pending scope') + '\n' + session.plain(record.pendingScope) : ''}${record.delivery?.summary ? '\n\n' + session.label('交付结果', 'Delivered result') + '\n' + session.plain(record.delivery.summary) : ''}${record.resolution?.summary ? '\n\n' + session.label('处理方案', 'Resolution') + '\n' + session.plain(record.resolution.summary) : ''}`;
        if (readFirst) {
          const visible = session.generation;
          session.info(heading, body, () => {
            if (session.alive() && session.generation === visible)
              showActions();
          });
        } else showActions();
      },
      back,
    );
  }

  function requestDetails(record, back) {
    const req = record.request;
    const show = (policy) =>
      session.message(
        [
          session.plain(req.title),
          session.requestText(req),
          req.visibility === 'Public'
            ? session.label('公开所选说明', 'Public selected description')
            : session.label('私有授权范围', 'Private authorized audience'),
          Number.isFinite(req.enrollmentExpiresAt)
            ? session.label('招募截止', 'Enrollment closes') +
              ': ' +
              new Date(req.enrollmentExpiresAt * 1000).toISOString()
            : '',
          req.qualification
            ? session.label('参与条件', 'Participation requirements') +
              '\n' +
              (policy
                ? session.plain(policy.title)
                : session.label(
                    '须符合原选定政策；当前未取得政策正文。',
                    'The original selected policy applies; its text is currently unavailable.',
                  ))
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        back,
      );
    if (req.qualification && session.controller.qualificationPolicies)
      return void session.run(
        () => session.controller.qualificationPolicies(),
        (result) =>
          show(
            result.policies.find(
              (p) =>
                p.id === req.qualification.policyId &&
                p.version === req.qualification.policyVersion,
            ),
          ),
        back,
      );
    show();
  }
  return { detail, requestDetails };
}
