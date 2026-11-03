import { workContinuationLinkFromText } from '../../../../packages/galaxy-contracts/src/work-continuation-link.mjs';
import { continuationResultText } from '../../../native-v2/presentation/work-continuation.mjs';
import { readableContent } from '../../../native-v2/compact-app/presentation.mjs';

export function createPurposeContinuation(session) {
  async function openObject(object, back = session.onBack) {
    return session.run(
      async () => {
        const context = await session.readWorkContext?.();
        return session.native('galaxy_open', {
          object,
          ...(context?.origin ? { origin: context.origin } : {}),
        });
      },
      (data) => {
        session.navigationId = data.navigationId;
        session.message(
          session.label('继续打开的内容', 'Continue in the opened content'),
          data.launched
            ? session.label(
                '已请求打开。回来后按 Enter 查看当前内容。',
                'Opening requested. Press Enter on return to view current content.',
              )
            : (data.url ??
                session.label(
                  '当前宿主未提供浏览器入口。',
                  'This host has no browser entry.',
                )),
          () =>
            void session.run(
              () =>
                session.native('galaxy_return', {
                  navigationId: session.navigationId,
                }),
              (fresh) => {
                if (!fresh.current) return session.message(
                  session.label('网页内容', 'Website content'),
                  fresh.state === 'navigation-only'
                    ? session.label('这个页面没有可带回的单个对象。原工作和输入保留。', 'This page has no individual object to return. Your original work and input are retained.')
                    : session.label('当前内容暂时无法取得。原工作和输入保留，可以稍后再试。', 'Current content is unavailable. Your original work and input are retained; try again later.'),
                  back,
                );
                const rows = readableContent(fresh.data);
                const body = rows.map(row => `${row.label}\n${row.text}`).join('\n\n');
                if (!body) return session.message(
                  session.label('网页内容', 'Website content'),
                  session.label('已重新取得当前对象，但没有可显示的正文。', 'The current object was refreshed, but has no readable text.'),
                  back,
                );
                const title = session.label('网页里的当前内容', 'Current website content');
                session.readingMessage(title, body, () => session.menu(title, [
                  [session.label('回到原工作', 'Return to the original work'), () => session.onReturnWork()],
                  [session.label('回到银河', 'Return to Galaxy'), back],
                ], back));
              },
              back,
            ),
        );
      },
      back,
    );
  }

  function community() {
    if (!session.nativeTools) return session.onBack();
    void openObject({ kind: 'community' });
  }

  async function continueWeb() {
    if (!session.nativeTools) return session.onBack();
    session.stopMessages();
    const v = ++session.version;
    let context = null;
    try {
      context = await session.readWorkContext?.();
    } catch {
      /* A missing host background does not replace the selected web request. */
    }
    if (!session.alive(v)) return;
    const existing = workContinuationLinkFromText(context?.query);
    const read = (link) =>
      void session.run(
        () => session.native('galaxy_work_continue', { link }),
        (result) => {
          const title =
            result.sources?.find(
              (source) =>
                source.role === 'current' && source.state === 'available',
            )?.title ??
            session.label('网页里的这件事', 'The selected web content');
          const body = continuationResultText(result);
          session.readingMessage(title, body, () =>
            session.menu(
              title,
              [
                [
                  session.label('回到原工作', 'Return to the original work'),
                  () => session.onReturnWork(),
                ],
                [
                  session.label('阅读当前内容', 'Read current content'),
                  () => read(link),
                ],
                ...(session.nativeTools.openLink
                  ? [
                      [
                        session.label(
                          '回到原网页',
                          'Return to the original web page',
                        ),
                        () =>
                          void session.nativeTools.openLink(result.returnUrl),
                      ],
                    ]
                  : []),
              ],
              session.onBack,
            ),
          );
        },
        () => continueWeb(),
      );
    if (existing) return read(existing);
    session.prompt({
      title: session.label(
        '粘贴网页里的 AI 接续请求',
        'Paste the AI continuation request from the website',
      ),
      placeholder: '',
      value: '',
      onCancel: session.onBack,
      onConfirm: (value) => {
        if (!session.alive(v)) return;
        const link = workContinuationLinkFromText(value);
        if (!link)
          return session.message(
            session.label(
              '还没有找到这次网页选择',
              'The selected web content was not found',
            ),
            session.label(
              '在网页内容旁选择“用自己的 AI 继续”，然后把复制的请求贴到这里。原工作输入会保留。',
              'Choose “Continue with my AI” beside the web content, then paste its copied request here. Your original input is retained.',
            ),
            continueWeb,
          );
        read(link);
      },
    });
  }
  return { openObject, community, continueWeb };
}
