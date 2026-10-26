import { selectBuilderWork } from '../builder-work-selection.mjs';

export function createBuildersCatalog(session) {
  function report(current) {
    const back = () => detail(current.builderId);
    session.form(
      session.label(
        '提交已有兼容测试结果',
        'Submit existing conformance results',
      ),
      [
        ['suiteName', session.label('测试套件名称', 'Suite name'), '', 100],
        ['suiteVersion', session.label('套件版本', 'Suite version'), '', 80],
        ['suiteHash', 'Suite SHA-256', '', 64],
        ['suiteSource', 'Suite HTTPS URL', '', 500],
        [
          'observedAt',
          session.label(
            '测试时间（含时区，如2026-09-10T08:00:00+08:00）',
            'Test time (ISO date with timezone)',
          ),
          '',
          40,
        ],
        [
          'expiresAt',
          session.label(
            '失效时间（含时区）',
            'Expiry time (ISO date with timezone)',
          ),
          '',
          40,
        ],
        ...session.checks.map((id) => [
          id,
          `${id}: pass / fail / not-tested | ${session.label('结果说明', 'result detail')}`,
          '',
          1050,
        ]),
        [
          'limitations',
          session.label('测试范围与限制', 'Test scope and limitations'),
          '',
          1500,
        ],
      ],
      (value) => {
        try {
          const timestamp = (key) => {
            if (!/(Z|[+-]\d{2}:\d{2})$/.test(value[key]))
              throw new Error(
                session.label('时间必须含时区', 'Time must include timezone'),
              );
            const result = Date.parse(value[key]) / 1000;
            if (!Number.isInteger(result))
              throw new Error(session.label('时间格式无效', 'Invalid time'));
            return result;
          };
          session.confirm(
            {
              kind: 'compatibility',
              profile: 'galaxy-conformance/2',
              builderId: current.builderId,
              baseDeclarationId: current.declarationId,
              suite: {
                name: value.suiteName,
                version: value.suiteVersion,
                sha256: value.suiteHash,
                source: value.suiteSource,
              },
              observedAt: timestamp('observedAt'),
              expiresAt: timestamp('expiresAt'),
              checks: session.checks.map((id) => {
                const rows = session.parseRows(value[id], ['status', 'detail']);
                if (rows.length !== 1)
                  throw new Error(
                    session.label(
                      '每个检查项仅填写一行',
                      'Use one row per check',
                    ),
                  );
                return { id, ...rows[0] };
              }),
              limitations: value.limitations,
            },
            back,
          );
        } catch (error) {
          session.message(session.plain(error.message), back);
        }
      },
      back,
    );
  }

  function detail(builderId) {
    void session.run(
      () => session.controller.getBuilder({ builderId }),
      (current) => {
        const back = () => detail(builderId),
          entries = [
            [
              session.label('查看完整登记声明', 'Read full declaration'),
              () =>
                session.message(
                  JSON.stringify(current.declaration, null, 2),
                  back,
                ),
            ],
            [
              session.label(
                '登记、兼容、心跳与证据',
                'Registration, compatibility, heartbeat and evidence',
              ),
              () => {
                const control = {
                  'node-authorized-owner': session.label(
                    '登记所有者已授权节点关联',
                    'Registration owner authorized node associations',
                  ),
                  'registry-owner-only': session.label(
                    '已有登记，尚无节点授权',
                    'Registered; no node authorization',
                  ),
                  unverified: session.label(
                    '尚无节点授权',
                    'No node authorization',
                  ),
                  'not-applicable': session.label(
                    '这类登记不使用节点授权',
                    'This registration type does not use node authorization',
                  ),
                  expired: session.label(
                    '节点授权已过期',
                    'Node authorization expired',
                  ),
                  unavailable: session.label(
                    '节点授权当前不可用',
                    'Node authorization currently unavailable',
                  ),
                  revoked: session.label(
                    '节点授权已撤销',
                    'Node authorization revoked',
                  ),
                  'node-authorization-unavailable': session.label(
                    '节点授权当前不可用',
                    'Node authorization currently unavailable',
                  ),
                };
                const associations =
                    current.evidence?.nodeWorkEvidence?.items ?? [],
                  outcomes = {
                    succeeded: session.label('完成', 'Completed'),
                    partial: session.label('部分完成', 'Partial'),
                    failed: session.label('未完成', 'Failed'),
                    inconclusive: session.label(
                      '暂不能得出结论',
                      'Inconclusive',
                    ),
                    conflicting: session.label('观察有冲突', 'Conflicting'),
                  };
                const states = {
                  current: session.label('当前可读', 'Currently readable'),
                  revoked: session.label('已撤销', 'Revoked'),
                  superseded: session.label(
                    '已有更新的关联',
                    'A newer association exists',
                  ),
                  'stale-declaration': session.label(
                    '所关联登记已更新',
                    'Associated declaration changed',
                  ),
                  'node-authorization-unavailable': session.label(
                    '节点授权已不可用',
                    'Node authorization unavailable',
                  ),
                  'source-unavailable': session.label(
                    '原工作或来源已不可读',
                    'Original work or source unavailable',
                  ),
                };
                session.message(
                  [
                    session.label(
                      '已记录的节点参与',
                      'Recorded node participation',
                    ) +
                      '\n' +
                      (associations.length
                        ? associations
                            .map((item) =>
                              [
                                session.plain(
                                  item.summary ??
                                    states[item.state] ??
                                    item.state,
                                  1500,
                                ),
                                states[item.state] ?? session.plain(item.state),
                                item.source?.reportedOutcome
                                  ? session.label(
                                      '这次工作的原结果：',
                                      'Original work result: ',
                                    ) +
                                    (outcomes[item.source.reportedOutcome] ??
                                      session.plain(
                                        item.source.reportedOutcome,
                                      ))
                                  : '',
                                item.source?.proofs?.length
                                  ? session.label(
                                      '所关联的 CI 来源：',
                                      'Associated CI sources: ',
                                    ) + item.source.proofs.length
                                  : '',
                              ]
                                .filter(Boolean)
                                .join('\n'),
                            )
                            .join('\n\n')
                        : session.label(
                            '尚未记录参与说明。',
                            'No participation has been recorded.',
                          )),
                    [
                      session.plain(current.declaration.name) +
                        ' · ' +
                        session.plain(current.type),
                      session.label('登记：', 'Registration: ') +
                        session.stateName(current.registration.state),
                      session.label('节点授权：', 'Node authorization: ') +
                        (control[current.nodeControl?.state] ??
                          session.plain(current.nodeControl?.state)),
                      session.label('兼容：', 'Compatibility: ') +
                        session.stateName(current.compatibility.state),
                      session.label('运行记录：', 'Running record: ') +
                        session.stateName(current.reachability.state),
                    ].join('\n'),
                  ].join('\n\n'),
                  back,
                );
              },
            ],
            [
              session.label(
                '版本与维护公告',
                'Versions and maintenance notices',
              ),
              () =>
                session.menu(
                  session.label('版本与维护公告', 'Versions and notices'),
                  [
                    ...current.versions.map((v) => [
                      `${session.plain(v.version)} · ${session.plain(v.name)}`,
                      () =>
                        session.message(
                          `${session.plain(v.declarationId)}\n${session.label('保留版本记录；当前接口读取最新声明', 'Version record retained; current API reads the latest declaration')}`,
                          back,
                        ),
                    ]),
                    ...current.notices.map((n) => [
                      session.plain(n.action),
                      () =>
                        session.message(session.plain(n.summary, 2000), back),
                    ]),
                  ],
                  back,
                ),
            ],
            [
              session.label(
                '兼容报告与失败项',
                'Conformance reports and failures',
              ),
              () =>
                session.menu(
                  session.label('评估者报告', 'Assessor reports'),
                  current.reports.map((r) => [
                    `${session.plain(r.suite.name)} ${session.plain(r.suite.version)} · ${session.plain(r.validity)}`,
                    () =>
                      session.menu(
                        session.label('兼容报告', 'Conformance report'),
                        [
                          [
                            session.label(
                              '查看范围与失败项',
                              'Read scope and failures',
                            ),
                            () =>
                              session.message(
                                `${session.plain(r.assessorId)}\n${session.plain(r.declarationHash)}\n${JSON.stringify(r.suite)}\n${JSON.stringify(r.suiteStatus)}\n${JSON.stringify(r.coverage)}\n${r.observedAt} — ${r.expiresAt}\n${r.checks.map((c) => `${session.plain(c.id)}: ${session.plain(c.status)} · ${session.plain(c.detail)}`).join('\n')}\n${session.plain(r.limitations, 1500)}`,
                                back,
                              ),
                          ],
                          ...(session.controller.exportBuilderReport &&
                          r.validity === 'current' &&
                          r.suiteStatus?.portable
                            ? [
                                [
                                  session.label(
                                    '生成可携带签名报告',
                                    'Generate portable signed report',
                                  ),
                                  () =>
                                    void session.run(
                                      () =>
                                        session.controller.exportBuilderReport({
                                          builderId,
                                          reportId: r.id,
                                        }),
                                      (result) =>
                                        session.message(
                                          JSON.stringify(result, null, 2),
                                          back,
                                        ),
                                      back,
                                    ),
                                ],
                              ]
                            : []),
                        ],
                        back,
                      ),
                  ]),
                  back,
                ),
            ],
          ];
        if (
          session.controller.prepareBuilder &&
          session.has('consent') &&
          current.disclosure
        ) {
          entries.push(
            [
              session.label('更新登记声明', 'Update declaration'),
              () => session.publish(current.type, current),
            ],
            [
              session.label('主动报到（不证明可达）', 'Send owner heartbeat'),
              () =>
                session.confirm(
                  {
                    kind: 'heartbeat',
                    builderId,
                    baseDeclarationId: current.declarationId,
                  },
                  back,
                ),
            ],
          );
          const actions = [
            [
              current.delisted ? 'relist' : 'delist',
              current.delisted
                ? session.label('恢复目录展示', 'Relist')
                : session.label('从目录下架', 'Delist'),
            ],
            ['correction', session.label('发布纠正说明', 'Publish correction')],
            [
              current.securityIssue ? 'resolve-security' : 'security-issue',
              current.securityIssue
                ? session.label('解决安全问题', 'Resolve security issue')
                : session.label('发布安全公告', 'Publish security notice'),
            ],
          ];
          entries.push([
            session.label('维护登记', 'Maintain registration'),
            () =>
              session.menu(
                session.label('维护登记', 'Maintain registration'),
                actions.map(([action, title]) => [
                  title,
                  () =>
                    session.form(
                      title,
                      [
                        [
                          'summary',
                          session.label('说明', 'Explanation'),
                          '',
                          2000,
                        ],
                      ],
                      (value) =>
                        session.confirm(
                          {
                            kind: 'maintenance',
                            builderId,
                            baseDeclarationId: current.declarationId,
                            action,
                            summary: value.summary,
                          },
                          back,
                        ),
                      back,
                    ),
                ]),
                back,
              ),
          ]);
        }
        if (current.type === 'hub' && session.controller.verifyHubDirectory) {
          entries.push([
            session.label(
              '核对Hub签名与目录声明',
              'Check Hub signature against directory',
            ),
            () =>
              void session.run(
                () =>
                  session.controller.verifyHubDirectory({
                    builderId,
                    declarationId: current.declarationId,
                    manifestSha256: current.declaration.manifest.sha256,
                  }),
                (result) =>
                  session.message(
                    [
                      result.directoryState === 'matched'
                        ? session.label(
                            '当前签名有效，目录元数据匹配',
                            'Current signature valid; directory metadata matches',
                          )
                        : session.label(
                            '目录与签名信息不一致',
                            'Directory and signed metadata differ',
                          ),
                      `${session.plain(result.data.endpoint)}\n${session.plain(result.profile)}\n${session.plain(result.manifestSha256)}`,
                      result.differences.join(', '),
                      session.label(
                        '尚未连接或授权；此核对不认证运营者身份或执行能力。',
                        'Not connected or authorized; this check does not certify operator identity or execution capability.',
                      ),
                    ].join('\n'),
                    back,
                  ),
                back,
              ),
            session.label(
              '主动匿名读取此Hub的Manifest；接入需另行配置并确认',
              'Explicit anonymous Manifest read; connection requires separate configuration and confirmation',
            ),
          ]);
        }
        if (
          current.nodeControl?.state === 'node-authorized-owner' &&
          (session.controller.exportNodeControl ||
            session.controller.prepareNodeControlProof)
        ) {
          const input = { builderId, controlId: current.nodeControl.controlId };
          entries.push([
            session.label('节点授权证明', 'Node authorization proof'),
            () =>
              session.menu(
                session.label('节点授权证明', 'Node authorization proof'),
                [
                  ...(session.controller.exportNodeControl
                    ? [
                        [
                          session.label(
                            '读取服务签名授权快照',
                            'Read registry-signed authorization snapshot',
                          ),
                          () =>
                            void session.run(
                              () => session.controller.exportNodeControl(input),
                              (result) =>
                                session.message(
                                  JSON.stringify(result, null, 2),
                                  back,
                                ),
                              back,
                            ),
                        ],
                      ]
                    : []),
                  ...(session.controller.prepareNodeControlProof &&
                  current.nodeControlDisclosure
                    ? [
                        [
                          session.label(
                            '用Node密钥签署并保存证明',
                            'Countersign and save with Node key',
                          ),
                          () =>
                            session.confirmPrepared(
                              () =>
                                session.controller.prepareNodeControlProof(
                                  input,
                                ),
                              back,
                              {
                                execute:
                                  session.controller.executeNodeControlProof,
                                proof: true,
                              },
                            ),
                        ],
                      ]
                    : []),
                ],
                back,
              ),
          ]);
        }
        if (current.type === 'worker' && current.evidence?.nodeWorkEvidence) {
          const work = current.evidence.nodeWorkEvidence,
            canRevoke =
              session.controller.prepareBuilder &&
              session.has('consent') &&
              (current.disclosure || current.nodeControlDisclosure);
          const states = {
            current: session.label('当前可读', 'Currently readable'),
            revoked: session.label('已撤销', 'Revoked'),
            superseded: session.label(
              '已有新关联',
              'A newer association exists',
            ),
            'stale-declaration': session.label(
              '登记已更新',
              'Declaration updated',
            ),
            'node-authorization-unavailable': session.label(
              '节点授权已不可用',
              'Node authorization unavailable',
            ),
            'source-unavailable': session.label(
              '原来源已不可读',
              'Original sources unavailable',
            ),
          };
          const outcomes = {
            succeeded: session.label('完成', 'Completed'),
            partial: session.label('部分完成', 'Partial'),
            failed: session.label('未完成', 'Failed'),
            inconclusive: session.label('暂不能得出结论', 'Inconclusive'),
            conflicting: session.label('观察有冲突', 'Conflicting'),
          };
          entries.push([
            session.label(
              '节点关联的任务证据',
              'Node-associated task evidence',
            ),
            () =>
              session.menu(
                session.label(
                  '节点对已有工作的参与',
                  'Node participation in existing work',
                ),
                work.items.map((item) => [
                  session.plain(
                    item.summary ??
                      states[item.state] ??
                      session.label(
                        '已有节点关联',
                        'Existing node association',
                      ),
                    180,
                  ),
                  () =>
                    session.menu(
                      session.label('这次节点参与', 'This node participation'),
                      [
                        [
                          session.label(
                            '查看参与与结果',
                            'Read participation and result',
                          ),
                          () =>
                            session.message(
                              [
                                item.summary,
                                states[item.state] ?? session.plain(item.state),
                                item.source?.reportedOutcome
                                  ? session.label(
                                      '原结果判断：',
                                      'Original result: ',
                                    ) +
                                    (outcomes[item.source.reportedOutcome] ??
                                      session.plain(
                                        item.source.reportedOutcome,
                                      ))
                                  : '',
                              ]
                                .filter(Boolean)
                                .join('\n\n'),
                              back,
                            ),
                        ],
                        [
                          session.label('来源与诊断', 'Source and diagnostics'),
                          () =>
                            session.message(
                              JSON.stringify(item, null, 2),
                              back,
                            ),
                        ],
                        ...(canRevoke && item.state !== 'revoked'
                          ? [
                              [
                                session.label(
                                  '撤销这份关联',
                                  'Revoke this association',
                                ),
                                () =>
                                  session.form(
                                    'Node',
                                    [
                                      [
                                        'reason',
                                        session.label('撤销说明', 'Reason'),
                                        '',
                                        1000,
                                      ],
                                    ],
                                    (value) =>
                                      session.confirm(
                                        {
                                          kind: 'work-evidence-revoke',
                                          builderId,
                                          baseDeclarationId:
                                            current.declarationId,
                                          workEventId: item.eventId,
                                          reason: value.reason,
                                        },
                                        back,
                                      ),
                                    back,
                                  ),
                              ],
                            ]
                          : []),
                      ],
                      back,
                    ),
                  states[item.state] ?? session.plain(item.state),
                ]),
                back,
              ),
          ]);
        }
        if (
          session.controller.prepareBuilder &&
          session.has('consent') &&
          current.nodeControlDisclosure &&
          current.nodeControl?.state === 'node-authorized-owner'
        ) {
          if (current.declaration.a2a)
            entries.push([
              session.label(
                '请求端点可达性观测',
                'Request endpoint reachability observation',
              ),
              () =>
                session.confirm(
                  {
                    kind: 'probe-request',
                    builderId,
                    baseDeclarationId: current.declarationId,
                  },
                  back,
                ),
              session.label(
                '读取已登记Agent Card并只读查询随机任务ID，不创建任务',
                'Read the registered Agent Card and a random task ID; no task creation',
              ),
            ]);
          entries.push([
            session.label(
              '以Node身份关联任务证据',
              'Associate task evidence as Node',
            ),
            () => {
              if (!session.controller.queryHistory || !session.has('history'))
                return session.message(
                  session.label(
                    '当前连接不能读取已有工作。可在连接设置选择履历读取，再从这里关联。',
                    'This connection cannot read existing work. Select history access in connection settings to associate readable work.',
                  ),
                  back,
                );
              selectBuilderWork({
                controller: session.controller,
                menu: session.menu,
                form: session.form,
                message: session.message,
                run: session.run,
                label: session.label,
                plain: session.plain,
                onBack: back,
                onSelected: ({ context, ...source }) =>
                  session.confirmPrepared(
                    () =>
                      session.controller.prepareBuilder({
                        kind: 'work-evidence',
                        builderId,
                        baseDeclarationId: current.declarationId,
                        ...source,
                      }),
                    back,
                    {
                      note: context,
                      title: session.label(
                        '保存这次节点参与',
                        'Save this node participation',
                      ),
                      allowLabel: session.label(
                        '保存参与说明',
                        'Save participation note',
                      ),
                    },
                  ),
              });
            },
          ]);
        }
        if (
          session.controller.prepareBuilder &&
          session.has('consent') &&
          current.nodeControlDisclosure
        )
          entries.push([
            session.label(
              '以Node身份授权此登记',
              'Authorize this registration as Node',
            ),
            () =>
              session.confirm(
                {
                  kind: 'node-control',
                  builderId,
                  baseDeclarationId: current.declarationId,
                },
                back,
              ),
          ]);
        if (
          session.controller.prepareBuilder &&
          session.has('consent') &&
          (current.disclosure || current.nodeControlDisclosure) &&
          current.nodeControl?.controlId
        )
          entries.push([
            session.label(
              '撤销Node登记授权',
              'Revoke Node registration approval',
            ),
            () =>
              session.form(
                session.label('撤销授权', 'Revoke approval'),
                [['reason', session.label('撤销说明', 'Reason'), '', 1000]],
                (value) =>
                  session.confirm(
                    {
                      kind: 'node-control-revoke',
                      builderId,
                      baseDeclarationId: current.declarationId,
                      reason: value.reason,
                    },
                    back,
                  ),
                back,
              ),
          ]);
        if (
          session.controller.prepareBuilder &&
          session.has('consent') &&
          current.reportDisclosure
        )
          entries.push([
            session.label('提交兼容报告', 'Submit conformance report'),
            () => report(current),
          ]);
        if (
          current.type === 'worker' &&
          current.disclosure &&
          session.controller.prepareBuilder &&
          session.has('consent')
        )
          entries.push([
            session.label(
              '配置A2A观测端点',
              'Configure A2A observation endpoint',
            ),
            () =>
              session.form(
                'A2A 1.0 / JSONRPC',
                [
                  [
                    'endpoint',
                    session.label(
                      '准确RPC端点；留空移除此配置',
                      'Exact RPC endpoint; empty removes configuration',
                    ),
                    current.declaration.a2a?.endpoint ?? '',
                    500,
                  ],
                  [
                    'cardUrl',
                    session.label(
                      '公开Agent Card地址',
                      'Public Agent Card URL',
                    ),
                    current.declaration.a2a?.cardUrl ?? '',
                    500,
                  ],
                  [
                    'tenant',
                    session.label(
                      '接口tenant；没有则留空',
                      'Interface tenant; empty if absent',
                    ),
                    current.declaration.a2a?.tenant ?? '',
                    256,
                  ],
                ],
                (value) => {
                  const declaration = { ...current.declaration };
                  delete declaration.a2a;
                  if (value.endpoint)
                    declaration.a2a = {
                      protocol: 'a2a/1.0',
                      transport: 'JSONRPC',
                      ...value,
                    };
                  session.confirm(
                    {
                      kind: 'declare',
                      builderId,
                      baseDeclarationId: current.declarationId,
                      declaration,
                      visibility: current.disclosure.visibility,
                      viewers: current.disclosure.viewers,
                    },
                    back,
                  );
                },
                back,
              ),
          ]);
        entries.push([
          session.label('原始登记记录', 'Original registration records'),
          () =>
            session.message(
              session.label(
                '心跳是所有者报到；所列参与是节点对原工作和 CI 的关联，不代表独立验证了执行能力或端点可达。',
                'Heartbeats are owner reports. The listed participation associates a node with original work and CI; it is not independent verification of execution ability or endpoint reachability.',
              ) +
                '\n\n' +
                JSON.stringify(
                  {
                    registration: current.registration,
                    nodeControl: current.nodeControl,
                    compatibility: current.compatibility,
                    reachability: current.reachability,
                    evidence: current.evidence,
                  },
                  null,
                  2,
                ),
              back,
            ),
        ]);
        const participate = entries.find(
          (entry) =>
            entry[0] ===
            session.label(
              '以Node身份关联任务证据',
              'Associate task evidence as Node',
            ),
        );
        session.menu(
          `${session.plain(current.declaration.name)} · ${session.plain(current.type)}\n${session.stateName(current.registration.state)} · ${session.stateName(current.compatibility.state)}`,
          [
            ...(participate ? [participate] : []),
            [
              session.label('回到原工作', 'Return to original work'),
              session.returnWork,
            ],
            ...entries.filter((entry) => entry !== participate),
          ],
        );
      },
    );
  }

  function listing(type, after) {
    void session.run(
      () =>
        session.controller.queryBuilders({
          query: session.query,
          limit: 8,
          ...(type ? { type } : {}),
          ...(after ? { after } : {}),
        }),
      (page) => {
        const entries = page.items.map((item) => [
          session.plain(item.name),
          () => detail(item.builderId),
          `${session.plain(item.type)} · ${session.stateName(item.compatibility.state)} · ${session.stateName(item.reachability.state)}`,
        ]);
        if (page.nextAfter)
          entries.push([
            session.label('下一批', 'Next results'),
            () => listing(type, page.nextAfter),
          ]);
        session.menu(session.label('建设者目录', 'Builder directory'), entries);
      },
    );
  }
  return { detail, listing, report };
}
