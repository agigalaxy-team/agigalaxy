import { createCapsuleWebClient } from './capsule-workspace-client.mjs';
export function createConfigurationClient(options) {
  const journal = createCapsuleWebClient({
      ...options,
      operationFamily: 'configuration',
    }),
    { api, subjectId } = options;
  const read = async (path, input) => {
    const current = api.snapshot()?.subjectId,
      authenticated = !!subjectId && current === subjectId;
    const result = await api.call('/v2/configurations/' + path, input, {
      authenticated,
    });
    if (api.snapshot()?.subjectId !== current)
      throw Error('配置读取身份已变化。');
    return result;
  };
  return {
    ...journal,
    prepare: (payload, disclosure) =>
      journal.prepare('configuration', payload, disclosure),
    get: (input) => read('read', input),
    query: (input) => read('query', input),
    versions: (input) => read('versions', input),
  };
}
export function configurationChoice(view) {
  return {
    ref: { kind: 'configuration', id: view.id, version: view.version },
    authorId: view.subjectId,
    label: view.record.title,
    view,
  };
}
