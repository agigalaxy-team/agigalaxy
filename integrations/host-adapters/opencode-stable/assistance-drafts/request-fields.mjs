import { assistanceDraftApproaches } from "../../../../packages/galaxy-contracts/src/assistance-schema.mjs";

export function createAssistanceDraftsRequestFields(session) {
  function valuesText(content) {
    const values = content.values ?? {},
      rows = [];
    for (const [key, name] of [
      ['title', session.label('标题', 'Title')],
      ['problem', session.label('工作情况', 'Work context')],
      ['proposal', session.label('申请方案', 'Proposal')],
      [
        'scope',
        content.eventKind
          ? session.label('范围', 'Scope')
          : session.label('希望得到的协助', 'Requested help'),
      ],
      ['summary', session.label('结果与说明', 'Result and explanation')],
      ['reason', session.label('原因', 'Reason')],
      ['note', session.label('补充说明', 'Note')],
    ])
      if (values[key]) rows.push(name + '\n' + session.plain(values[key]));
    const approaches = assistanceDraftApproaches(content);
    if (approaches.length)
      rows.push(
        session.label('已有尝试', 'Previous approaches') +
          '\n' +
          approaches.map(session.plain).join('\n'),
      );
    if (values.participantId)
      rows.push(
        session.label('接收身份', 'Recipient identity') +
          '\n' +
          session.plain(values.participantId),
      );
    if (values.evidenceIds)
      rows.push(
        session.label('附加材料', 'Additional materials') +
          '：' +
          session.split(values.evidenceIds).length,
      );
    if (values.proofIds)
      rows.push(
        session.label('已选 CI 来源', 'Selected CI sources') +
          '：' +
          session.split(values.proofIds).length,
      );
    if (values.assistanceIds)
      rows.push(
        session.label('已选验收工作', 'Selected accepted work') +
          '：' +
          session.split(values.assistanceIds).length,
      );
    if (values.descriptionClarity)
      rows.push(
        session.label('描述清晰度', 'Description clarity') +
          '：' +
          ({
            clear: session.label('清楚', 'Clear'),
            'partly-clear': session.label('部分清楚', 'Partly clear'),
            unclear: session.label('不清楚', 'Unclear'),
          }[values.descriptionClarity] ??
            session.plain(values.descriptionClarity)),
      );
    if (values.scopeMatched)
      rows.push(
        session.label('符合原范围', 'Matched scope') +
          '：' +
          (values.scopeMatched === 'yes'
            ? session.label('是', 'Yes')
            : values.scopeMatched === 'no'
              ? session.label('否', 'No')
              : session.plain(values.scopeMatched)),
      );
    if (content.mode === 'fixed')
      rows.push(
        session.label('金额', 'Amount') +
          '：' +
          session.plain(values.amount) +
          ' ' +
          session.plain(values.unit),
      );
    if (content.mode === 'range')
      rows.push(
        session.label('区间', 'Range') +
          '：' +
          session.plain(values.minimum) +
          '–' +
          session.plain(values.maximum) +
          ' ' +
          session.plain(values.unit),
      );
    if (content.mode === 'quote')
      rows.push(
        session.label('请求报价', 'Request quote') +
          ' · ' +
          session.plain(values.unit),
      );
    return rows.join('\n\n');
  }

  function fields(row, items, next, previous) {
    const index = Math.min(row.content.index, items.length - 1),
      [key, title] = items[index],
      version = ++session.generation;
    const storeValue = (text) =>
      session.save(row, {
        values: { ...row.content.values, [key]: text },
        index: index + 1 < items.length ? index + 1 : 0,
        ...(index + 1 === items.length ? { step: next } : {}),
      });
    if (key === 'caseId' && !session.canSubmit)
      return storeValue(row.content.values.caseId ?? '');
    if (
      items === session.details &&
      key === 'hours' &&
      (row.content.mode ?? 'open') === 'open'
    )
      return storeValue(row.content.values.hours || '24');
    if (key === 'caseId' && session.controller.queryHistory)
      return session.workSelection.select(
        (work) =>
          void session.run(
            () => session.workSelection.reread(work),
            (fresh) => {
              const approaches = (fresh.attempts ?? [])
                .map((a) => a.approach)
                .filter(Boolean);
              session.save(row, {
                values: {
                  ...row.content.values,
                  caseId: fresh.caseId,
                  title: row.content.values.title || fresh.title,
                  problem: row.content.values.problem || fresh.summary,
                  attempts: row.content.values.attempts ?? '',
                },
                ...(!Array.isArray(row.content.attemptedApproaches) &&
                !row.content.values.attempts
                  ? { attemptedApproaches: approaches }
                  : {}),
                index: 4,
                mode: row.content.mode ?? 'open',
              });
            },
            previous,
          ),
        previous,
        { preferredCaseId: row.content.values.caseId },
      );
    if (key === 'attempts')
      return editApproaches(
        row,
        (approaches) =>
          session.save(row, {
            attemptedApproaches: approaches,
            values: { ...row.content.values, attempts: '' },
            index: index + 1 < items.length ? index + 1 : 0,
            ...(index + 1 === items.length ? { step: next } : {}),
          }),
        previous,
      );
    if (
      key === 'attemptId' &&
      session.canSubmit &&
      session.controller.queryHistory
    )
      return void session.run(
        () => session.controller.getAssistance(row.content.source.assistanceId),
        (record) => {
          const caseId =
            record.deliverySource?.caseId ?? record.request?.caseId;
          if (!caseId)
            return session.message(
              session.label(
                '当前请求未提供可读取的原工作。可返回原工作取回已有引用；不会创建替代记录。',
                'This request has no readable work reference. Return to the original work for its existing reference; no substitute record is created.',
              ),
              previous,
            );
          session.workSelection.select(
            (work) =>
              void session.run(
                () => session.workSelection.reread(work),
                (fresh) => storeValue(fresh.attempt.id),
                previous,
              ),
            previous,
            {
              mode: 'attempt',
              requiredCaseId: caseId,
              subjectId: record.requesterId,
            },
          );
        },
        previous,
      );
    if (
      key === 'evidenceIds' &&
      session.canSubmit &&
      session.controller.queryHistory
    )
      return session.menu(
        session.label(
          '这次交付的附加材料',
          'Additional materials for this delivery',
        ),
        [
          [
            session.label('不引用其他材料', 'Do not cite additional materials'),
            () => storeValue(''),
          ],
          ...(row.content.values.evidenceIds
            ? [
                [
                  session.label(
                    '沿用已保存的材料引用',
                    'Keep saved material references',
                  ),
                  () => storeValue(row.content.values.evidenceIds),
                  session.label(
                    '仍按原工作和当前权限核对',
                    'Still checked against the original work and current permissions',
                  ),
                ],
              ]
            : []),
          [
            session.label(
              '使用已有原材料引用',
              'Use existing original material references',
            ),
            () =>
              session.form(
                session.label(
                  '原工作中的材料引用',
                  'Material references in the original work',
                ),
                [
                  [
                    key,
                    session.label(
                      '你已掌握的原材料引用，逗号分隔',
                      'Original references you already hold, comma separated',
                    ),
                  ],
                ],
                (v) => storeValue(v[key]),
                () => fields(row, items, next, previous),
              ),
          ],
        ],
        previous,
      );
    if (
      (key === 'proofIds' &&
        session.canSubmit &&
        session.controller.querySearch) ||
      (key === 'assistanceIds' &&
        session.canSubmit &&
        session.controller.queryAssistance)
    )
      return selectQualification(row, key, storeValue, previous);
    const currentWorkScope =
      key === 'scope' &&
      items === session.details &&
      session.controller.queryHistory;
    session.prompt({
      title: currentWorkScope
        ? session.label('希望得到怎样的协助', 'What help would you like') +
          '\n' +
          session.plain(row.content.values.title)
        : `${session.label('求助内容', 'Help request')}\n${title}\n${session.label('留空保留原值；/clear清空。', 'Empty keeps the saved value; /clear removes it.')}`,
      placeholder: title,
      value: row.content.values[key] ?? '',
      onCancel: () => {
        if (session.active(version)) {
          session.generation++;
          if (currentWorkScope) previous();
          else if (index) session.save(row, { index: index - 1 });
          else previous();
        }
      },
      onConfirm: (value) => {
        if (!session.active(version)) return;
        session.generation++;
        const entered = String(value).trim(),
          text =
            entered === '/clear'
              ? ''
              : entered || (row.content.values[key] ?? '');
        if (
          text.length > 1200 ||
          (key === 'hours' &&
            (!Number.isFinite(Number(text)) ||
              Number(text) <= 0 ||
              Number(text) > 720))
        )
          return session.message(
            session.label(
              '字段过长或有效小时数不正确。',
              'Field too long or invalid enrollment hours.',
            ),
            () => session.render(row),
          );
        if (currentWorkScope)
          return session.save(row, {
            values: { ...row.content.values, scope: text },
            index: 0,
            step: row.content.visibility ? 'review' : 'visibility',
          });
        storeValue(text);
      },
    });
  }

  function editApproaches(row, done, back) {
    const approaches = assistanceDraftApproaches(row.content);
    const valid = (items) =>
      items.length <= 8 && items.every((item) => item.length <= 1200);
    const invalid = (again) =>
      session.message(
        session.label(
          '这份求助可附最多8条已有尝试，每条最多1200字。原内容仍保留，可以修改后继续。',
          'A request can include at most 8 previous approaches, each up to 1200 characters. The original content is retained; edit it to continue.',
        ),
        again,
      );
    if (!approaches.some((value) => /[\r\n]/.test(value))) {
      const version = ++session.generation;
      return session.prompt({
        title: session.label(
          '已有尝试（每行一条，可留空）',
          'Previous approaches (one per line, optional)',
        ),
        value: approaches.join('\n'),
        placeholder: session.label(
          '写下已经试过的方法',
          'Describe approaches you have already tried',
        ),
        onCancel: () => {
          if (session.active(version)) {
            session.generation++;
            back();
          }
        },
        onConfirm: (value) => {
          if (!session.active(version)) return;
          session.generation++;
          const items = String(value)
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (!valid(items))
            return invalid(() =>
              editApproaches(
                {
                  ...row,
                  content: { ...row.content, attemptedApproaches: items },
                },
                done,
                back,
              ),
            );
          done(items);
        },
      });
    }
    const show = () =>
      session.menu(
        session.label('已有尝试', 'Previous approaches'),
        [
          [
            session.label('保存已有尝试', 'Save previous approaches'),
            () => (valid(approaches) ? done(approaches) : invalid(show)),
          ],
          ...approaches.map((value, index) => [
            session.label('尝试 ', 'Approach ') + (index + 1),
            () => {
              const version = ++session.generation;
              session.prompt({
                title: session.label(
                  '修改这条尝试（留空移除）',
                  'Edit this approach (empty removes it)',
                ),
                value,
                placeholder: session.label(
                  '这条尝试的完整内容',
                  'Full content of this approach',
                ),
                onCancel: () => {
                  if (session.active(version)) {
                    session.generation++;
                    show();
                  }
                },
                onConfirm: (input) => {
                  if (!session.active(version)) return;
                  session.generation++;
                  const text = String(input).trim();
                  if (text) approaches[index] = text;
                  else approaches.splice(index, 1);
                  show();
                },
              });
            },
            session.plain(value),
          ]),
          ...(approaches.length < 8
            ? [
                [
                  session.label('补充尝试', 'Add an approach'),
                  () => {
                    const version = ++session.generation;
                    session.prompt({
                      title: session.label(
                        '补充一条已有尝试',
                        'Add a previous approach',
                      ),
                      value: '',
                      placeholder: session.label(
                        '已经试过的方法',
                        'An approach already tried',
                      ),
                      onCancel: () => {
                        if (session.active(version)) {
                          session.generation++;
                          show();
                        }
                      },
                      onConfirm: (value) => {
                        if (!session.active(version)) return;
                        session.generation++;
                        const text = String(value).trim();
                        if (text) approaches.push(text);
                        show();
                      },
                    });
                  },
                ],
              ]
            : []),
        ],
        back,
      );
    show();
  }

  function selectQualification(row, key, done, back) {
    const kind = key === 'proofIds' ? 'proof' : 'assistance',
      chosen = session.split(row.content.values[key]);
    const show = () =>
      session.menu(
        key === 'proofIds'
          ? session.label(
              '选择资格所需的 CI 来源',
              'Choose CI sources for qualification',
            )
          : session.label(
              '选择已验收的本人协作',
              'Choose your accepted collaborations',
            ),
        [
          ...(chosen.length
            ? [
                [
                  session.label('使用已选来源', 'Use selected sources'),
                  () => done(chosen.join(',')),
                  session.label('已选 ', 'Selected ') + chosen.length,
                ],
              ]
            : []),
          ...(chosen.length < 16
            ? [
                [
                  session.label(
                    '从当前可读记录选择',
                    'Choose currently readable records',
                  ),
                  () =>
                    void session.run(
                      () => session.controller.status?.(),
                      (status) =>
                        session.records.select(
                          kind,
                          (item) => {
                            if (!chosen.includes(item.id)) chosen.push(item.id);
                            show();
                          },
                          show,
                          {
                            subjectId: status?.subjectId,
                            assistanceView: 'participating',
                            filter: (record) =>
                              kind !== 'assistance' ||
                              record.state === 'accepted',
                          },
                        ),
                      show,
                    ),
                ],
              ]
            : []),
          [
            session.label('不引用此类来源', 'Do not cite this kind of source'),
            () => done(''),
          ],
          [
            session.label('查看已选引用', 'Inspect selected references'),
            () =>
              session.message(
                chosen.join('\n') ||
                  session.label('尚未选择。', 'Nothing selected.'),
                show,
              ),
          ],
        ],
        back,
      );
    show();
  }
  return { valuesText, fields, editApproaches, selectQualification };
}
