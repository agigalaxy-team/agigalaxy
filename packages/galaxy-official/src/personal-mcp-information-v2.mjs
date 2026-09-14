import * as z from 'zod/v4';
import {
  informationQuerySchema,
  informationWatchCommandSchema,
  informationWatchReadSchema,
  informationWatchReceiptSchema,
  informationWatchCheckSchema,
} from './shared/information-v2-schema.mjs';
export function informationToolDefinitions(services, actor) {
  if (!services.information) return {};
  const tool = (scope, inputSchema, description, run, write = false) => ({
    scope,
    inputSchema,
    description,
    run,
    write,
  });
  return {
    galaxy_information_query: tool(
      'binding',
      informationQuerySchema,
      'Query the explicitly selected capability/history, evidence, scoped Honor and help sources. Each source rechecks its own scope/permission and keeps its own cursor, method, original dates and partial failures. Missing data is not lack of ability. Explain with the user model; all four help paths remain available.',
      (x) => services.information.query(actor, x),
    ),
    galaxy_information_watch_change: tool(
      'notifications',
      informationWatchCommandSchema,
      'Only on the user’s explicit source/purpose/expiry choice, start or revise information watching, pause, explicitly resume, or end it. Persist the exact operation ID before sending; reuse that ID on retry. No invite, public post or cloud model. Checks require a running user host; fixed daily change list is opt-in and empty reports are not sent.',
      (x) => services.informationWatches.command(actor, x),
      true,
    ),
    galaxy_information_watches: tool(
      'notifications',
      informationWatchReadSchema,
      'Read your own watches, true last check, expiry, pause and scope. Host runtime is not inferred from a stored active configuration.',
      (x) => services.informationWatches.list(actor, x),
    ),
    galaxy_information_watch_receipt: tool(
      'notifications',
      informationWatchReceiptSchema,
      'Reconcile the original watch operation and exact hash before retrying. An acknowledged watch command does not prove later checks ran.',
      (x) => services.informationWatches.receipt(actor, x),
    ),
    galaxy_information_watch_check: tool(
      'notifications',
      informationWatchCheckSchema,
      'Check an explicitly enabled watch once from the current user host. Respect nextCheckAt/backoff; unchanged data causes zero model calls. Incomplete source scans do not infer deletion. No other business action is authorized.',
      (x) => services.informationWatches.check(actor, x),
      true,
    ),
    galaxy_information_watch_events: tool(
      'notifications',
      z.strictObject({ watchId: z.uuid() }),
      'Read necessary change receipts and fresh authorized sources. Old receipt references never restore unavailable content or mark human notifications read.',
      (x) => services.informationWatches.events(actor, x),
    ),
  };
}
