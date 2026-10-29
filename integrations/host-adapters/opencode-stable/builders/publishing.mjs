import { githubBridgeMapping } from '../../../../packages/galaxy-contracts/src/ci-provenance.mjs';

export function createBuildersPublishing(session) {
  function disclosure(input, back) {
    session.menu(
      session.label('这份内容的可见性', 'Visibility of this content'),
      [
        [
          session.label('私有', 'Private'),
          () =>
            session.form(
              'Private',
              [
                [
                  'viewers',
                  session.label(
                    '允许查看的Galaxy ID，逗号分隔；留空仅自己',
                    'Viewer Galaxy IDs; empty means yourself',
                  ),
                ],
              ],
              (v) =>
                session.confirm(
                  {
                    ...input,
                    visibility: 'Private',
                    viewers: session.split(v.viewers),
                  },
                  back,
                ),
              back,
            ),
        ],
        [
          session.label('公开已选内容', 'Public selected content'),
          () =>
            session.confirm(
              { ...input, visibility: 'Public', viewers: [] },
              back,
            ),
        ],
      ],
      back,
    );
  }

  const parseRows = (value, keys) =>
    String(value ?? '')
      .split('\n')
      .filter((v) => v.trim())
      .map((line) => {
        const values = line.split('|').map((v) => v.trim());
        if (values.length !== keys.length || values.some((v) => !v))
          throw new Error(
            session.label(
              '请按提示用 | 分隔各列',
              'Separate each required column with |',
            ),
          );
        return Object.fromEntries(
          keys.map((key, index) => [key, values[index]]),
        );
      });

  const rowsText = (rows, keys) =>
    (rows ?? [])
      .map((row) => keys.map((key) => row[key]).join(' | '))
      .join('\n');

  const checks = [
    'ids',
    'evidence',
    'signatures',
    'schema',
    'import',
    'privacy',
    'revocation',
  ];

  function publish(type, current) {
    const old = current?.declaration ?? {},
      release = old.release ?? {},
      config = old.configuration ?? {},
      mapping = old.mapping ?? (type === 'bridge' ? githubBridgeMapping : {}),
      back = current
        ? () =>
            current.mode === 'owner-management'
              ? session.management(current.builderId)
              : session.detail(current.builderId)
        : session.home;
    const common = [
      ['name', session.label('名称', 'Name'), old.name, 160],
      ['scope', session.label('适用范围', 'Applicable scope'), old.scope, 1500],
      [
        'version',
        session.label('发行版本', 'Release version'),
        release.version,
        80,
      ],
      ['buildHash', 'Build SHA-256', release.buildHash, 64],
      [
        'sourceCommit',
        session.label('源码提交摘要', 'Source commit'),
        release.sourceCommit,
        64,
      ],
      [
        'artifact',
        session.label('发行文件HTTPS地址', 'Release artifact HTTPS URL'),
        release.artifact,
        500,
      ],
      ['policy', 'Policy HTTPS URL', old.policy, 500],
      [
        'contact',
        session.label('联络页面HTTPS地址', 'Contact page HTTPS URL'),
        old.contact,
        500,
      ],
      [
        'dependencies',
        session.label(
          '依赖：每行 名称 | 固定版本 | SHA-256；无依赖留空',
          'Dependencies: one name | pinned version | SHA-256 per line; empty if none',
        ),
        rowsText(release.dependencies, ['name', 'version', 'sha256']),
        7000,
      ],
      [
        'upgrade',
        session.label(
          '升级步骤（保留身份）',
          'Upgrade steps (preserve identity)',
        ),
        release.upgrade,
        1500,
      ],
      [
        'rollback',
        session.label('回退步骤', 'Rollback steps'),
        release.rollback,
        1500,
      ],
      [
        'proofIds',
        session.label(
          '所有者CI Proof ID，逗号分隔，可留空',
          'Owner CI Proof IDs, comma separated, optional',
        ),
        old.proofIds?.join(','),
        650,
      ],
    ];
    const specific =
      type === 'worker'
        ? [
            [
              'nodeId',
              session.label(
                '已有Worker Node Galaxy ID',
                'Existing Worker Node Galaxy ID',
              ),
              old.nodeId,
              32,
            ],
            [
              'configurationId',
              session.label('配置标识', 'Configuration ID'),
              config.id,
              100,
            ],
            [
              'configurationSummary',
              session.label(
                '配置摘要，不含私有Prompt或密钥',
                'Configuration summary without private prompts or keys',
              ),
              config.summary,
              1500,
            ],
            [
              'modelFamily',
              session.label('模型系列', 'Model family'),
              config.modelFamily,
              100,
            ],
            [
              'tools',
              session.label(
                '工具名称，逗号分隔',
                'Tool names, comma separated',
              ),
              config.tools?.join(','),
            ],
            [
              'taskTypes',
              session.label(
                '任务类型，逗号分隔',
                'Task types, comma separated',
              ),
              config.taskTypes?.join(','),
            ],
            [
              'maxConcurrentTasks',
              session.label('最大并发任务数', 'Maximum concurrent tasks'),
              config.maxConcurrentTasks ?? 1,
              4,
            ],
            [
              'capabilities',
              session.label(
                '能力声明：每行 标识 | 声明 | 局限',
                'Capability claims: one ID | claim | limitations per line',
              ),
              rowsText(old.capabilities, ['id', 'claim', 'limitations']),
              16000,
            ],
          ]
        : type === 'bridge'
          ? [
              [
                'sourceSystem',
                session.label('来源系统', 'Source system'),
                mapping.sourceSystem,
                160,
              ],
              [
                'sourceObjects',
                session.label(
                  '来源对象，逗号分隔',
                  'Source objects, comma separated',
                ),
                mapping.sourceObjects?.join(','),
              ],
              [
                'targetObjects',
                session.label(
                  '目标对象，逗号分隔',
                  'Target objects, comma separated',
                ),
                mapping.targetObjects?.join(','),
              ],
              [
                'rules',
                session.label('映射规则', 'Mapping rules'),
                mapping.rules,
                3000,
              ],
              [
                'strengthCeiling',
                session.label(
                  '强度上限：source-assertion 或 execution-observation',
                  'Strength ceiling: source-assertion or execution-observation',
                ),
                mapping.strengthCeiling ?? 'source-assertion',
                30,
              ],
              [
                'authorization',
                session.label('来源授权方式', 'Source authorization'),
                mapping.authorization,
                1000,
              ],
              [
                'mappingVersion',
                session.label('映射版本', 'Mapping version'),
                mapping.version,
                80,
              ],
              [
                'deduplication',
                session.label('去重方法', 'Deduplication'),
                mapping.deduplication,
                1500,
              ],
              [
                'revocation',
                session.label('撤销传播', 'Revocation propagation'),
                mapping.revocation,
                1500,
              ],
              [
                'provenance',
                session.label(
                  '来源控制权及强度说明',
                  'Source authority and strength',
                ),
                mapping.provenance,
                1500,
              ],
            ]
          : [
              [
                'operator',
                session.label('运营者', 'Operator'),
                old.operator,
                160,
              ],
              ['charter', 'Charter HTTPS URL', old.charter, 500],
              ['region', session.label('地区', 'Region'), old.region, 160],
              ['endpoint', 'Hub endpoint HTTPS URL', old.endpoint, 500],
              ['manifestUrl', 'Manifest HTTPS URL', old.manifest?.url, 500],
              [
                'manifestHash',
                'Manifest data JCS SHA-256',
                old.manifest?.sha256,
                64,
              ],
              [
                'manifestVersion',
                session.label('Manifest规范版本', 'Manifest spec version'),
                old.manifest?.specVersion ?? 'galaxy-hub/1',
                80,
              ],
              [
                'exit',
                session.label('退出说明', 'Exit instructions'),
                old.exit,
                1500,
              ],
              [
                'export',
                session.label('导出说明', 'Export instructions'),
                old.export,
                1500,
              ],
            ];
    session.form(
      `${type} ${session.label('登记声明', 'declaration')}`,
      [
        ...common,
        ...specific,
        [
          'redacted',
          session.label(
            '已检查所选内容并移除秘密：输入yes',
            'Reviewed selected content and removed secrets: enter yes',
          ),
          '',
          3,
        ],
      ],
      (value) => {
        try {
          if (value.redacted !== 'yes')
            return session.message(
              session.label(
                '请先检查所选内容',
                'Review selected content first',
              ),
              back,
            );
          const declaration = {
            type,
            name: value.name,
            scope: value.scope,
            policy: value.policy,
            contact: value.contact,
            redactionConfirmed: true,
            proofIds: session.split(value.proofIds),
            release: {
              version: value.version,
              buildHash: value.buildHash,
              sourceCommit: value.sourceCommit,
              artifact: value.artifact,
              dependencies: parseRows(value.dependencies, [
                'name',
                'version',
                'sha256',
              ]),
              upgrade: value.upgrade,
              rollback: value.rollback,
            },
          };
          if (type === 'worker')
            Object.assign(declaration, {
              nodeId: value.nodeId,
              configuration: {
                id: value.configurationId,
                summary: value.configurationSummary,
                modelFamily: value.modelFamily,
                tools: session.split(value.tools),
                taskTypes: session.split(value.taskTypes),
                maxConcurrentTasks: Number(value.maxConcurrentTasks),
              },
              capabilities: parseRows(value.capabilities, [
                'id',
                'claim',
                'limitations',
              ]),
            });
          else if (type === 'bridge')
            declaration.mapping = {
              sourceSystem: value.sourceSystem,
              sourceObjects: session.split(value.sourceObjects),
              targetObjects: session.split(value.targetObjects),
              rules: value.rules,
              strengthCeiling: value.strengthCeiling,
              authorization: value.authorization,
              version: value.mappingVersion,
              deduplication: value.deduplication,
              revocation: value.revocation,
              provenance: value.provenance,
            };
          else
            Object.assign(declaration, {
              operator: value.operator,
              charter: value.charter,
              region: value.region,
              endpoint: value.endpoint,
              manifest: {
                url: value.manifestUrl,
                sha256: value.manifestHash,
                specVersion: value.manifestVersion,
              },
              exit: value.exit,
              export: value.export,
            });
          disclosure(
            {
              kind: 'declare',
              declaration,
              ...(current
                ? {
                    builderId: current.builderId,
                    baseDeclarationId: current.declarationId,
                    ...(current.mode === 'owner-management'
                      ? { management: true, baseRevision: current.revision }
                      : {}),
                  }
                : {}),
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
  return { parseRows, rowsText, checks, disclosure, publish };
}
