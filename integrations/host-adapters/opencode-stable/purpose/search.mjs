import { authoredRows } from '../../../native-v2/presentation/native-result.mjs';
import { createNativeTaskMenu } from '../task-native-menu.mjs';
import { plain } from './presentation.mjs';

export function createPurposeSearch(session) {
  function search() {
    if (session.nativeTools)
      return session.menu(
        session.label('找帮助', 'Find help'),
        [
          [
            session.label('查找方法与协助', 'Find methods and help'),
            searchHelp,
          ],
          [
            session.label('寻找同行', 'Find people and projects'),
            session.projects,
          ],
        ],
        session.onBack,
      );
    void searchHelp();
  }

  async function searchHelp() {
    session.stopMessages();
    const v = ++session.version;
    let context = null;
    try {
      context = await session.readWorkContext?.();
    } catch {
      /* A missing host context does not block a new search. */
    }
    if (!session.alive(v)) return;
    session.prompt({
      title: session.label('希望得到什么帮助？', 'What help do you need?'),
      placeholder: '',
      value: context?.query?.trim().slice(0, 200) ?? '',
      onCancel: search,
      onConfirm: (value) => {
        if (!session.alive(v)) return;
        const query = value.trim();
        if (!query || query.length > 200)
          return session.message(
            'Galaxy',
            session.label(
              '请用 200 字以内说明目标。',
              'Describe the goal in up to 200 characters.',
            ),
            searchHelp,
          );
        void searchResults(query);
      },
    });
  }

  async function searchResults(query) {
    const requests = session.nativeTools
      ? ['task', 'capsule', 'history']
      : ['capsule', 'case'];
    void session.run(
      async () => {
        const rows = [],
          failures = [];
        let availableScopes = [];
        if (!session.nativeTools)
          availableScopes = (await session.controller.status()).scopes ?? [];
        for (const type of requests) {
          if (
            !session.nativeTools &&
            !availableScopes.includes(
              type === 'capsule' ? 'capsules' : 'history',
            )
          )
            continue;
          const input = { type, query: { query, limit: 4 } };
          try {
            const page = session.nativeTools
              ? await session.native('galaxy_search_v2_query', input)
              : await session.controller.querySearch(input);
            for (const item of page.items ?? []) rows.push({ item, input });
          } catch {
            failures.push(type);
          }
        }
        return { rows, failures };
      },
      ({ rows, failures }) => {
        if (!rows.length)
          return session.message(
            session.label('找帮助', 'Find help'),
            session.label(
              '当前没有找到可读的匹配内容。可以修改目标，或在原聊天继续准备求助。',
              'No readable matches were found. Change the goal or continue preparing a request in the original chat.',
            ),
            search,
          );
        const render = () =>
          session.menu(
            session.label('可以继续查看的帮助', 'Available help') +
              (failures.length
                ? '\n' +
                  session.label(
                    '部分来源暂不可用。',
                    'Some sources are unavailable.',
                  )
                : ''),
            rows.map(({ item, input }) => [
              plain(item.title) || session.label('当前帮助', 'Current help'),
              () =>
                void session.run(
                  async () => {
                    // Reread before showing authored details. A cached search row is never
                    // treated as continuing permission after its source is withdrawn.
                    const page = session.nativeTools
                      ? await session.native('galaxy_search_v2_query', input)
                      : await session.controller.querySearch(input);
                    return (page.items ?? []).find((row) => row.id === item.id);
                  },
                  (fresh) => {
                    if (!fresh)
                      return session.message(
                        'Galaxy',
                        session.label(
                          '这项内容已变化，请重新查找。',
                          'This content changed; search again.',
                        ),
                        render,
                      );
                    if (session.nativeTools && fresh.type === 'capsule')
                      return session
                        .methodMenu(render)
                        .open(fresh.id, fresh.versionId);
                    if (session.nativeTools && fresh.type === 'task') {
                      return openTask(fresh.id, render, query);
                    }
                    const text = authoredRows(fresh)
                      .map((row) => row.label + '：' + plain(row.text))
                      .join('\n\n');
                    const currentObject =
                      fresh.type === 'task'
                        ? { kind: 'task', id: fresh.id }
                        : fresh.type === 'capsule'
                          ? { kind: 'capsule', id: fresh.id }
                          : null;
                    session.message(plain(fresh.title), text, () =>
                      session.menu(
                        session.label(
                          '继续这项帮助',
                          'Continue with this help',
                        ),
                        [
                          ...(session.nativeTools && currentObject
                            ? [
                                [
                                  session.label(
                                    '打开完整内容',
                                    'Open full content',
                                  ),
                                  () =>
                                    void session.openObject(
                                      currentObject,
                                      render,
                                    ),
                                ],
                              ]
                            : []),
                          [
                            session.label(
                              '把这项帮助带回原工作',
                              'Bring this help to the original work',
                            ),
                            () =>
                              void session.run(
                                async () => {
                                  const page = session.nativeTools
                                    ? await session.native(
                                        'galaxy_search_v2_query',
                                        input,
                                      )
                                    : await session.controller.querySearch(
                                        input,
                                      );
                                  const current = (page.items ?? []).find(
                                    (row) => row.id === fresh.id,
                                  );
                                  if (!current)
                                    throw Error('current_content_unavailable');
                                  return {
                                    title: plain(current.title),
                                    content: authoredRows(current)
                                      .map(
                                        (row) =>
                                          row.label + '：' + plain(row.text),
                                      )
                                      .join('\n\n'),
                                  };
                                },
                                session.onReturnWork,
                                render,
                              ),
                          ],
                          [session.label('查看其他帮助', 'Other help'), render],
                        ],
                        render,
                      ),
                    );
                  },
                  render,
                ),
              plain(item.summary),
            ]),
            search,
          );
        render();
      },
      search,
    );
  }

  function openTask(taskId, back, query, methodQuery = null) {
    session.taskMenu?.close();
    const v = ++session.version;
    session.taskMenu = createNativeTaskMenu({
      call: (name, args) => session.native(name, args),
      select: session.select,
      prompt: session.prompt,
      info: session.info,
      language: session.language,
      isCurrent: () => session.alive(v),
      onBack: back,
      onReturnWork: session.onReturnWork,
      readWorkContext: session.readWorkContext,
      openLink: session.nativeTools.openLink,
      searchQuery: query,
      onFindMethods: (selection) =>
        session.websiteIdentity(
          { kind: 'task', id: selection.taskId },
          () => openTask(taskId, back, query),
          {
            scopes: [
              'binding',
              'consent',
              'case-teaser',
              'history',
              'assistance',
              'context',
              'capsules',
            ],
            continueWith: { kind: 'method-search', query: selection.query },
            onComplete: () => openTask(taskId, back, query, selection.query),
          },
        ),
    });
    return methodQuery === null
      ? session.taskMenu.open(taskId)
      : session.taskMenu.bringToWork(taskId, methodQuery);
  }
  return { search, searchHelp, searchResults, openTask };
}
