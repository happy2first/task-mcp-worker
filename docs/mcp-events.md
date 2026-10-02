# MCP Events 配置与部署

依据 [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)，使用 MCP 2.0（2026-07-28）。当前仓库实际是 SQLite Durable Object，没有 D1 binding。本次保留该存储，仅新增 `event_subscriptions`、`event_deliveries` 两张表，自动建表，无需 D1 migration。不要改名、重建或解绑现有 TASK_STORE。

## 配置

| 配置 | 类型 | 含义 |
| --- | --- | --- |
| EVENTS_ENABLED | 普通变量 | 字符串 `true` 才开启，缺省关闭。 |
| EVENTS_ALLOWED_PRINCIPALS | 普通变量 | 允许使用 Events 的 Cloudflare Access JWT `sub`，逗号分隔；不是邮箱，缺省拒绝。 |
| EVENTS_CALLBACK_HOSTS | 普通变量 | ChatGPT 实际 callback 的精确主机名，逗号分隔；缺省拒绝。 |
| EVENTS_ENCRYPTION_KEY | Worker secret | 32 字节随机密钥，64 位十六进制；AES-256-GCM 加密订阅签名密钥。 |
| TEAM_DOMAIN / POLICY_AUD | 原有配置 | 沿用。 |

仓库新增每分钟 `* * * * *` Cloudflare Cron，检查到期任务与重试。它不替代 ChatGPT 每小时轮询。通常精度为一分钟，平台调度和配置传播可能延迟。每轮最多投递 5 条，每条超时 10 秒，大量事件分多轮处理。

## 部署顺序

1. 切换到本次分支，使用 Node.js 24，运行 `npm ci`、`npm run check`。先以 `EVENTS_ENABLED=false` 部署代码，保留 Access 和 TASK_STORE 绑定。
2. `openssl rand -hex 32` 生成主密钥；通过 `npx wrangler secret put EVENTS_ENCRYPTION_KEY` 输入，或在 Cloudflare Worker 设置页新增 Secret。不要提交到 Git。
3. 在通过 Access 的 `/health` 读取 `events.principal`，加入 EVENTS_ALLOWED_PRINCIPALS。必须使用 **ChatGPT 实际连接的认证主体**；浏览器与服务令牌可能不是同一个主体。
4. 设置 EVENTS_ENABLED=true，发布/保存；确认分钟 Cron 已启用。原部署流程可继续使用，或运行 `npm run deploy`。检查命令不发布远程 Worker。
5. 在 ChatGPT 插件页重新扫描 MCP，确认 `task.due`。从支持 Events 的 Work + Cloud 聊天发起订阅。callback URL 和 signing secret 由 ChatGPT 提供，不要自己编造。
6. 初次若返回 `callback_host_not_allowed`，读取错误 `data.callbackHost`，核实主机归属后加入 EVENTS_CALLBACK_HOSTS，再次订阅。错误只暴露主机名，不记录完整 URL 或密钥。
7. 对低风险测试任务调用 task_trigger_now，确认 webhook 得到 2xx、ChatGPT 随后 claim → 执行 → finish → notificationPlan → 通知。停止监控确认 unsubscribe 生效。保留每小时 poller。

### 订阅诊断

若 ChatGPT 只显示通用订阅错误，在 Cloudflare Observability 中查找 `mcp_events_rpc`。每次 Events RPC 会输出一条结构化日志；失败为 warn，成功为 info。日志包含 `method`、`ok`、`enabled`、`authorized`，以及可解析的 `callbackHost`；失败另含安全枚举 `reason` 和数值 `code`。不记录请求正文、完整 callback URL、路径、查询参数、JWT、签名密钥或异常原文。

`callback_host_not_allowed` 时，核实日志中的 `callbackHost` 归属，将其精确加入 `EVENTS_CALLBACK_HOSTS`，保存部署后重试。`events_access_denied` 检查身份白名单，`missing_events_encryption_key` 检查 Secret 格式，`challenge_failed` 或 `timeout` 检查回调验证。Cron 的 `outcome: ok` 不能证明订阅或推送成功。此诊断不增加数据库表或配置项，也不改变订阅授权与 callback 白名单。

官方当前支持 Work 网页、桌面 Cloud 和 dots。测试使用模拟 ChatGPT callback，真实连接的 challenge、订阅及唤醒仍需发布后验证。

## Callback 安全边界

仅允许精确配置的 `chatgpt.com` / `openai.com` 或其子域主机。拒绝通配符、任意第三方域名、IP、HTTP、非 443 端口、带凭据/fragment 的 URL。验证和事件投递均 `redirect: manual`；3xx 不跟随。

Workers 原生 fetch 不能绑定经过校验的 DNS 地址与 TLS 连接。本实现使用 **平台所有权 + 精确主机白名单** 限制出站目标，不宣称提供任意域名的 DNS 绑定验证。若 ChatGPT 实际 callback 使用其他域，需先核实官方归属和安全出站方案，再扩展；不能开放任意 URL。

## 订阅指令

> 订阅定时任务助手的 task.due 事件，监控全部任务。收到事件后调用 task_claim_due，claimedBy=chatgpt-hourly-poller，limit=10。按 executionPrompt（没有时按 task.instruction）执行全部领取任务，需要附件时调用 task_attachment_get。按静默条件判断 notify，调用 task_run_finish。仅当返回 notificationPlan.shouldNotify=true 时按其中渠道发送微信/其他通知并回写通知结果。未领取到任务则静默，保留现有每小时轮询。

支持 `arguments:{}` 监控全部任务，或 `arguments:{"taskId":"..."}` 监控单一任务。事件 data 仅含 taskId、scheduledFor，权威指令与附件通过领取工具读取，不直接执行事件内容。事件只唤醒，不领取、执行或发送业务通知。

## 运行语义

- events/list 返回名称、webhook delivery、过滤 inputSchema、payloadSchema。三个 Events 方法沿用同一 Access 认证 /mcp。内部 /events/rpc 和 /events/tick 仅在 DO 上，外部不暴露。
- 订阅 ID 由认证主体、标准化 callback、事件名及规范化 arguments 决定；续订更新同一行，unsubscribe 幂等且按主体隔离。
- secret 必须 whsec_ 开头且 base64 解码 24–64 字节。接受前发送随机短期 challenge，必须 2xx + 常量时间比较回显；失败返回 -32015。验证缓存最长 5 分钟，替换 secret 重新验证，旧新密钥双签最长 5 分钟。
- 默认有效期 24 小时，最短 1 分钟、最长 7 天；ttlMs:null 也只授予有限期。ChatGPT 在 refreshBefore 前 subscribe 续订，过期停止投递并清理密钥。
- 不支持历史重放：cursor 省略/null，响应和事件 cursor=null。仍到期的遗漏任务由保留轮询领取。
- 使用 Standard Webhooks HMAC-SHA256，签署 `webhook-id.webhook-timestamp.rawBody`，原始正文只序列化一次。**接收方 ChatGPT 验证签名**；本 Worker 不接收入站事件 callback，另外验证 challenge 回显。
- 同一订阅、taskId、scheduledFor 的唯一记录防重复生成。重试保持事件 ID 和正文，生成新的签名时间戳。2xx 后停止投递该实例。
- 网络错误、408、429、5xx 指数退避，1 分钟起、最多 1 小时、最多 8 次。410 终止订阅；413、其他 4xx、3xx 不重试。
- 网络前持久写入尝试次数与 2 分钟恢复租约；重启可继续。投递前重查任务与主体权限，暂停、删除、改期或领取后取消过时事件。
- 至少一次投递：响应丢失或接收成功后服务端崩溃可能重发同一 ID。多个订阅和小时 poller 的竞态由原有原子 task_claim_due 协调。不要绕过 claim 直接执行 payload。已发出的网络请求无法撤回。
- 撤权需从 EVENTS_ALLOWED_PRINCIPALS 删除主体并发布；仅在 Access 控制台禁用登录不能自动让已有订阅获得即时撤权信息。每次投递检查白名单；EVENTS_ENABLED=false 全局停止。
- 主密钥 EVENTS_ENCRYPTION_KEY 不等于 ChatGPT 签名 secret。不要直接替换存储主密钥，否则已有订阅不可解密；更换前取消全部订阅，之后重新订阅。
- 原有队列的任务、租约、已领取但未 finish 的恢复规则不调整。任务执行和业务通知继续由外部执行器完成。

## 验证与回退

测试覆盖真实 Store + SQLite 的持久化、签名、challenge、白名单、续订、过期、轮换、重试、410/413、并发取消、防重复、事件/轮询竞态、notificationPlan。另有 Miniflare 实际 Worker/DO、Access JWT 与 MCP 2.0 工具/事件集成测试。

固定 Wrangler 内置 workerd 当前最高支持 2026-08-06，因此本地运行时测试单独使用该日期；生产 wrangler.jsonc 的 2026-09-03 未改变。测试不访问真实 ChatGPT/Cloudflare。

回退时将 EVENTS_ENABLED=false 并发布，或暂停分钟 Cron。小时轮询与原有工具继续使用，无需回滚任务表或删除新增表。
