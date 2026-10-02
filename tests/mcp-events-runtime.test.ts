import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

test('Cloudflare runtime: authenticated MCP 2.0 discovery, tools and Events coexist', async () => {
  const output = mkdtempSync(join(process.cwd(), '.runtime-test-'));
  // Build the actual deployed entry point. Miniflare/workerd bundled with the
  // pinned Wrangler currently supports dates through 2026-08-06; use that date
  // for the local smoke test only. Production wrangler.jsonc stays unchanged.
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', output], { stdio: 'pipe' });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test' };
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('owner').setIssuer('https://test.cloudflareaccess.com').setAudience('test-aud').setExpirationTime('1h').sign(privateKey);
  const delivered: any[] = [];
  const mf = new Miniflare({ modules: true, scriptPath: join(output, 'main.js'), compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'], durableObjects: { TASK_STORE: { className: 'TaskStoreDO', useSQLite: true } }, bindings: {
    TEAM_DOMAIN: 'https://test.cloudflareaccess.com', POLICY_AUD: 'test-aud', EVENTS_ENABLED: 'true', EVENTS_ALLOWED_PRINCIPALS: 'owner', EVENTS_CALLBACK_HOSTS: 'chatgpt.com', EVENTS_ENCRYPTION_KEY: 'a'.repeat(64),
  }, outboundService: async request => {
    if (request.url === 'https://test.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    const body: any = await request.json();
    if (body.type === 'verification') return Response.json({ challenge: body.challenge });
    delivered.push(body); return new Response(null, { status: 204 });
  } });
  const rpc = async (method: string, params: any = {}) => {
    const response = await mf.dispatchFetch('https://worker/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'cf-access-jwt-assertion': token, 'Mcp-Method': method, 'MCP-Protocol-Version': '2026-07-28', ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
  };
  try {
    const denied = await mf.dispatchFetch('https://worker/mcp', { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
    const discovery = await rpc('server/discover'); assert.ok(discovery.result.supportedVersions.includes('2026-07-28')); assert.deepEqual(discovery.result.capabilities.events, {}); assert.ok(discovery.result.capabilities.tools);
    const list = await rpc('events/list'); assert.equal(list.result.resultType, 'complete'); assert.equal(list.result.events[0].name, 'task.due');
    const tools = await rpc('tools/list'); assert.ok(tools.result.tools.some((tool: any) => tool.name === 'task_claim_due'));
    const create = await rpc('tools/call', { name: 'task_create', arguments: { id: 'task_runtime', title: 'test', instruction: 'run', schedule: { kind: 'once', at: new Date(Date.now() - 60000).toISOString() } } }); assert.ok(create.result.content);
    const params = { name: 'task.due', arguments: {}, delivery: { mode: 'webhook', url: 'https://chatgpt.com/callback', secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') } };
    const subscription = await rpc('events/subscribe', params); assert.ok(subscription.result.id); assert.equal(subscription.result.resultType, 'complete');
    const namespace = await mf.getDurableObjectNamespace('TASK_STORE'); const stub = namespace.get(namespace.idFromName('__task_store__'));
    await stub.fetch('https://internal/events/tick', { method: 'POST', body: '{}' }); assert.equal(delivered.length, 1);
    assert.equal(delivered[0].name, 'task.due');
    const claim = await rpc('tools/call', { name: 'task_claim_due', arguments: { claimedBy: 'chatgpt-hourly-poller', limit: 10 } });
    const claimed = JSON.parse(claim.result.content[0].text); assert.equal(claimed.claimed, 1);
    const repeated = await rpc('tools/call', { name: 'task_claim_due', arguments: { claimedBy: 'event-executor' } }); assert.equal(JSON.parse(repeated.result.content[0].text).claimed, 0);
    const finish = await rpc('tools/call', { name: 'task_run_finish', arguments: { runId: claimed.tasks[0].run.runId, success: true, notify: false } }); assert.equal(JSON.parse(finish.result.content[0].text).notificationPlan.shouldNotify, false);
    const stop = await rpc('events/unsubscribe', { ...params, delivery: { mode: 'webhook', url: params.delivery.url } }); assert.equal(stop.result.resultType, 'complete');
  } finally { await mf.dispose(); rmSync(output, { recursive: true, force: true }); }
});
