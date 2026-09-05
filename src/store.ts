import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";
import { initialNextDue, nextDueAfterClaim, normalizeSchedule } from "./schedule.js";
import type { AttachmentRecord, Env, NotificationConfig, RunRecord, TaskRecord } from "./types.js";

const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_LEASE_MINUTES = 90;
const DEFAULT_NTFY_TOPIC = "Task-Monitor";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const errText = (error: unknown) => error instanceof Error ? error.message : String(error);

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function cleanNotification(input: unknown): NotificationConfig {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const allowed = new Set(["chatgpt", "weixin", "email", "ntfy"]);
  let channels = Array.isArray(raw.channels)
    ? [...new Set(raw.channels.map(String).filter((x) => allowed.has(x)))] as NotificationConfig["channels"]
    : [] as NotificationConfig["channels"];
  const ntfyDisabled = raw.ntfyDisabled === true;
  if (ntfyDisabled) channels = channels.filter((channel) => channel !== "ntfy");
  else if (!channels.includes("ntfy")) channels.push("ntfy");
  const notifyOn = ["always", "success", "failure"].includes(String(raw.notifyOn)) ? String(raw.notifyOn) as NotificationConfig["notifyOn"] : "always";
  const strings = (v: unknown, max: number) => Array.isArray(v) ? [...new Set(v.map(String).map((s) => s.trim()).filter(Boolean))].slice(0, max) : undefined;
  const ntfyTopic = String(raw.ntfyTopic || DEFAULT_NTFY_TOPIC).trim().slice(0, 200) || DEFAULT_NTFY_TOPIC;
  return {
    channels,
    notifyOn,
    ...(strings(raw.weixinRecipients, 10)?.length ? { weixinRecipients: strings(raw.weixinRecipients, 10) } : {}),
    ...(strings(raw.emailTo, 20)?.length ? { emailTo: strings(raw.emailTo, 20) } : {}),
    ...(channels.includes("ntfy") ? { ntfyTopic } : {}),
    ...(ntfyDisabled ? { ntfyDisabled: true } : {}),
  } as NotificationConfig;
}

type TaskRow = {
  id: string; title: string; instruction: string; status: string; schedule_json: string; next_due_at: string | null;
  notification_json: string; created_at: string; updated_at: string; completed_at: string | null;
};
type RunRow = {
  run_id: string; task_id: string; scheduled_for: string; status: string; attempt: number; claimed_by: string | null;
  claimed_at: string | null; lease_until: string | null; finished_at: string | null; result_text: string | null;
  error_text: string | null; notification_results_json: string | null; created_at: string; updated_at: string;
};
type AttachmentRow = {
  attachment_ref: string; task_id: string; file_name: string; mime_type: string; size_bytes: number; chunk_count: number; created_at: string;
};

export class TaskStoreDO extends DurableObject<Env> {
  private ensureSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      next_due_at TEXT,
      notification_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status,next_due_at)");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_until TEXT,
      finished_at TEXT,
      result_text TEXT,
      error_text TEXT,
      notification_results_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id,created_at DESC)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status,lease_until)");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS attachments (
      attachment_ref TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id,created_at)");
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS attachment_chunks (
      attachment_ref TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY(attachment_ref,chunk_index)
    )`);
  }

  private taskFromRow(row: TaskRow): TaskRecord {
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM attachments WHERE task_id=?", row.id).toArray()[0];
    return {
      id: row.id,
      title: row.title,
      instruction: row.instruction,
      status: row.status as TaskRecord["status"],
      schedule: parseJson(row.schedule_json, { kind: "once", at: row.created_at }),
      nextDueAt: row.next_due_at,
      notification: cleanNotification(parseJson(row.notification_json, {})),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      attachmentCount: Number(count?.n || 0),
    };
  }

  private runFromRow(row: RunRow): RunRecord {
    return {
      runId: row.run_id,
      taskId: row.task_id,
      scheduledFor: row.scheduled_for,
      status: row.status as RunRecord["status"],
      attempt: Number(row.attempt || 1),
      claimedBy: row.claimed_by,
      claimedAt: row.claimed_at,
      leaseUntil: row.lease_until,
      finishedAt: row.finished_at,
      resultText: row.result_text,
      errorText: row.error_text,
      notificationResults: parseJson(row.notification_results_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private attachmentFromRow(row: AttachmentRow): AttachmentRecord {
    return { attachmentRef: row.attachment_ref, taskId: row.task_id, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), chunkCount: Number(row.chunk_count), createdAt: row.created_at };
  }

  private task(id: string) {
    const row = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id=?", id).toArray()[0];
    if (!row) throw new Error(`任务 ${id} 不存在`);
    return this.taskFromRow(row);
  }

  private createTask(body: Record<string, unknown>) {
    this.ensureSchema();
    const title = String(body.title || "").trim();
    const instruction = String(body.instruction || "").trim();
    if (!title || title.length > 200) throw new Error("title 不能为空且最多 200 字符");
    if (!instruction || instruction.length > 70_000) throw new Error("instruction 不能为空且最多 70000 字符");
    const schedule = normalizeSchedule(body.schedule);
    const notification = cleanNotification(body.notification);
    const now = new Date();
    const id = String(body.id || `task_${crypto.randomUUID().replace(/-/g, "")}`).trim();
    if (!/^[A-Za-z0-9_-]{3,120}$/.test(id)) throw new Error("id 仅允许字母、数字、下划线和短横线，长度 3-120");
    const due = initialNextDue(schedule, now);
    const iso = now.toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO tasks(id,title,instruction,status,schedule_json,next_due_at,notification_json,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
      id, title, instruction, "active", JSON.stringify(schedule), due, JSON.stringify(notification), iso, iso,
    );
    return { success: true, task: this.task(id) };
  }

  private updateTask(body: Record<string, unknown>) {
    this.ensureSchema();
    const id = String(body.id || "").trim();
    const current = this.task(id);
    const title = body.title === undefined ? current.title : String(body.title || "").trim();
    const instruction = body.instruction === undefined ? current.instruction : String(body.instruction || "").trim();
    if (!title || title.length > 200) throw new Error("title 不能为空且最多 200 字符");
    if (!instruction || instruction.length > 70_000) throw new Error("instruction 不能为空且最多 70000 字符");
    const schedule = body.schedule === undefined ? current.schedule : normalizeSchedule(body.schedule);
    const notification = body.notification === undefined ? current.notification : cleanNotification(body.notification);
    const scheduleChanged = body.schedule !== undefined;
    const due = scheduleChanged ? initialNextDue(schedule, new Date()) : current.nextDueAt;
    const reactivateCompleted = scheduleChanged && current.status === "completed";
    const status = reactivateCompleted ? "active" : current.status;
    const completedAt = reactivateCompleted ? null : current.completedAt || null;
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "UPDATE tasks SET title=?,instruction=?,status=?,schedule_json=?,next_due_at=?,notification_json=?,updated_at=?,completed_at=? WHERE id=?",
      title, instruction, status, JSON.stringify(schedule), due, JSON.stringify(notification), now, completedAt, id,
    );
    return { success: true, task: this.task(id) };
  }

  private setStatus(id: string, status: "active" | "paused") {
    const current = this.task(id);
    const now = new Date();
    let due = current.nextDueAt;
    if (status === "active" && (!due || new Date(due).getTime() <= now.getTime())) due = initialNextDue(current.schedule, now);
    this.ctx.storage.sql.exec("UPDATE tasks SET status=?,next_due_at=?,updated_at=?,completed_at=NULL WHERE id=?", status, due, now.toISOString(), id);
    return { success: true, task: this.task(id) };
  }

  private deleteTask(id: string) {
    this.task(id);
    const refs = this.ctx.storage.sql.exec<{ attachment_ref: string }>("SELECT attachment_ref FROM attachments WHERE task_id=?", id).toArray();
    this.ctx.storage.transactionSync(() => {
      for (const ref of refs) this.ctx.storage.sql.exec("DELETE FROM attachment_chunks WHERE attachment_ref=?", ref.attachment_ref);
      this.ctx.storage.sql.exec("DELETE FROM attachments WHERE task_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM task_runs WHERE task_id=?", id);
      this.ctx.storage.sql.exec("DELETE FROM tasks WHERE id=?", id);
    });
    return { success: true, deleted: id };
  }

  private listTasks(url: URL) {
    this.ensureSchema();
    const status = url.searchParams.get("status")?.trim();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const rows = status
      ? this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE status=? ORDER BY COALESCE(next_due_at,'9999') ASC, created_at DESC LIMIT ?", status, limit).toArray()
      : this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks ORDER BY COALESCE(next_due_at,'9999') ASC, created_at DESC LIMIT ?", limit).toArray();
    return { tasks: rows.map((r) => this.taskFromRow(r)), total: rows.length };
  }

  private triggerNow(id: string) {
    this.task(id);
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE tasks SET status='active',next_due_at=?,updated_at=?,completed_at=NULL WHERE id=?", now, now, id);
    return { success: true, task: this.task(id) };
  }

  private claimDue(body: Record<string, unknown>) {
    this.ensureSchema();
    const now = body.now ? new Date(String(body.now)) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("now 不是有效时间");
    const limit = Math.min(20, Math.max(1, Number(body.limit || 10)));
    const leaseMinutes = Math.min(360, Math.max(15, Number(body.leaseMinutes || DEFAULT_LEASE_MINUTES)));
    const claimedBy = String(body.claimedBy || "chatgpt").trim().slice(0, 120) || "chatgpt";
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMinutes * 60_000).toISOString();
    const due = this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE status='active' AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at ASC LIMIT ?", nowIso, limit * 2).toArray();
    const claimed: Array<{ task: TaskRecord; run: RunRecord; attachments: AttachmentRecord[] }> = [];

    for (const row of due) {
      if (claimed.length >= limit) break;
      const task = this.taskFromRow(row);
      const existing = this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE task_id=? AND status='claimed' ORDER BY created_at DESC LIMIT 1", task.id).toArray()[0];
      if (existing && existing.lease_until && new Date(existing.lease_until).getTime() > now.getTime()) continue;

      let runId: string;
      this.ctx.storage.transactionSync(() => {
        if (existing) {
          runId = existing.run_id;
          this.ctx.storage.sql.exec("UPDATE task_runs SET attempt=attempt+1,claimed_by=?,claimed_at=?,lease_until=?,updated_at=? WHERE run_id=?", claimedBy, nowIso, leaseUntil, nowIso, runId);
        } else {
          runId = `run_${crypto.randomUUID().replace(/-/g, "")}`;
          this.ctx.storage.sql.exec(
            "INSERT INTO task_runs(run_id,task_id,scheduled_for,status,attempt,claimed_by,claimed_at,lease_until,finished_at,result_text,error_text,notification_results_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,'[]',?,?)",
            runId, task.id, task.nextDueAt || nowIso, "claimed", 1, claimedBy, nowIso, leaseUntil, nowIso, nowIso,
          );
        }
        const nextDue = nextDueAfterClaim(task.schedule, now);
        if (task.schedule.kind === "once") {
          this.ctx.storage.sql.exec("UPDATE tasks SET next_due_at=NULL,updated_at=? WHERE id=?", nowIso, task.id);
        } else {
          this.ctx.storage.sql.exec("UPDATE tasks SET next_due_at=?,updated_at=? WHERE id=?", nextDue, nowIso, task.id);
        }
      });
      const run = this.runFromRow(this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId!).toArray()[0]);
      const attachments = this.ctx.storage.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE task_id=? ORDER BY created_at", task.id).toArray().map((r) => this.attachmentFromRow(r));
      claimed.push({ task: this.task(task.id), run, attachments });
    }
    return { success: true, claimed: claimed.length, tasks: claimed, checkedAt: nowIso };
  }

  private finishRun(body: Record<string, unknown>) {
    this.ensureSchema();
    const runId = String(body.runId || "").trim();
    const success = Boolean(body.success);
    const notifyRequested = body.notify === undefined ? true : Boolean(body.notify);
    const row = this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId).toArray()[0];
    if (!row) throw new Error(`执行记录 ${runId} 不存在`);
    if (row.status !== "claimed") throw new Error(`执行记录 ${runId} 已结束，当前状态 ${row.status}`);
    const now = new Date().toISOString();
    const resultText = String(body.resultText || "").slice(0, 100_000) || null;
    const errorText = String(body.errorText || "").slice(0, 30_000) || null;
    this.ctx.storage.sql.exec("UPDATE task_runs SET status=?,finished_at=?,result_text=?,error_text=?,lease_until=NULL,updated_at=? WHERE run_id=?", success ? "succeeded" : "failed", now, resultText, errorText, now, runId);
    const task = this.task(row.task_id);
    if (task.schedule.kind === "once") {
      this.ctx.storage.sql.exec("UPDATE tasks SET status='completed',completed_at=?,updated_at=? WHERE id=?", now, now, task.id);
    }
    const shouldNotify = notifyRequested && task.notification.channels.length > 0 && (task.notification.notifyOn === "always" || (success && task.notification.notifyOn === "success") || (!success && task.notification.notifyOn === "failure"));
    return {
      success: true,
      run: this.runFromRow(this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId).toArray()[0]),
      task: this.task(task.id),
      notificationPlan: shouldNotify ? { shouldNotify: true, ...task.notification } : { shouldNotify: false, channels: [], notifyOn: task.notification.notifyOn },
    };
  }

  private recordNotifications(body: Record<string, unknown>) {
    const runId = String(body.runId || "").trim();
    const row = this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId).toArray()[0];
    if (!row) throw new Error(`执行记录 ${runId} 不存在`);
    const results = Array.isArray(body.results) ? body.results.slice(0, 50) : [];
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("UPDATE task_runs SET notification_results_json=?,updated_at=? WHERE run_id=?", JSON.stringify(results), now, runId);
    return { success: true, run: this.runFromRow(this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId).toArray()[0]) };
  }

  private listRuns(url: URL) {
    this.ensureSchema();
    const taskId = url.searchParams.get("taskId")?.trim();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const rows = taskId
      ? this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE task_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", taskId, limit, offset).toArray()
      : this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset).toArray();
    return { runs: rows.map((r) => this.runFromRow(r)), limit, offset };
  }

  private getRun(runId: string) {
    const row = this.ctx.storage.sql.exec<RunRow>("SELECT * FROM task_runs WHERE run_id=?", runId).toArray()[0];
    if (!row) throw new Error(`执行记录 ${runId} 不存在`);
    return { run: this.runFromRow(row), task: this.task(row.task_id) };
  }

  private listAttachments(taskId: string) {
    this.ensureSchema();
    this.task(taskId);
    const rows = this.ctx.storage.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE task_id=? ORDER BY created_at", taskId).toArray();
    return { attachments: rows.map((row) => this.attachmentFromRow(row)), total: rows.length };
  }

  private addAttachment(body: Record<string, unknown>) {
    this.ensureSchema();
    const taskId = String(body.taskId || "").trim();
    this.task(taskId);
    const fileName = String(body.fileName || "attachment.bin").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "attachment.bin";
    const mimeType = String(body.mimeType || "application/octet-stream").trim().slice(0, 160) || "application/octet-stream";
    const dataBase64 = String(body.dataBase64 || "").trim();
    if (!dataBase64) throw new Error("dataBase64 不能为空");
    const bytes = new Uint8Array(Buffer.from(dataBase64, "base64"));
    if (!bytes.byteLength) throw new Error("附件为空或 base64 无效");
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 上限`);
    const attachmentRef = `att_${crypto.randomUUID().replace(/-/g, "")}`;
    const chunkCount = Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTES);
    const createdAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO attachments(attachment_ref,task_id,file_name,mime_type,size_bytes,chunk_count,created_at) VALUES(?,?,?,?,?,?,?)", attachmentRef, taskId, fileName, mimeType, bytes.byteLength, chunkCount, createdAt);
      for (let i = 0; i < chunkCount; i++) {
        const chunk = bytes.slice(i * ATTACHMENT_CHUNK_BYTES, Math.min((i + 1) * ATTACHMENT_CHUNK_BYTES, bytes.byteLength));
        this.ctx.storage.sql.exec("INSERT INTO attachment_chunks(attachment_ref,chunk_index,data) VALUES(?,?,?)", attachmentRef, i, chunk.slice().buffer as ArrayBuffer);
      }
    });
    return { success: true, attachment: this.attachmentFromRow(this.ctx.storage.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE attachment_ref=?", attachmentRef).toArray()[0]) };
  }

  private readAttachment(ref: string) {
    this.ensureSchema();
    const meta = this.ctx.storage.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE attachment_ref=?", ref).toArray()[0];
    if (!meta) return new Response("Not Found", { status: 404 });
    const chunks = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM attachment_chunks WHERE attachment_ref=? ORDER BY chunk_index", ref).toArray();
    const out = new Uint8Array(Number(meta.size_bytes));
    let offset = 0;
    for (const row of chunks) {
      const chunk = new Uint8Array(row.data);
      out.set(chunk, offset); offset += chunk.byteLength;
    }
    return new Response(out, { headers: {
      "content-type": meta.mime_type,
      "content-length": String(meta.size_bytes),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.file_name)}`,
      "x-task-id": meta.task_id,
      "x-attachment-ref": meta.attachment_ref,
    } });
  }

  private deleteAttachment(ref: string) {
    const meta = this.ctx.storage.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE attachment_ref=?", ref).toArray()[0];
    if (!meta) throw new Error(`附件 ${ref} 不存在`);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM attachment_chunks WHERE attachment_ref=?", ref);
      this.ctx.storage.sql.exec("DELETE FROM attachments WHERE attachment_ref=?", ref);
    });
    return { success: true, deleted: ref };
  }

  private status() {
    this.ensureSchema();
    const taskCounts = this.ctx.storage.sql.exec<{ total: number; active: number; paused: number }>("SELECT COUNT(*) total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) paused FROM tasks").toArray()[0];
    const runCounts = this.ctx.storage.sql.exec<{ total: number; claimed: number }>("SELECT COUNT(*) total,SUM(CASE WHEN status='claimed' THEN 1 ELSE 0 END) claimed FROM task_runs").toArray()[0];
    const attachment = this.ctx.storage.sql.exec<{ total: number; bytes: number }>("SELECT COUNT(*) total,COALESCE(SUM(size_bytes),0) bytes FROM attachments").toArray()[0];
    return { ok: true, tasks: { total: Number(taskCounts?.total || 0), active: Number(taskCounts?.active || 0), paused: Number(taskCounts?.paused || 0) }, runs: { total: Number(runCounts?.total || 0), claimed: Number(runCounts?.claimed || 0) }, attachments: { total: Number(attachment?.total || 0), bytes: Number(attachment?.bytes || 0), maxSingleBytes: MAX_ATTACHMENT_BYTES } };
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/status") return json(this.status());
      if (request.method === "GET" && url.pathname === "/tasks") return json(this.listTasks(url));
      if (request.method === "GET" && url.pathname.startsWith("/tasks/")) return json({ task: this.task(decodeURIComponent(url.pathname.slice(7))) });
      if (request.method === "GET" && url.pathname === "/runs") return json(this.listRuns(url));
      if (request.method === "GET" && url.pathname.startsWith("/runs/")) return json(this.getRun(decodeURIComponent(url.pathname.slice(6))));
      if (request.method === "GET" && url.pathname === "/attachments") return json(this.listAttachments(url.searchParams.get("taskId") || ""));
      if (request.method === "GET" && url.pathname.startsWith("/attachments/")) return this.readAttachment(decodeURIComponent(url.pathname.slice(13)));
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      if (url.pathname === "/tasks/create") return json(this.createTask(body));
      if (url.pathname === "/tasks/update") return json(this.updateTask(body));
      if (url.pathname === "/tasks/delete") return json(this.deleteTask(String(body.id || "")));
      if (url.pathname === "/tasks/pause") return json(this.setStatus(String(body.id || ""), "paused"));
      if (url.pathname === "/tasks/resume") return json(this.setStatus(String(body.id || ""), "active"));
      if (url.pathname === "/tasks/trigger") return json(this.triggerNow(String(body.id || "")));
      if (url.pathname === "/claim") return json(this.claimDue(body));
      if (url.pathname === "/runs/finish") return json(this.finishRun(body));
      if (url.pathname === "/runs/notifications") return json(this.recordNotifications(body));
      if (url.pathname === "/attachments/add") return json(this.addAttachment(body));
      if (url.pathname === "/attachments/delete") return json(this.deleteAttachment(String(body.attachmentRef || "")));
      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "task_store_error", message: errText(error) }, 400);
    }
  }
}