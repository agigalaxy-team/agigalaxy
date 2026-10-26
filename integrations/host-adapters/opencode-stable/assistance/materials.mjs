import { createContextDraftMenu } from '../context-draft-menu.mjs';

export function createAssistanceMaterialsMenu(session) {
  function grantMaterials(assistanceId, back, record) {
    if (session.controller.createContextDraft)
      return materials().create(record);
    session.form(
      session.label('选定文本材料', 'Selected text material'),
      [
        ['label', session.label('材料名称', 'Material label')],
        [
          'content',
          session.label(
            '粘贴选定片段；不要包含凭据或完整会话',
            'Paste selected excerpt; exclude credentials and full sessions',
          ),
        ],
        [
          'hours',
          session.label(
            '有效小时数；默认1小时',
            'Validity in hours; default 1',
          ),
          '1',
        ],
      ],
      (value) => {
        const hours = Number(value.hours || '1');
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24)
          return session.message(
            session.label(
              '有效期必须大于0且不超过24小时。',
              'Validity must be over 0 and at most 24 hours.',
            ),
            back,
          );
        session.confirm(
          {
            kind: 'grant',
            assistanceId,
            expiresAt: Math.floor(Date.now() / 1000 + hours * 3600),
            materials: [{ label: value.label, content: value.content }],
          },
          back,
          true,
        );
      },
      back,
    );
  }

  function materialList(assistanceId, owner, back) {
    void session.run(
      () => session.controller.queryContext(assistanceId),
      (page) => {
        const refresh = () => materialList(assistanceId, owner, back);
        session.menu(
          session.label('协作材料授权', 'Collaboration material grants'),
          page.items.map((item) => [
            item.materials
              .map((material) => session.plain(material.label))
              .join(', '),
            () => materialDetail(item.grantId, owner, refresh),
            session.plain(item.state),
          ]),
          back,
        );
      },
      back,
    );
  }

  function materialDetail(grantId, owner, back) {
    void session.run(
      () => session.controller.getContext(grantId),
      (grant) => {
        const entries = [],
          refresh = () => materialDetail(grantId, owner, back);
        if (
          session.controller.prepareContext &&
          !owner &&
          grant.state === 'pending'
        )
          entries.push([
            session.label('确认接收这份材料授权', 'Accept this material grant'),
            () => session.confirm({ kind: 'accept', grantId }, refresh, true),
          ]);
        if (session.controller.prepareContext && owner)
          entries.push([
            session.label('撤销这份材料授权', 'Revoke this material grant'),
            () => session.confirm({ kind: 'revoke', grantId }, back, true),
          ]);
        for (const material of grant.materials)
          entries.push([
            session.plain(material.label),
            () =>
              session.message(
                grant.contextAccessGranted
                  ? String(material.content)
                      .replace(
                        // Keep line breaks and tabs while removing unsafe display controls.
                        // eslint-disable-next-line no-control-regex
                        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
                        ' ',
                      )
                      .slice(0, 4000)
                  : session.label(
                      '确认接收前正文不可读。',
                      'Content is unavailable until you accept.',
                    ),
                refresh,
              ),
          ]);
        entries.push([
          session.label('来源与详细授权', 'Source and authorization details'),
          () => session.message(JSON.stringify(grant, null, 2), refresh),
        ]);
        session.menu(
          `${session.label('协作材料', 'Collaboration materials')}\n${grant.state === 'accepted' ? session.label('已接收', 'Accepted') : session.stateName(grant.state)}\n${session.label('可用范围', 'Permitted scope')}: ${session.plain(grant.scope)}\n${session.label('接收身份', 'Recipient identity')}: ${session.plain(grant.participantId)}\n${session.label('到期', 'Expires')}: ${new Date(grant.expiresAt * 1000).toISOString()}`,
          entries,
          back,
        );
      },
      back,
    );
  }

  function materials() {
    return createContextDraftMenu({
      controller: session.controller,
      select: session.select,
      prompt: session.prompt,
      info: session.info,
      language: session.language,
      isCurrent: session.isCurrent,
      onBack: session.home,
      onConfirm: (input, back, retry = false) =>
        session.confirm(input, back, true, retry),
      onOpenGrant: (id, owner) =>
        materialDetail(id, owner, () => materials().open()),
      canSubmit: session.has('context') && session.has('consent'),
    });
  }
  return { grantMaterials, materialList, materialDetail, materials };
}
