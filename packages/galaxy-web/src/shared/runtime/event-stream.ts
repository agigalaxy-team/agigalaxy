import type { QueryClient } from '@tanstack/react-query';
import type { GalaxyQueryScope } from './query-client';
import { createGalaxyEventDispatcher, type GalaxyWebEvent } from './event-dispatcher';

export function createGalaxyEventClient(options: {
  scope: GalaxyQueryScope; queryClient: QueryClient; url?: string; topics?: string[];
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch; onReset?: (modules: string[]) => void; onChange?: (event:GalaxyWebEvent)=>void; onResync?: (modules:string[])=>void; onError?: (error: unknown) => void;
  initialCursor?: string;
}) {
  const dispatch = createGalaxyEventDispatcher(options.queryClient, options.scope, options.onReset, options.initialCursor, {onChange:options.onChange,onResync:options.onResync});
  let controller: AbortController | undefined;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const path = options.scope.surface === 'admin' ? '/v1/operations/web-events' : '/v1/web-events';
      const url = new URL(options.url ?? path, options.scope.endpoint);
      if (options.initialCursor !== undefined || dispatch.cursor !== '0') url.searchParams.set('cursor', dispatch.cursor);
      if (options.topics?.length) url.searchParams.set('topics', options.topics.join(','));
      const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
      headers.set('Accept', 'text/event-stream');
      const response = await (options.fetch ?? fetch)(url, { headers, credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        if ([401, 403, 409].includes(response.status)) {
          await dispatch.dispatch({ type: 'reset', cursor: dispatch.cursor, modules: options.topics ?? [] });
          stopped = true;
        }
        throw new Error(`web_events_${response.status}`);
      }
      if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('web_events_stream_required');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 131072) throw new Error('web_events_frame_too_large');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) await dispatch.dispatch(JSON.parse(data) as GalaxyWebEvent);
        }
      }
    } catch (error) { if (!stopped) options.onError?.(error); }
    finally { if (!stopped) timer = setTimeout(connect, 1500); }
  };
  return {
    start() { if (!stopped) return; stopped = false; void connect(); },
    stop() { stopped = true; clearTimeout(timer); controller?.abort(); },
    get cursor() { return dispatch.cursor; },
  };
}
