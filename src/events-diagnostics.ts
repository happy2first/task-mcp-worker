// Explicitly select safe fields; never log RPC params, callback paths or secrets.
const reasons = new Set([
  "unsupported_event_or_delivery", "invalid_arguments", "invalid_task_id",
  "invalid_callback_url", "invalid_signing_secret", "callback_host_not_allowed",
  "invalid_ttl", "missing_events_encryption_key", "payload_too_large",
  "events_access_denied", "unsupported_method", "replay_not_supported",
  "unknown_task", "subscription_limit", "challenge_failed", "timeout",
  "subscription_changed_retry", "internal_error",
]);

export function eventDiagnostic(method: string, params: unknown, ok: boolean, data: unknown, enabled: boolean, authorized: boolean) {
  const result = data as { reason?: unknown; code?: unknown } | null;
  let callbackHost: string | undefined;
  try {
    const url = (params as { delivery?: { url?: unknown } } | null)?.delivery?.url;
    if (typeof url === "string") callbackHost = new URL(url).hostname || undefined;
  } catch { /* Invalid URLs must not be copied into logs. */ }
  return {
    message: "mcp_events_rpc",
    method: ["events/list", "events/subscribe", "events/unsubscribe"].includes(method) ? method : "unknown",
    ok, enabled, authorized,
    ...(callbackHost ? { callbackHost } : {}),
    ...(!ok ? {
      reason: typeof result?.reason === "string" && reasons.has(result.reason) ? result.reason : "internal_error",
      code: typeof result?.code === "number" && Number.isSafeInteger(result.code) ? result.code : -32603,
    } : {}),
  };
}
