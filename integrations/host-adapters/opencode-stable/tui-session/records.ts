import type { Action, Routes, PublicationDraft } from '../adapter-types.ts';
import { showExactChoice } from '../exact-choice.mjs';
import type { GalaxyMenuSession } from './session-context.ts';

export function createRecordsPages(session: GalaxyMenuSession) {
  async function showPublicationDrafts(onBack: Action) {
    const connectionController = session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const back = () => void session.showManagedConnection(onBack);
    try {
      const drafts = (
        (await session.controllerMethod(
          'listPublicationDrafts',
        )()) as PublicationDraft[]
      ).filter((item) => item.status !== 'acknowledged');
      if (version !== session.connectionGeneration) return;
      if (!drafts.length)
        return session.showInfo(
          'Galaxy',
          chinese ? '暂无待发布草稿。' : 'No drafts pending publication.',
          back,
        );
      const render = (offset: number) => {
        if (version !== session.connectionGeneration) return;
        const routes: Routes = {};
        const options = drafts.slice(offset, offset + 8).map((draft, index) => {
          routes[index + 1] = () =>
            session.showSelect({
              title: chinese ? '选择可见性' : 'Choose visibility',
              options: [
                {
                  number: '1',
                  title: chinese ? '私有' : 'Private',
                  description: chinese
                    ? '发送到端点，仅本人查看'
                    : 'Sent to the endpoint; visible only to you',
                },
                {
                  number: '2',
                  title: chinese ? '公开' : 'Public',
                  description: chinese
                    ? '进入公开履历；请确认内容适合公开'
                    : 'Available in public history; review content before sharing',
                },
                ...(connectionController.reconcilePublication &&
                draft.status === 'prepared'
                  ? [
                      {
                        number: '3',
                        title: chinese
                          ? '核对已有提交'
                          : 'Check previous submission',
                        description: chinese
                          ? '只读取远端原事件，匹配后恢复本地回执'
                          : 'Read the original remote event and recover a matching local receipt',
                      },
                    ]
                  : []),
              ],
              routes: {
                1: () =>
                  void previewCaseSubmission(
                    onBack,
                    draft.localCaseId,
                    'Private',
                  ),
                2: () =>
                  void previewCaseSubmission(
                    onBack,
                    draft.localCaseId,
                    'Public',
                  ),
                3: () =>
                  void reconcilePublicationDraft(onBack, draft.localCaseId),
              },
              onBack: () => render(offset),
            });
          return {
            number: String(index + 1),
            title: draft.title
              .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
              .slice(0, 160),
            description: draft.status,
          };
        });
        if (offset + 8 < drafts.length) {
          options.push({
            number: '9',
            title: chinese ? '下一页' : 'Next page',
            description: '',
          });
          routes[9] = () => render(offset + 8);
        }
        session.showSelect({
          title: chinese ? 'Galaxy / 本地草稿' : 'Galaxy / Local drafts',
          options,
          routes,
          onBack: offset ? () => render(Math.max(0, offset - 8)) : back,
        });
      };
      render(0);
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese ? '无法读取本地草稿。' : 'Cannot read local drafts.',
          back,
        );
    }
  }

  async function reconcilePublicationDraft(
    onBack: Action,
    localDraftId: string,
  ) {
    session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const back = () => void showPublicationDrafts(onBack);
    session.showInfo(
      'Galaxy',
      chinese
        ? '正在核对原事件；Esc取消。'
        : 'Checking the original event; Esc cancels.',
      () => {
        session.controllerMethod('cancel')();
        back();
      },
    );
    try {
      const result = await session.controllerMethod('reconcilePublication')(
        localDraftId,
      );
      if (version !== session.connectionGeneration) return;
      const messages: Record<string, string> = chinese
        ? {
            acknowledged: '远端原事件内容匹配，本地回执已恢复。',
            unknown: '暂时无法核实；不代表未提交，请勿生成新事件重复发布。',
            mismatch: '远端内容与本地冻结草稿不匹配，需要进一步核对。',
            'not-prepared': '尚未准备发布，无原事件可核对。',
          }
        : {
            acknowledged: 'Original event matched; local receipt recovered.',
            unknown: 'Unable to verify; do not assume it was not submitted.',
            mismatch: 'Remote content differs from the frozen draft.',
            'not-prepared': 'No publication prepared.',
          };
      session.showInfo('Galaxy', messages[result.state] ?? result.state, back);
    } catch {
      if (version === session.connectionGeneration)
        session.showInfo(
          'Galaxy',
          chinese ? '核对未完成。' : 'Check incomplete.',
          back,
        );
    }
  }

  async function previewCaseSubmission(
    onBack: Action,
    localDraftId: string | null = null,
    visibility = 'Private',
  ) {
    session.requiredController();
    const version = ++session.connectionGeneration;
    const chinese = session.activeLanguage === 'zh-CN';
    const reopen = () => void session.showManagedConnection(onBack);
    const cancel = () => {
      session.connectionGeneration++;
      session.controllerMethod('cancel')();
      reopen();
    };
    try {
      const request = localDraftId
        ? null
        : await session.readCaseSubmission?.();
      if (version !== session.connectionGeneration) return;
      if (!request && !localDraftId)
        return session.showInfo(
          'Galaxy',
          chinese ? '没有已授权的选中草稿。' : 'No authorized draft selected.',
          reopen,
        );
      const preview = localDraftId
        ? await session.controllerMethod('preparePublication')(localDraftId, {
            visibility,
          })
        : await session.controllerMethod('prepareCase')(request);
      if (version !== session.connectionGeneration) {
        session.controllerMethod('cancel')();
        return;
      }
      let started = false;
      showExactChoice({
        preview,
        title: chinese
          ? '发送这份工作内容与范围'
          : 'Send this work content and scope',
        select: session.showSelect,
        info: session.showInfo,
        language: session.activeLanguage,
        isCurrent: () => version === session.connectionGeneration && !started,
        onCancel: cancel,
        onConfirm: async (value: string) => {
          if (version !== session.connectionGeneration || started) return;
          started = true;
          session.showInfo(
            'Galaxy',
            chinese
              ? '正在提交；Esc取消本地等待。'
              : 'Submitting; Esc cancels locally.',
            cancel,
          );
          try {
            await (localDraftId
              ? session.controllerMethod('executePublication')(preview, value)
              : session.controllerMethod('executeCase')(preview, value));
            if (version !== session.connectionGeneration) return;
            session.showInfo(
              'Galaxy',
              chinese
                ? '这份工作内容已保存，可以回到原工作继续。'
                : 'This work content was saved. Continue the original work.',
              reopen,
            );
          } catch {
            if (version === session.connectionGeneration)
              session.showInfo(
                'Galaxy',
                chinese
                  ? '发送结果尚未确认。已有提交可在原草稿中继续查询；请先查询同一次操作。'
                  : 'Sending is not confirmed. Continue checking this same operation from the original draft.',
                reopen,
              );
          }
        },
      });
    } catch {
      if (version === session.connectionGeneration) {
        session.controllerMethod('cancel')();
        session.showInfo(
          'Galaxy',
          chinese
            ? '无法准备草稿；没有提交。'
            : 'Draft preparation failed; nothing submitted.',
          reopen,
        );
      }
    }
  }

  return {
    showPublicationDrafts,
    reconcilePublicationDraft,
    previewCaseSubmission,
  };
}
