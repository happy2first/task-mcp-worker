export type TaskStatus = "active" | "paused" | "completed" | "deleted";
export type RunStatus = "claimed" | "succeeded" | "failed";
export type NotificationChannel = "chatgpt" | "weixin" | "email" | "ntfy";
export type NotifyOn = "always" | "success" | "failure";

export type OnceSchedule = {
  kind: "once";
  at: string;
  timezone?: string;
};

export type IntervalSchedule = {
  kind: "interval";
  everyMinutes: number;
  startAt?: string;
  timezone?: string;
};

export type CronSchedule = {
  kind: "cron";
  expression: string;
  timezone?: string;
};

export type TaskSchedule = OnceSchedule | IntervalSchedule | CronSchedule;

export type NotificationConfig = {
  channels: NotificationChannel[];
  notifyOn: NotifyOn;
  weixinRecipients?: string[];
  emailTo?: string[];
  ntfyTopic?: string;
};

export type TaskRecord = {
  id: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  schedule: TaskSchedule;
  nextDueAt: string | null;
  notification: NotificationConfig;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  attachmentCount?: number;
};

export type RunRecord = {
  runId: string;
  taskId: string;
  scheduledFor: string;
  status: RunStatus;
  attempt: number;
  claimedBy?: string | null;
  claimedAt?: string | null;
  leaseUntil?: string | null;
  finishedAt?: string | null;
  resultText?: string | null;
  errorText?: string | null;
  notificationResults?: unknown[];
  createdAt: string;
  updatedAt: string;
};

export type AttachmentRecord = {
  attachmentRef: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  createdAt: string;
};

export interface Env {
  TASK_STORE: DurableObjectNamespace;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
}
