import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventDiagnostic } from '../src/events-diagnostics.ts';

test('subscription diagnostics retain host and reason but exclude secrets and callback tokens', () => {
  const log = eventDiagnostic('events/subscribe', {
    delivery: { url: 'https://user:password@callback.chatgpt.com/private-token?token=query-secret#fragment', secret: 'whsec_signing-secret' },
    arguments: { taskId: 'private-task' },
  }, false, { reason: 'callback_host_not_allowed', code: -32602, message: 'sensitive-error', details: { secret: 'leak' } }, true, true);
  assert.deepEqual(log, { message: 'mcp_events_rpc', method: 'events/subscribe', ok: false, enabled: true, authorized: true, callbackHost: 'callback.chatgpt.com', reason: 'callback_host_not_allowed', code: -32602 });
});

test('invalid callbacks and unexpected errors never leak raw input or exception messages', () => {
  const log = eventDiagnostic('private-method', { delivery: { url: 'not a URL with secret' } }, false, { reason: 'secret-error', code: 'secret-code' }, true, false);
  assert.deepEqual(log, { message: 'mcp_events_rpc', method: 'unknown', ok: false, enabled: true, authorized: false, reason: 'internal_error', code: -32603 });
  assert.deepEqual(eventDiagnostic('events/list', null, true, null, true, true), { message: 'mcp_events_rpc', method: 'events/list', ok: true, enabled: true, authorized: true });
});
