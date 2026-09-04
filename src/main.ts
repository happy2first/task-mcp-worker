import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { ADMIN_PAGE } from "./admin-page.js";
import { TaskStoreDO } from "./store.js";
import type { Env } from "./types.js";

export { TaskStoreDO };

const VERSION = "0.1.0";
const STORE_NAME = "__task_store__";
type JsonObject = Record<string, any>;
const toolResult = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function must(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`缺少配置：${name}`);
  return text;
}

async function verifyAccess(request: Request, env: Env) {
  const team = must(env.TEAM_DOMAIN, "TEAM_DOMAIN").replace(/\/$/, "");
  const aud = must(env.POLICY_AUD, "POLICY_AUD");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("缺少 Cloudflare Access JWT");
  const jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  return (await jwtVerify(token, jwks, { issuer: team, audience: aud })).payload;
}

function storeStub(env: Env) {
  return env.TASK_STORE.get(env.TASK_STORE.idFromName(STORE_NAME));
}

async function callStore(env: Env, path: string, init?: RequestInit): Promise<JsonObject> {
  const response = await storeStub(env).fetch(`https://task-store.internal${path}`, init as any);
  const data = await response.json().catch(() => ({ error: "invalid_json", message: "TaskStoreDO 返回了非 JSON 内容" })) as JsonObject;
  if (!response.ok) throw new Error(data.message || data.error || `TaskStoreDO HTTP ${response.status}`);
  return data;
}

async function callStoreRaw(env: Env, path: string): Promise<Response> {
  const upstream = await storeStub(env).fetch(`https://task-store.internal${path}`);
  const headers = new Headers(upstream.headers);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

const postStore = (env: Env, path: string, body: unknown) => callStore(env, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function notificationSchema() {
  return z.object({
    channels: z.array(z.enum(["chatgpt", "weixin", "email", "ntfy"])).min(1).max(4).optional(),
    notifyOn: z.enum(["always", "success", "failure"]).optional(),
    weixinRecipients: z.array(z.string().min(1).max(120)).max(10).optional(),
    emailTo: z.array(z.string().email()).max(20).optional(),
    ntfyTopic: z.string().max(200).optional(),
  }).optional();
}

function scheduleSchema() {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once"), at: z.string().min(1), timezone: z.string().max(100).optional() }),
    z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525600), startAt: z.string().optional(), timezone: z.string().max(100).optional() }),
    z.object({ kind: z.literal("cron"), expression: z.string().min(1).max(120), timezone: z.string().max(100).optional() }),
  ]);
}

function createServer(env: Env) {
  const server = new McpServer({ name: "task-mcp-worker", version: VERSION });

  server.registerTool("task_status", {
    description: "查看定时任务助手的任务、执行记录和附件存储概况。",
    inputSchema: {},
  }, async () => toolResult(await callStore(env, "/status")));

  server.registerTool("task_create", {
    description: "新增任务。instruction 应写成未来轮询任务领取后可直接执行的完整指令；schedule 支持 once、interval、cron。",
    inputSchema: {
      id: z.string().regex(/^[A-Za-z0-9_-]{3,120}$/).optional(),
      title: z.string().min(1).max(200),
      instruction: z.string().min(1).max(70_000),
      schedule: scheduleSchema(),
      notification: notificationSchema(),
    },
  }, async (args) => toolResult(await postStore(env, "/tasks/create", args)));

  server.registerTool("task_update", {
    description: "修改已有任务。只传需要修改的字段；修改 schedule 时会重新计算下一次执行时间。",
    inputSchema: {
      id: z.string().min(3).max(120),
      title: z.string().min(1).max(200).optional(),
      instruction: z.string().min(1).max(70_000).optional(),
      schedule: scheduleSchema().optional(),
      notification: notificationSchema(),
    },
  }, async (args) => toolResult(await postStore(env, "/tasks/update", args)));

  server.registerTool("task_delete", {
    description: "删除任务，并同时删除该任务的执行明细和附件。",
    inputSchema: { id: z.string().min(3).max(120) },
  }, async ({ id }) => toolResult(await postStore(env, "/tasks/delete", { id })));

  server.registerTool("task_list", {
    description: "查询任务列表，可按 active、paused、completed 状态筛选。",
    inputSchema: { status: z.enum(["active", "paused", "completed"]).optional(), limit: z.number().int().min(1).max(500).optional().default(100) },
  }, async ({ status, limit }) => toolResult(await callStore(env, `/tasks?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ""}`)));

  server.registerTool("task_get", {
    description: "读取一个任务的完整配置。",
    inputSchema: { id: z.string().min(3).max(120) },
  }, async ({ id }) => toolResult(await callStore(env, `/tasks/${encodeURIComponent(id)}`)));

  server.registerTool("task_pause", {
    description: "暂停任务；暂停后不会被轮询领取。",
    inputSchema: { id: z.string().min(3).max(120) },
  }, async ({ id }) => toolResult(await postStore(env, "/tasks/pause", { id })));

  server.registerTool("task_resume", {
    description: "恢复已暂停任务。若原定时间已经过去，会从当前时间重新计算下一次执行时间。",
    inputSchema: { id: z.string().min(3).max(120) },
  }, async ({ id }) => toolResult(await postStore(env, "/tasks/resume", { id })));

  server.registerTool("task_trigger_now", {
    description: "把任务标记为立即到期，使下一次 task_claim_due 可以领取它。",
    inputSchema: { id: z.string().min(3).max(120) },
  }, async ({ id }) => toolResult(await postStore(env, "/tasks/trigger", { id })));

  server.registerTool("task_claim_due", {
    description: "供 ChatGPT 的唯一小时级轮询任务调用：原子领取已到期任务并创建/续租 runId。领取后必须执行每个 task.instruction，并用对应 runId 调 task_run_finish。无到期任务时返回空数组。",
    inputSchema: {
      limit: z.number().int().min(1).max(20).optional().default(10),
      leaseMinutes: z.number().int().min(15).max(360).optional().default(90),
      claimedBy: z.string().min(1).max(120).optional().default("chatgpt"),
    },
  }, async (args) => toolResult(await postStore(env, "/claim", args)));

  server.registerTool("task_run_finish", {
    description: "回写一个已领取任务的执行结果。notify=false 表示本次巡检无需通知；返回 notificationPlan.shouldNotify 明确指示调用方是否应发送微信/邮件/ntfy等通知。",
    inputSchema: {
      runId: z.string().min(5).max(120),
      success: z.boolean(),
      notify: z.boolean().optional().default(true),
      resultText: z.string().max(100_000).optional(),
      errorText: z.string().max(30_000).optional(),
    },
  }, async (args) => toolResult(await postStore(env, "/runs/finish", args)));

  server.registerTool("task_run_record_notifications", {
    description: "在调用微信、邮件、ntfy 等外部通知工具后，将各渠道通知结果写回执行明细。",
    inputSchema: { runId: z.string().min(5).max(120), results: z.array(z.any()).max(50) },
  }, async (args) => toolResult(await postStore(env, "/runs/notifications", args)));

  server.registerTool("task_run_list", {
    description: "查询任务执行明细。",
    inputSchema: { taskId: z.string().max(120).optional(), limit: z.number().int().min(1).max(500).optional().default(100), offset: z.number().int().min(0).optional().default(0) },
  }, async ({ taskId, limit, offset }) => toolResult(await callStore(env, `/runs?limit=${limit}&offset=${offset}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ""}`)));

  server.registerTool("task_run_get", {
    description: "读取一条执行明细。",
    inputSchema: { runId: z.string().min(5).max(120) },
  }, async ({ runId }) => toolResult(await callStore(env, `/runs/${encodeURIComponent(runId)}`)));

  server.registerTool("task_attachment_add", {
    description: "给任务保存附件。附件存入 SQLite-backed Durable Object 并按 1 MiB 分块，不使用 R2。当前单附件上限 10 MiB。",
    inputSchema: { taskId: z.string().min(3).max(120), fileName: z.string().min(1).max(180), mimeType: z.string().max(160).optional(), dataBase64: z.string().min(1) },
  }, async (args) => toolResult(await postStore(env, "/attachments/add", args)));

  server.registerTool("task_attachment_list", {
    description: "列出一个任务保存的附件元数据和 attachmentRef。",
    inputSchema: { taskId: z.string().min(3).max(120) },
  }, async ({ taskId }) => toolResult(await callStore(env, `/attachments?taskId=${encodeURIComponent(taskId)}`)));

  server.registerTool("task_attachment_get", {
    description: "读取 attachmentRef 对应的附件。小文件以内嵌 MCP resource 返回。",
    inputSchema: { attachmentRef: z.string().min(5).max(120) },
  }, async ({ attachmentRef }) => {
    const response = await callStoreRaw(env, `/attachments/${encodeURIComponent(attachmentRef)}`);
    if (!response.ok) throw new Error(`读取附件失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || "application/octet-stream";
    const data = Buffer.from(bytes).toString("base64");
    return { content: [{ type: "resource", resource: { uri: `task-attachment://${encodeURIComponent(attachmentRef)}`, mimeType, blob: data } }] as any };
  });

  server.registerTool("task_attachment_delete", {
    description: "删除一个任务附件。",
    inputSchema: { attachmentRef: z.string().min(5).max(120) },
  }, async ({ attachmentRef }) => toolResult(await postStore(env, "/attachments/delete", { attachmentRef })));

  return server;
}

async function handleAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && pathname === "/admin/api/status") return Response.json(await callStore(env, "/status"));
  if (request.method === "GET" && pathname === "/admin/api/tasks") return Response.json(await callStore(env, `/tasks?limit=${encodeURIComponent(url.searchParams.get("limit") || "500")}`));
  if (request.method === "GET" && pathname.startsWith("/admin/api/tasks/")) {
    const id = decodeURIComponent(pathname.slice("/admin/api/tasks/".length));
    return Response.json(await callStore(env, `/tasks/${encodeURIComponent(id)}`));
  }
  if (request.method === "GET" && pathname === "/admin/api/runs") {
    const query = url.searchParams.toString();
    return Response.json(await callStore(env, `/runs${query ? `?${query}` : ""}`));
  }
  if (request.method === "GET" && pathname === "/admin/api/attachments") {
    const taskId = url.searchParams.get("taskId") || "";
    return Response.json(await callStore(env, `/attachments?taskId=${encodeURIComponent(taskId)}`));
  }
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const map: Record<string, string> = {
    "/admin/api/tasks/create": "/tasks/create",
    "/admin/api/tasks/update": "/tasks/update",
    "/admin/api/tasks/delete": "/tasks/delete",
    "/admin/api/tasks/pause": "/tasks/pause",
    "/admin/api/tasks/resume": "/tasks/resume",
    "/admin/api/tasks/trigger": "/tasks/trigger",
    "/admin/api/attachments/add": "/attachments/add",
    "/admin/api/attachments/delete": "/attachments/delete",
  };
  const target = map[pathname];
  if (!target) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(await postStore(env, target, body));
}

function accessDenied(error: unknown) {
  return Response.json({ error: "access_denied", message: error instanceof Error ? error.message : String(error) }, { status: 403 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.json({ ok: true, service: "task-mcp-worker", version: VERSION, mcp: "/mcp", admin: "/admin", health: "/health" });
    const allowed = url.pathname === "/mcp" || url.pathname === "/health" || url.pathname === "/admin" || url.pathname.startsWith("/admin/api/") || url.pathname.startsWith("/admin/attachment/");
    if (!allowed) return new Response("Not Found", { status: 404 });

    let identity;
    try { identity = await verifyAccess(request, env); } catch (error) { return accessDenied(error); }

    if (url.pathname === "/admin") {
      return new Response(ADMIN_PAGE, { headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      } });
    }

    if (url.pathname.startsWith("/admin/attachment/")) {
      const ref = decodeURIComponent(url.pathname.slice("/admin/attachment/".length));
      const response = await callStoreRaw(env, `/attachments/${encodeURIComponent(ref)}`);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "private, max-age=3600");
      headers.set("x-robots-tag", "noindex, nofollow");
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname.startsWith("/admin/api/")) {
      if (request.method !== "GET") {
        const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json") return Response.json({ error: "unsupported_media_type", message: "管理 API 仅接受 application/json" }, { status: 415 });
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return Response.json({ error: "cross_origin_denied", message: "拒绝跨站管理请求" }, { status: 403 });
      }
      try {
        const response = await handleAdmin(request, env, url.pathname);
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-content-type-options", "nosniff");
        return new Response(response.body, { status: response.status, headers });
      } catch (error) {
        return Response.json({ error: "admin_error", message: error instanceof Error ? error.message : String(error) }, { status: 400, headers: { "cache-control": "no-store" } });
      }
    }

    if (url.pathname === "/health") {
      try { return Response.json({ ok: true, service: "task-mcp-worker", version: VERSION, user: identity.email || identity.sub || "authenticated", store: await callStore(env, "/status") }); }
      catch (error) { return Response.json({ ok: false, service: "task-mcp-worker", version: VERSION, error: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
    }

    return createMcpHandler(() => createServer(env), { route: "/mcp", responseMode: "json" })(request, env, ctx);
  },
};
