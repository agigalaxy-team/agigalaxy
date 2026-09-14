import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHelpTools } from '../src/help-tools-v2.mjs';

test('help errors expose exact recovery without echoing arbitrary error payloads', async () => {
  const handlers = new Map(); let reason;
  registerHelpTools({ registerTool: (name, _schema, run) => handlers.set(name, run) }, {
    flow: { start: async () => { throw new Error(reason); } },
  });
  reason = 'help_reconcile_original_operation';
  const pending = await handlers.get('galaxy_help_start')({});
  assert.equal(pending.isError, true);
  assert.equal(pending.structuredContent.recovery, 'reconcile-original-operation-do-not-resubmit');
  assert.equal(pending.structuredContent.automaticRetryAuthorized, false);
  reason = 'private transport body must never leave this boundary';
  const unknown = await handlers.get('galaxy_help_start')({});
  assert.equal(unknown.structuredContent.error, 'help_operation_failed');
  assert.ok(!JSON.stringify(unknown).includes(reason));
  assert.deepEqual(JSON.parse(unknown.content[0].text), unknown.structuredContent);
});
