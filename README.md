# task-mcp-worker

A Cloudflare Workers + Durable Objects task queue designed for MCP clients and external AI executors.

It stores scheduled tasks, leases due work to a poller, records execution results, manages task attachments, and exposes an admin UI. The Worker **does not execute arbitrary tasks by itself**: an external executor (for example, an MCP-capable agent) claims due tasks and performs the actual work.

## Features

- One-time, interval, and cron schedules
- Atomic due-task claiming with leases and retry attempts
- Explicit execution lifecycle: claim → execute → finish
- Per-run success/failure records
- Optional silent runs through `notify=false`
- Notification plans for `chatgpt`, `weixin`, `email`, and `ntfy`
- Task pause/resume and manual trigger
- SQLite-backed Durable Object persistence
- Task attachments stored in SQLite BLOB chunks
- Built-in admin console
- Cloudflare Access JWT verification for protected endpoints

## Architecture

```text
MCP client / admin browser
          |
          v
   Cloudflare Access
          |
          v
 task-mcp-worker
   /mcp   /admin
          |
          v
   TaskStoreDO (SQLite)
    |       |       |
  tasks    runs  attachments

External poller / agent
  1. task_claim_due
  2. execute task.instruction
  3. task_run_finish
  4. deliver requested notifications
  5. task_run_record_notifications
```

## MCP tools

### Task management

- `task_status` — task/run/attachment overview
- `task_create` — create a scheduled task
- `task_update` — update task metadata, schedule, or notifications
- `task_delete` — delete a task and its related runs/attachments
- `task_list` / `task_get` — inspect tasks
- `task_pause` / `task_resume` — control scheduling
- `task_trigger_now` — make a task immediately claimable

### Execution lifecycle

- `task_claim_due` — atomically claim due tasks and receive `runId`
- `task_run_finish` — write back success/failure and whether this run should notify
- `task_run_record_notifications` — record downstream notification delivery results
- `task_run_list` / `task_run_get` — inspect execution history

### Attachments

- `task_attachment_add`
- `task_attachment_list`
- `task_attachment_get`
- `task_attachment_delete`

Attachments are stored in the SQLite-backed Durable Object in 1 MiB chunks. The current per-file limit is 10 MiB.

## Execution contract

A typical poller should:

1. Call `task_claim_due`.
2. For every claimed task, execute the full `task.instruction` returned by the Worker.
3. Call `task_run_finish` with the corresponding `runId`.
4. Inspect the returned notification plan.
5. Deliver notifications only when `notificationPlan.shouldNotify` is true.
6. Optionally record delivery outcomes with `task_run_record_notifications`.

`notify=false` is intended for monitoring tasks that should remain silent when no meaningful change or alert condition is found.

## Cloudflare resources

The project requires:

- one Cloudflare Worker;
- one SQLite-backed Durable Object binding named `TASK_STORE`.

The Durable Object class is `TaskStoreDO`; its binding is already declared in `wrangler.jsonc`.

## Authentication

Protected routes verify Cloudflare Access JWTs. Configure these Worker environment values in Cloudflare, not in source control:

```text
TEAM_DOMAIN=https://<your-team>.cloudflareaccess.com
POLICY_AUD=<your-access-application-audience>
```

Do not commit real Access audience values, credentials, `.dev.vars`, or `.env` files.

## Endpoints

- `/mcp` — MCP endpoint
- `/admin` — admin console
- `/health` — protected health endpoint

All application endpoints are intended to sit behind Cloudflare Access.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check
```

Run locally:

```bash
npm run dev
```

Deploy:

```bash
npm run deploy
```

## Security notes

- Keep Cloudflare configuration and credentials outside the repository.
- The repository intentionally ignores `.dev.vars`, `.env`, `.env.*`, `.wrangler/`, build output, and dependencies.
- Task instructions, run results, and attachments may contain sensitive data. Treat the Durable Object as application data and protect all externally reachable routes.
- Notification delivery is intentionally delegated to the external executor; this Worker stores only the notification plan and delivery results.

## License

MIT
