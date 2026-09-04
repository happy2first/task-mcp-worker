import { Cron } from "croner";
import type { TaskSchedule } from "./types.js";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 525_600;

export function assertValidTimezone(value: string | undefined): string {
  const timezone = String(value || DEFAULT_TIMEZONE).trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`无效时区：${timezone}`);
  }
  return timezone;
}

function validIso(value: unknown, label: string): string {
  const text = String(value || "").trim();
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) throw new Error(`${label} 必须是有效 ISO 8601 时间`);
  return date.toISOString();
}

export function normalizeSchedule(input: unknown): TaskSchedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("schedule 必须是对象");
  const raw = input as Record<string, unknown>;
  const kind = String(raw.kind || "").trim();
  const timezone = assertValidTimezone(String(raw.timezone || DEFAULT_TIMEZONE));

  if (kind === "once") {
    return { kind, at: validIso(raw.at, "schedule.at"), timezone };
  }

  if (kind === "interval") {
    const everyMinutes = Number(raw.everyMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error(`schedule.everyMinutes 必须是 ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} 的整数`);
    }
    return {
      kind,
      everyMinutes,
      ...(raw.startAt ? { startAt: validIso(raw.startAt, "schedule.startAt") } : {}),
      timezone,
    };
  }

  if (kind === "cron") {
    const expression = String(raw.expression || "").trim();
    if (!expression || expression.length > 120) throw new Error("schedule.expression 不能为空且最多 120 字符");
    try {
      const cron = new Cron(expression, { timezone, paused: true });
      cron.nextRun(new Date());
      cron.stop();
    } catch (error) {
      throw new Error(`无效 cron：${error instanceof Error ? error.message : String(error)}`);
    }
    return { kind, expression, timezone };
  }

  throw new Error("schedule.kind 仅支持 once / interval / cron");
}

export function initialNextDue(schedule: TaskSchedule, now = new Date()): string | null {
  if (schedule.kind === "once") return new Date(schedule.at).toISOString();

  if (schedule.kind === "interval") {
    const intervalMs = schedule.everyMinutes * 60_000;
    const anchor = schedule.startAt ? new Date(schedule.startAt).getTime() : now.getTime() + intervalMs;
    if (anchor > now.getTime()) return new Date(anchor).toISOString();
    const steps = Math.floor((now.getTime() - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }

  const cron = new Cron(schedule.expression, { timezone: schedule.timezone || DEFAULT_TIMEZONE, paused: true });
  const next = cron.nextRun(now);
  cron.stop();
  if (!next) throw new Error("cron 无法计算下一次执行时间");
  return next.toISOString();
}

export function nextDueAfterClaim(schedule: TaskSchedule, now = new Date()): string | null {
  if (schedule.kind === "once") return null;
  return initialNextDue(schedule, now);
}
