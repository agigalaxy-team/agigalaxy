import { createCapsuleWebClient } from "../capsules/capsule-workspace-client.mjs";
export function createConfigurationClient(options) {
  const journal = createCapsuleWebClient({
      ...options,
      operationFamily: 'configuration',
    }),
    { api, subjectId } = options,
    endpoint = api.endpoint;
  const capture = () => {
    const value = api.snapshot();
    return JSON.stringify([api.endpoint, value?.subjectId ?? null,
      value?.bindingId ?? null, value?.generation ?? null,
      value?.control?.deviceId ?? null, value?.control?.epoch ?? null]);
  };
  const read = async (path, input) => {
    const lease = capture(), current = api.snapshot()?.subjectId,
      authenticated = !!subjectId && current === subjectId;
    if (api.endpoint !== endpoint) throw Error('配置读取服务已变化。');
    const result = await api.call('/v2/configurations/' + path, input, {
      authenticated,
    });
    if (capture() !== lease)
      throw Error('配置读取身份或连接已变化。');
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
