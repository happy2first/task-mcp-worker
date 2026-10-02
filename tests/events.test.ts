import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { TaskEvents, signature, signingKey, callbackUrl, expiration, eventIdentityParams, subscriptionId } from '../src/events.ts';
import type { Env } from '../src/types.ts';

// Run the real Store against SQLite; only the Cloudflare host base class is
// replaced. No task claiming, finish or event persistence logic is mocked.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }', shortCircuit: true };
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { TaskStoreDO } = await import('../src/store.ts');
const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
const rotated = 'whsec_' + Buffer.alloc(32, 8).toString('base64');
const env = { EVENTS_ENABLED: 'true', EVENTS_ALLOWED_PRINCIPALS: 'owner', EVENTS_CALLBACK_HOSTS: 'chatgpt.com', EVENTS_ENCRYPTION_KEY: 'a'.repeat(64) } as Env;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const ctx = { storage: {
    sql: { exec(query: string, ...bindings: any[]) { const statement = db.prepare(query); const rows = statement.all(...bindings); return { toArray: () => rows }; } },
    transactionSync(fn: () => any) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  } } as unknown as DurableObjectState;
  const store = new TaskStoreDO(ctx, env);
  const call = async (path: string, body: any) => {
    const response = await store.fetch(new Request('https://internal' + path, { method: 'POST', body: JSON.stringify(body) }));
    const data: any = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  const events = new TaskEvents(ctx, env);
  const raw = (taskId?: string, key = secret) => ({ name: 'task.due', arguments: taskId ? { taskId } : {}, delivery: { mode: 'webhook', url: 'https://chatgpt.com/callback', secret: key } });
  const create = (id = 'task_one', kind = 'once') => call('/tasks/create', { id, title: 'test', instruction: 'test task', schedule: kind === 'once' ? { kind: 'once', at: new Date(Date.now() - 60000).toISOString() } : { kind: 'interval', everyMinutes: 60 }, notification: { channels: ['weixin'], notifyOn: 'always' } });
  return { db, ctx, store, call, events, raw, create };
}
function mockCallbacks(handler?: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const request = new Request(input, init); requests.push(request.clone() as unknown as Request);
    const body: any = await request.clone().json();
    if (body.type === 'verification') return Response.json({ challenge: body.challenge });
    return handler ? handler(request) : new Response(null, { status: 204 });
  }) as typeof fetch;
  return { requests, restore() { globalThis.fetch = original; } };
}

test('Standard Webhooks HMAC matches independent implementation over exact bytes', async () => {
  const body = '{"x":"珠海"}';
  const expected = createHmac('sha256', Buffer.alloc(32, 7)).update(`evt_1.123.${body}`).digest('base64');
  assert.equal(await signature(secret, 'evt_1', 123, body), 'v1,' + expected);
  assert.notEqual(await signature(secret, 'evt_1', 124, body), 'v1,' + expected);
  assert.notEqual(await signature(secret, 'evt_1', 123, body + ' '), 'v1,' + expected);
});
test('secret validation rejects malformed base64 and unsafe key sizes', () => {
  for (const value of ['bad', 'whsec_abc', 'whsec_' + Buffer.alloc(23).toString('base64'), 'whsec_' + Buffer.alloc(65).toString('base64')]) assert.throws(() => signingKey(value));
  assert.equal(signingKey(secret).length, 32);
});
test('callbacks reject SSRF, credential URLs, non-HTTPS, ports, redirects to arbitrary hosts', () => {
  for (const url of ['http://chatgpt.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://chatgpt.com.evil.org/x', 'https://evil.org/x', 'https://user@chatgpt.com/x', 'https://chatgpt.com:8443/x', 'https://chatgpt.com/x#secret']) assert.throws(() => callbackUrl(url, env));
  assert.equal(callbackUrl('https://chatgpt.com/x', env), 'https://chatgpt.com/x');
  assert.throws(() => callbackUrl('https://api.openai.com/x', env));
  assert.throws(() => callbackUrl('https://evil.org/x', { ...env, EVENTS_CALLBACK_HOSTS: 'evil.org' }));
});
test('finite expiration honours short TTL, caps long TTL and rejects invalid values', () => {
  assert.equal(expiration(120000, 0), 120000); assert.equal(expiration(1, 0), 60000);
  assert.equal(expiration(null, 0), 86400000); assert.equal(expiration(1e12, 0), 604800000);
  for (const ttl of [-1, 0, '100', NaN, 1.5]) assert.throws(() => expiration(ttl, 0));
});
test('canonical subscription identity scopes principal and validates filters', async () => {
  const a = eventIdentityParams({ name: 'task.due', delivery: { mode: 'webhook', url: 'https://chatgpt.com/x' } });
  assert.equal(a.filters, '{}');
  assert.notEqual(await subscriptionId('a', a.url, a.filters), await subscriptionId('b', a.url, a.filters));
  assert.throws(() => eventIdentityParams({ name: 'task.due', arguments: { wrong: 1 }, delivery: { mode: 'webhook', url: 'https://chatgpt.com' } }));
});
test('subscribe verifies signed challenge, encrypts secrets, caches verification and renews in place', async () => {
  const f = fixture(), m = mockCallbacks();
  try {
    await f.create();
    const sub: any = await f.events.request('events/subscribe', 'owner', f.raw());
    const verification = m.requests[0], text = await verification.clone().text();
    assert.equal(verification.headers.get('webhook-signature'), await signature(secret, verification.headers.get('webhook-id')!, Number(verification.headers.get('webhook-timestamp')), text));
    assert.equal(verification.redirect, 'manual'); assert.equal(verification.headers.get('X-MCP-Subscription-Id'), sub.id);
    const again: any = await f.events.request('events/subscribe', 'owner', { ...f.raw(), ttlMs: 120000 });
    assert.equal(sub.id, again.id); assert.equal(m.requests.length, 1);
    const rows = f.db.prepare('SELECT * FROM event_subscriptions').all(); assert.equal(rows.length, 1); assert.notEqual(rows[0].secret, secret);
    assert.ok(Date.parse(again.refreshBefore) <= Date.now() + 120000);
    const restarted = new TaskEvents(f.ctx, env); await restarted.request('events/subscribe', 'owner', f.raw()); assert.equal(m.requests.length, 1);
  } finally { m.restore(); f.db.close(); }
});
test('wrong challenge, redirects and timeout never activate subscriptions', async () => {
  const f = fixture(); await f.create(); const original = globalThis.fetch;
  try {
    for (const status of [200, 302]) {
      globalThis.fetch = (async () => Response.json({ challenge: 'wrong' }, { status })) as typeof fetch;
      await assert.rejects(f.events.request('events/subscribe', 'owner', f.raw()), { code: -32015 });
    }
    globalThis.fetch = (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as typeof fetch;
    await assert.rejects(f.events.request('events/subscribe', 'owner', f.raw()), { code: -32015, reason: 'timeout' });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n, 0);
  } finally { globalThis.fetch = original; f.db.close(); }
});
test('discovery, authorization, unknown filters and no replay', async () => {
  const f = fixture(); const m = mockCallbacks(); await f.create();
  try {
    const catalog: any = await f.events.request('events/list', 'owner', {}); assert.equal(catalog.events[0].name, 'task.due');
    await assert.rejects(f.events.request('events/list', 'stranger', {}), { code: -32001 });
    await assert.rejects(f.events.request('events/subscribe', 'owner', f.raw('unknown')), { code: -32602 });
    await assert.rejects(f.events.request('events/subscribe', 'owner', { ...f.raw(), cursor: 'old' }), { code: -32602 });
  } finally { m.restore(); f.db.close(); }
});
test('events preserve atomic claim and notification flow, repeated ticks do not resend', async () => {
  const f = fixture(), m = mockCallbacks();
  try {
    await f.create(); await f.events.request('events/subscribe', 'owner', f.raw());
    await f.events.tick(); await f.events.tick();
    assert.equal(m.requests.length, 2);
    const event: any = await m.requests[1].clone().json(); assert.equal(event.name, 'task.due'); assert.equal(event.cursor, null); assert.equal(event.data.taskId, 'task_one');
    assert.equal(event.eventId, m.requests[1].headers.get('webhook-id'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM task_runs').get()!.n, 0);
    const claimed = await f.call('/claim', { claimedBy: 'chatgpt-hourly-poller', limit: 10 }); assert.equal(claimed.claimed, 1);
    assert.equal((await f.call('/claim', { claimedBy: 'event-executor' })).claimed, 0);
    await f.events.tick(); assert.equal(m.requests.length, 2);
    const finished = await f.call('/runs/finish', { runId: claimed.tasks[0].run.runId, success: true, notify: true, resultText: 'done' });
    assert.equal(finished.notificationPlan.shouldNotify, true); assert.ok(finished.notificationPlan.channels.includes('weixin')); assert.ok(finished.notificationPlan.channels.includes('ntfy'));
    assert.equal(finished.task.status, 'completed');
  } finally { m.restore(); f.db.close(); }
});
test('fallback works with events disabled and notify=false stays silent', async () => {
  const f = fixture();
  try {
    await f.create(); const events = new TaskEvents(f.ctx, { ...env, EVENTS_ENABLED: 'false' }); await events.tick();
    const claimed = await f.call('/claim', {}); assert.equal(claimed.claimed, 1);
    const result = await f.call('/runs/finish', { runId: claimed.tasks[0].run.runId, success: true, notify: false }); assert.equal(result.notificationPlan.shouldNotify, false);
  } finally { f.db.close(); }
});
test('filters, pause, resume and trigger produce only matching due occurrences', async () => {
  const f = fixture(), m = mockCallbacks();
  try {
    await f.create(); await f.create('task_two'); await f.events.request('events/subscribe', 'owner', f.raw('task_two'));
    await f.call('/tasks/pause', { id: 'task_two' }); await f.events.tick(); assert.equal(m.requests.length, 1);
    await f.call('/tasks/resume', { id: 'task_two' }); await f.call('/tasks/trigger', { id: 'task_two' }); await f.events.tick();
    assert.equal(m.requests.length, 2); assert.equal((await m.requests[1].json() as any).data.taskId, 'task_two');
  } finally { m.restore(); f.db.close(); }
});
test('transient delivery retries survive restart and preserve event ID and body', async () => {
  const f = fixture(), m = mockCallbacks(() => new Response(null, { status: 503 }));
  try {
    await f.create(); await f.events.request('events/subscribe', 'owner', f.raw()); await f.events.tick();
    let row = f.db.prepare('SELECT * FROM event_deliveries').get()!; assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1);
    await f.events.tick(); assert.equal(m.requests.length, 2);
    f.db.prepare('UPDATE event_deliveries SET retry_at=0').run(); await new TaskEvents(f.ctx, env).tick();
    assert.equal(m.requests.length, 3); assert.equal(await m.requests[1].text(), await m.requests[2].text());
    row = f.db.prepare('SELECT * FROM event_deliveries').get()!; assert.equal(row.attempts, 2);
    f.db.prepare('UPDATE event_deliveries SET attempts=7,retry_at=0').run(); await f.events.tick(); assert.equal(f.db.prepare('SELECT status FROM event_deliveries').get()!.status, 'dead');
  } finally { m.restore(); f.db.close(); }
});
test('410 unsubscribes; 413 and redirects are terminal without repeated delivery', async () => {
  for (const status of [410, 413, 302]) {
    const f = fixture(), m = mockCallbacks(() => new Response(null, { status }));
    try {
      await f.create(); await f.events.request('events/subscribe', 'owner', f.raw()); await f.events.tick(); await f.events.tick();
      assert.equal(m.requests.length, 2);
      if (status === 410) assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n, 0);
      else assert.equal(f.db.prepare('SELECT status FROM event_deliveries').get()!.status, 'dead');
    } finally { m.restore(); f.db.close(); }
  }
});
test('secret rotation verifies replacement and signs with both keys during grace window', async () => {
  const f = fixture(), m = mockCallbacks();
  try {
    await f.create(); await f.events.request('events/subscribe', 'owner', f.raw()); await f.events.request('events/subscribe', 'owner', f.raw(undefined, rotated)); await f.events.tick();
    assert.equal(m.requests.length, 3); const request = m.requests[2], text = await request.text();
    const id = request.headers.get('webhook-id')!, ts = Number(request.headers.get('webhook-timestamp'));
    assert.equal(request.headers.get('webhook-signature'), (await signature(rotated, id, ts, text)) + ' ' + (await signature(secret, id, ts, text)));
  } finally { m.restore(); f.db.close(); }
});
test('expiration, access revocation and idempotent unsubscribe stop pending deliveries', async () => {
  for (const action of ['expire', 'revoke', 'unsubscribe']) {
    const f = fixture(), m = mockCallbacks();
    try {
      await f.create(); await f.events.request('events/subscribe', 'owner', f.raw());
      if (action === 'expire') f.db.prepare('UPDATE event_subscriptions SET expires=0').run();
      if (action === 'unsubscribe') { await f.events.request('events/unsubscribe', 'owner', f.raw()); await f.events.request('events/unsubscribe', 'owner', f.raw()); }
      await (action === 'revoke' ? new TaskEvents(f.ctx, { ...env, EVENTS_ALLOWED_PRINCIPALS: '' }) : f.events).tick(); assert.equal(m.requests.length, 1);
    } finally { m.restore(); f.db.close(); }
  }
});
test('poller claims during retry window: stale webhook is cancelled', async () => {
  const f = fixture(), m = mockCallbacks(() => new Response(null, { status: 503 }));
  try {
    await f.create(); await f.events.request('events/subscribe', 'owner', f.raw()); await f.events.tick(); await f.call('/claim', {});
    f.db.prepare('UPDATE event_deliveries SET retry_at=0').run(); await f.events.tick(); assert.equal(m.requests.length, 2); assert.equal(f.db.prepare('SELECT status FROM event_deliveries').get()!.status, 'cancelled');
  } finally { m.restore(); f.db.close(); }
});
test('unsubscribe while first challenge is in flight cannot resurrect subscription', async () => {
  const f = fixture(); await f.create(); const original = globalThis.fetch;
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  globalThis.fetch = (async (input: any, init: any) => { const body: any = JSON.parse(init.body); entered(); await gate; return Response.json({ challenge: body.challenge }); }) as typeof fetch;
  try {
    const pending = f.events.request('events/subscribe', 'owner', f.raw()); await ready;
    await f.events.request('events/unsubscribe', 'owner', f.raw()); release();
    await assert.rejects(pending, { reason: 'subscription_changed_retry' }); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_subscriptions').get()!.n, 0);
  } finally { globalThis.fetch = original; f.db.close(); }
});
