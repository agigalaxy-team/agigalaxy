import { body, authenticate } from './request.mjs';
import { informationQuerySchema } from '../../shared/information-v2-schema.mjs';
import { ServiceError } from '../../shared/service-error.mjs';
export async function dispatchInformation({
  information,
  informationWatches,
  access,
  request,
  requestId,
  url,
  send,
  consumeSearchPage,
}) {
  if (request.method !== 'POST') return false;
  if (information && url.pathname === '/v2/information/query') {
    const authenticated = await authenticate(request, access, 'binding', true),
      actor = authenticated
        ? { ...authenticated, httpRequestId: requestId }
        : null;
    const parsed = informationQuerySchema.safeParse(await body(request));
    if (!parsed.success)
      throw new ServiceError('invalid_information_query', 400);
    const input = parsed.data;
    for (const selected of input.sources)
      consumeSearchPage(
        actor,
        selected.source?.request?.query?.after ??
          selected.source?.request?.after,
      );
    send(200, await information.query(actor, input));
    return true;
  }
  const methods = {
    command: 'command',
    stop: 'stop',
    list: 'list',
    receipt: 'receipt',
    check: 'check',
    events: 'events',
  };
  const path =
    /^\/v2\/information\/watches\/(command|stop|list|receipt|check|events)$/.exec(
      url.pathname,
    );
  if (!informationWatches || !path) return false;
  const actor = {
      ...(await authenticate(request, access, 'notifications')),
      httpRequestId: requestId,
    },
    input = await body(request);
  if (path[1] === 'list') consumeSearchPage(actor, input.after);
  if (path[1] === 'check') consumeSearchPage(actor);
  send(200, await informationWatches[methods[path[1]]](actor, input));
  return true;
}
