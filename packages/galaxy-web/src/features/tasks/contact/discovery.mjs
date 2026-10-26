import { independentTaskLabel } from "../materials/task-material-client.mjs";
import { contactSourceRef } from './candidates.mjs';

// Search and source validation use the connection guard owned by the client.
export function createContactDiscovery({ runtime, taskId, check, clone, call, read }) {
  async function search(
    task,
    {
      keyword = '',
      functions = /** @type {string[]} */ ([]),
      after = {},
      only = /** @type {string | null} */ (null),
    } = {},
  ) {
    const requests = [
      {
        type: 'history',
        query: {
          query: keyword,
          context: { taskId },
          ...(task.request.capabilityId
            ? { capabilityId: task.request.capabilityId }
            : {}),
          timeWindow: { kind: 'all-visible' },
          limit: 8,
          after: after.history ?? null,
        },
      },
    ];
    if (functions.length)
      requests.push({
        type: 'opportunity',
        query: {
          context: { kind: 'ephemeral', title: independentTaskLabel(task,'关联任务'), functions },
          purposes: ['conversation', 'collaboration'],
          limit: 8,
          after: after.opportunity ?? null,
        },
      });
    return Promise.all(
      requests
        .filter((query) => !only || query.type === only)
        .map(async (query) => {
          try {
            return {
              ...(await call('/v2/search/query', query)),
              search: query,
              error: null,
            };
          } catch (error) {
            return {
              type: query.type,
              items: [],
              search: query,
              error: error.message,
              nextCursor: null,
            };
          }
        }),
    );
  }
  async function saveSuggestions(items, { confirmed = false } = {}) {
    if (!confirmed) throw Error('请确认本次建议和依据。');
    check(); items = clone(items);
    for (const candidate of items)
      for (const source of candidate.sources ?? []) {
        const view = await call('/v2/search/reference', {
          search: source.search,
          ref: source.item.ref,
        });
        if (view.state !== 'current')
          throw Error('所选来源已经变化或不可读取，请刷新清单后重新选择。');
      }
    const current = await read();
    return runtime.taskEvent(
      taskId,
      {
        kind: 'suggest-contacts',
        expectedTaskVersion: current.version,
        state: items.length ? 'ready' : 'empty',
        items: items.map((item) => ({
          subjectId: item.subjectId,
          help: item.help,
          basis: item.basis,
          conditions: item.conditions,
          sourceRefs:
            item.sources
              ?.map((source) => contactSourceRef(source.item))
              .slice(0, 16) ??
            item.sourceRefs ??
            [],
        })),
      },
      { confirmed: true, viewers: [current.requesterId] },
    );
  }
  return { search, saveSuggestions };
}
