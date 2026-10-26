import { workContinuationLinkFromText } from '../../../../packages/galaxy-edge-mcp/src/native-v2/work/continuation-link.mjs';
import { continuationResultText } from '../../../../packages/galaxy-edge-mcp/src/native-v2/work/continuation.mjs';

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
                '已请求打开。回来后按 Enter 接续当前工作。',
                'Opening requested. Press Enter on return to resume.',
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
              () => back(),
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
                  session.label(
                    '放回原工作继续',
                    'Continue in the original work',
                  ),
                  () =>
                    void session.run(
                      () => session.native('galaxy_work_continue', { link }),
                      (fresh) => {
                        const currentTitle =
                          fresh.sources?.find(
                            (source) =>
                              source.role === 'current' &&
                              source.state === 'available',
                          )?.title ??
                          session.label(
                            '网页里的这件事',
                            'The selected web content',
                          );
                        return session.onReturnWork({
                          title: currentTitle,
                          content: continuationResultText(fresh),
                          sourceUrl: fresh.returnUrl,
                        });
                      },
                      () => read(link),
                    ),
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
              '在原内容旁点击“用自己的 AI 继续”，把复制的完整请求贴到这里即可。原宿主输入保留，不需要填写编号或 JSON。',
              'Choose “Continue with my AI” beside the web content and paste its complete copied request here. Your original host input is retained; no IDs or JSON are needed.',
            ),
            continueWeb,
          );
        read(link);
      },
    });
  }
  return { openObject, community, continueWeb };
}
