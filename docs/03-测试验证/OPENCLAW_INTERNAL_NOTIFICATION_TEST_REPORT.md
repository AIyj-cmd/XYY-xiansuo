# OpenClaw 内部通知独立测试报告

日期：2026-08-01
验证角色：`test_verifier`（独立验证，未修改业务源码、配置、迁移或依赖）
结论：**不允许进入验收阶段（NO-GO）**。发现 1 项 P1 和 1 项 P2，均与明确的发送安全边界不符。

## 测试环境与开始前基线

- 分支：`feature/openclaw-internal-notifications`
- HEAD：`ab87d3ba450d256e4fa51414a8a8ce5788fc216f`
- 开始前 `git diff --check` 通过。
- 开始前工作区已包含本功能的服务端、Gateway、部署、文档及测试改动；验证过程没有恢复、覆盖或清理这些改动。
- 测试仅使用内存 SQLite、`/tmp` 临时目录、Fake Adapter 和 `127.0.0.1` 临时 HTTP Server；未访问真实微信、OpenClaw daemon、DeepSeek 或生产数据库。
- `server/data` SHA-256 前后一致：`app.db` 为 `8b8bc326…a061d5f2`，`app.db-shm` 为 `fd4c9fda…b8549389eb`，其余记录亦无变化。

## 测试计划与范围

1. 验证迁移 007 的空库/006 升级、重复执行、既有列/索引/外键/数据保留、渠道约束和完整性。
2. 验证默认关闭、严格配置、Secret 路径和权限，以及 API/Worker 读取边界。
3. 验证规则仅允许三个事件和单一渠道、Worker 按渠道领取、五种 Gateway 结果映射、两次自动尝试、旧 lease 和非 pilot 拒绝。
4. 验证服务端→Gateway HMAC 请求契约、固定接收人、固定隐私模板及 Gateway 无业务数据库/DeepSeek 边界。
5. 运行后端、Gateway、H5 回归构建和静态差异检查。

未覆盖：用户要求的单条真实 Pilot。该步骤必须在自动化和验收均通过后才可执行；本轮因 P1 未清零而未授权执行。

## 已执行命令及结果

| 命令 / 检查 | 结果 |
| --- | --- |
| `git status --short`、`git diff --name-only`、`git diff --check` | 已建立基线；差异检查通过 |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 125/125 通过（原 121 项回归继续通过） |
| `cd poc/ilink-gateway && npm run build && npm test` | 构建通过；30/30 通过 |
| `cd app && npm run build:h5` | 通过；未构建小程序 |
| 内存 SQLite 独立迁移 006→007 检查 | 通过：47 列、10 个索引、5 个外键、历史行逐字段一致；`integrity_check=ok`，`foreign_key_check=[]`；`mock`/`openclaw`/`NULL` 接受，非法值拒绝；规则仍全关闭；重复执行仅跳过 007 |
| 本地临时 HTTP Gateway 五种响应检查 | 通过：`sent`、`deduplicated`、`retryable_failure`、`permanent_failure`、`result_unknown` 均被 Channel 原样解析；请求 HMAC 正确；仅含 `deliveryId,idempotencyKey,recipientUserId,title,body,detailUrl` |
| Worker 状态机内存 SQLite 检查 | 发现 P1，见下；其余：`sent` 成功、首次 retryable 为 `retry_wait`、第二次为 `failed` 且自动尝试数 2、`result_unknown` 为不可重试 failed、Mock worker 不领取 OpenClaw 行 |
| Secret 权限独立检查 | 发现 P2，见下 |
| 源码/配置边界审阅 | Gateway 未导入业务 DB 或 DeepSeek；API/AI Scheduler 不以 `requireOpenClawSecret` 读取 Gateway Secret；Gateway 无入站业务路由；消息模板和 URL 不含客户数据、JWT、Cookie、Key 或会话凭证 |

## 通过项

- 迁移 001–006 的版本和固定 checksum 未改变；007 采用事务内重建，升级数据、索引、外键和所有规则禁用状态保留。
- 规则解析/API 仅允许 `mock` 或 `openclaw` 的单元素数组；`owner_changed`、`scheduled_follow_overdue`、`daily_report` 为实现范围，其他事件被 `EVENT_NOT_IMPLEMENTED` 阻止启用，未实现 fallback。
- OpenClaw 关闭时 Worker 可用渠道列表不含 `openclaw`，已存在的 OpenClaw 任务不会被 Mock 领取。
- Channel 对非 pilot `recipientUserId` 在发起 HTTP 前返回 `OPENCLAW_RECIPIENT_NOT_ALLOWED`；Gateway 再次执行相同限制，并固定使用 `ILINK_POC_RECIPIENT_EXTERNAL_ID`。
- 临时 Gateway 请求验明 HMAC，路径为 `/deliveries`；正文为固定内部提醒和 `https://xs.tomatopia.top/`，不含业务快照或敏感字段。
- `result_unknown` 映射为 `failed`、`retry_allowed=0`、`last_error_code=OPENCLAW_SEND_RESULT_UNKNOWN`，不自动重发。
- 未发生真实发送、DeepSeek 调用、客户业务写操作或 `server/data` 变更。

## 失败项

### P1：普通 permanent_failure 仍允许人工重试

位置：[server/src/services/notification.ts](/home/yj/xiansuo/server/src/services/notification.ts:195)。

最小复现：在临时库插入一个 `channel='openclaw'` 的 pending 行，领取后调用：

```ts
finishNotificationTask(db, task, {
  kind: 'permanent',
  code: 'OPENCLAW_RECIPIENT_NOT_ALLOWED',
}, now)
```

实际结果：`{"status":"failed","retry_allowed":1,"last_error_code":"OPENCLAW_RECIPIENT_NOT_ALLOWED"}`。

预期结果：所有 `permanent_failure`（登录失效、接收人配置错误、账号受限、策略错误等）均应为 `failed` 且 `retry_allowed=0`。当前实现仅对 `invalid_message_schema`、`unrecoverable_task_data` 和 `OPENCLAW_SEND_RESULT_UNKNOWN` 设置 0，因此管理员接口可以对其他永久失败执行人工重试，违背“不可重试永久失败”边界。

建议修复：`finishNotificationTask` 应在 `outcome.kind === 'permanent'` 时无条件写入 `retry_allowed=0`，并添加覆盖所有永久错误码的回归测试。

### P2：Secret 文件权限并非精确 0600 也会被接受

位置：[server/src/config.ts](/home/yj/xiansuo/server/src/config.ts:81)，Gateway 同类逻辑位于 `poc/ilink-gateway/src/config.ts`。

最小复现：创建仓库外 48 字节普通 Secret 文件，设置为 `0400`，使用启用 OpenClaw 的 Worker 配置调用 `resolveNotificationConfig(..., { requireOpenClawSecret: true })`。

实际结果：`0400` 被接受；独立输出为 `{"mode":"400","accepted":true}`。

预期结果：需求的配置测试明确要求“文件权限不是 600”时拒绝，且要求 Secret 从权限 `0600` 的文件读取。

建议修复：拒绝符号链接后，使用精确模式比较（例如 `(stat.mode & 0o777) === 0o600`），并在服务端和 Gateway 增加 `0400`、`0644`、符号链接、文件缺失的测试矩阵。

## 实现修复补充（待独立复验）

本节由 implementer 在保留上述独立发现原文的前提下补充，不能替代独立复验：

- OpenClaw Worker 结果映射新增显式 `retryAllowed=0`，覆盖所有 `permanent_failure`、`result_unknown` 及缺少成功/去重回执的失败；既有 Mock outcome 未指定该字段，保留原人工重试语义。
- 服务端与 Gateway Secret 校验改为精确 `(mode & 0o777) === 0o600`；新增 `0400`、`0200`、`0000`、`0644` 和符号链接回归。
- Gateway 的官方状态目录规范为 `OPENCLAW_STATE_DIR`；`ILINK_POC_SESSION_DIR` 仅兼容别名，和规范项并存时拒绝。
- `deduplicated` 只有携带已持久化原本地回执时才会标记 `sent`；缺少回执会安全终止，不再构造回执。

implementer 复跑结果：`server` build 与 `126/126` 测试通过；Gateway build 与 `32/32` 测试通过；未触发真实外呼。

## 后续复验阻断的实现修复补充（待独立复验）

本节同样由 implementer 追加，保留此前独立结论：

- Gateway 新增持久 `delivery_locks` 原子租约。`retryable_failure` 可在 Gateway 重启后以相同幂等键真实重试；同键并发只有一个 Adapter 调用，`sent`、`permanent_failure`、`result_unknown` 均不得再次调用。新增测试确认 retryable→成功总调用两次、最终保存原回执，以及终态只调用一次。
- Worker 不再以硬编码 10 秒中止 OpenClaw；OpenClaw 唯一使用 `OPENCLAW_GATEWAY_TIMEOUT_MS`，Mock 仍保持原 10 秒 Worker 保护。新增 `1000ms`、`20000ms` 配置回归。
- implementer 复跑：`server` build 与 `127/127` 测试通过；Gateway build 与 `34/34` 测试通过；H5 构建通过；无真实外呼/Pilot。

## 测试阶段文件变化

- 我仅更新了本报告：[OPENCLAW_INTERNAL_NOTIFICATION_TEST_REPORT.md](/home/yj/xiansuo/docs/03-测试验证/OPENCLAW_INTERNAL_NOTIFICATION_TEST_REPORT.md)。
- 构建产物和临时 SQLite 均位于已忽略目录或 `/tmp`；未新增跟踪的测试/业务实现文件。
- 测试结束后 `git diff --check` 仍通过；其余工作区差异均为测试开始前已存在的实现阶段改动。

## 放行意见

不放行进入验收，也不允许真实 Pilot。先修复 P1 与 P2，补充永久失败/精确 0600 回归测试，并重新完成受影响的后端和 Gateway 验证；修复后才可由 `acceptance_optimizer` 进行最终验收。

---

## 修复后独立复验（2026-08-01）

本节保留以上首次发现，记录后续 implementer 修复后的独立复验，而不是覆盖原始结论。

### 已复验通过

- 首次发现的永久失败问题已修复：OpenClaw 的 `permanent_failure`、`result_unknown`、`sent`/`deduplicated` 缺回执均映射为 `failed` 且 `retry_allowed=0`；Mock 异常路径仍使用原来的人工重试语义。
- 首次发现的 Secret 文件问题已修复：Server 与 Gateway 均只接受普通、非符号链接且**精确** `0600` 的仓库外 Secret；`0400`、`0200`、`0000`、`0644` 及符号链接均拒绝。
- `OPENCLAW_STATE_DIR` 已成为 Gateway 的规范配置；`ILINK_POC_SESSION_DIR` 仅保留为废弃别名，和规范项同时出现时拒绝。Gateway `.env.example`、独立 PM2 配置与运行手册均使用规范名。
- `sent`、`deduplicated` 仅接受 Gateway 返回的原始 `providerMessageId`；Gateway 持久幂等记录缺失原始回执时返回永久失败，Worker 不再伪造 `openclaw_<idempotencyKey>` 回执。
- 修复后回归：`server npm run build && npm test` 为 **126/126**；Gateway build/test 为 **32/32**；H5 build 成功；`git diff --check` 通过；`server/data` 哈希与复验前相同。

### 新增失败项

#### P1：retryable_failure 被 Gateway 幂等层缓存，第二次自动尝试不实际发送

位置：[idempotency-store.ts](/home/yj/xiansuo/poc/ilink-gateway/src/idempotency-store.ts:14)。

独立计数复现使用临时 StateStore 和计数 Fake Adapter，固定同一 `idempotencyKey`：首次 Adapter 返回 `retryable_failure/ILINK_GATEWAY_OFFLINE`，随后再次调用 `GatewayService.deliver`。

实际结果：首次和第二次均返回 `retryable_failure`，但 Adapter `calls=1`。`IdempotencyStore.existing()` 对持久化的 retryable 记录直接返回旧结果，导致 Gateway 不调用 Adapter。对照组 `result_unknown` 与 `permanent_failure` 也均为 `calls=1`，后两者符合禁止重发要求。

预期结果：明确未发送的 `retryable_failure` 必须让 notification-worker 的第二次自动尝试以**相同**幂等键重新调用 Gateway/Adapter；最多两次包括首次。`result_unknown` 和永久失败仍不得重发。

建议修复：`existing()` 仅对成功（带原始回执）、永久失败和不确定结果阻断重投；对可重试失败返回可重新发送的结果（同时保持 key、接收人和消息哈希冲突校验），并新增“同 key 两次尝试 Adapter 调用次数为 2”的 Gateway 集成回归测试。

#### P2：Worker 的外层 10 秒硬超时覆盖 OPENCLAW_GATEWAY_TIMEOUT_MS

位置：[notification-worker.ts](/home/yj/xiansuo/server/src/notification-worker.ts:34)。

实际实现：Worker `processTask` 无条件 `setTimeout(..., 10_000)`；而 OpenClaw Channel 使用合法范围 `1,000–120,000ms` 的 `OPENCLAW_GATEWAY_TIMEOUT_MS`。当配置为大于 10 秒时，Worker 先取消 signal，Channel 被迫按 10 秒而非配置值失败。

预期结果：Worker 与 Channel 必须使用同一有效超时边界，不能忽略合法配置。建议将已解析的 `openclawGatewayTimeoutMs` 传给 `processTask`，或移除对 OpenClaw 的重复外层超时并由 Channel 统一负责。

### 修复后复验结论

| 分级 | 数量 | 结论 |
| --- | ---: | --- |
| P1 | 1 | retryable 任务不会实际进行第二次 Gateway/Adapter 投递 |
| P2 | 1 | 合法超时配置大于 10 秒时不生效 |
| P3 | 0 | 无 |

**不允许进入 acceptance，不允许真实 Pilot。** 必须先修复上述两项，新增独立 Adapter 调用计数与超时配置回归测试，并重跑 Server、Gateway、H5 和差异/数据哈希检查。

---

## 第三轮独立复验（2026-08-01）

本节保留前两轮发现和 NO-GO 历史，记录针对持久重试锁和 Worker 超时修复的最终复验。

### 已复验通过

- Gateway 以持久 `delivery_locks` 在 `BEGIN IMMEDIATE` 事务中获取发送 lease。独立临时 StateStore/计数 Adapter 验证：首次 `retryable_failure` 后关闭并重开 Gateway，使用同一幂等键的第二次调用真正触发第二次 Adapter 调用（`calls=2`）并最终 `sent`；第三次才返回带同一原始回执的 `deduplicated`。
- 同一独立检查验证：相同 key 的消息哈希冲突返回 `ILINK_IDEMPOTENCY_CONFLICT` 且不调用 Adapter；`result_unknown`、`permanent_failure` 和 sent/deduplicated 均只调用一次 Adapter；模拟“取得 lease 后进程崩溃”遗留记录重开后返回 `result_unknown`、`calls=0`，失败关闭。
- Gateway 新增回归覆盖跨重启 retryable、并发双请求只发送一次、终态不重发；Gateway 测试 **34/34** 通过。
- Worker 对 `openclaw` 不再设置外层 10 秒 AbortController，Channel 独占 `OPENCLAW_GATEWAY_TIMEOUT_MS`；Mock 保持原有 10 秒 Worker 上限。配置 1 秒和 20 秒的边界测试通过。
- 独立内存 SQLite 验证 OpenClaw retryable 任务 `max_attempts=2`：首次写入 `retry_wait, attempt_count=1, automatic_attempt_count=1`，第二次写入 `failed, attempt_count=2, automatic_attempt_count=2`，之后不能再次领取。
- 回归命令：`server npm run build && npm test` 为 **127/127**；Gateway build/test 为 **34/34**；H5 build 成功；`git diff --check` 通过；`server/data` 哈希未变化。

### 残留失败项

#### P2：管理员 preview 允许启用规则使用空 channel_order，并错误预览为 pending

位置：[notification-admin.ts](/home/yj/xiansuo/server/src/routes/notification-admin.ts:51) 与 [notification.ts](/home/yj/xiansuo/server/src/services/notification.ts:47)。

最小复现：在临时 Fastify/SQLite 中，以管理员身份请求：

```text
POST /api/admin/notification-rules/owner_changed/preview
rule.enabled=true
rule.recipient_strategy="new_owner"
rule.channel_order=[]
```

实际结果：HTTP 200，`data.decision="pending"`、`suppression_reason=null`。`PUT /notification-rules/:eventType` 会正确拒绝相同空数组，但 preview 仅调用允许空数组的兼容 `parseOwnerRule`，随后把 `undefined` 渠道当作可用。

预期结果：预览与写入必须同样要求一个 `mock` 或 `openclaw` 渠道；空数组应返回 `CHANNEL_NOT_ALLOWED`，或至少预览为 `suppressed/no_usable_channel`。该问题不产生实际 outbox 行，但会向管理员错误展示可投递状态，违反单渠道边界。

建议修复：preview 路由复用 PUT 的单渠道校验（或调用 `parseSingleNotificationChannel`），并增加管理员 HTTP 回归测试覆盖空数组与双渠道。

### P3 观察项

[idempotency-store.ts](/home/yj/xiansuo/poc/ilink-gateway/src/idempotency-store.ts:8) 的旧 `existing()`、`reserve()` 现无调用点；当前投递仅走已验证的 `acquire()`/`finalize()` 路径。它们不影响运行时结果，建议作为后续小型清理，而非独立验收阻断。

### 第三轮结论

| 分级 | 数量 | 结论 |
| --- | ---: | --- |
| P1 | 0 | 持久重试锁、跨重启与两次自动尝试均已复验通过 |
| P2 | 1 | preview 的空渠道约束与写入路径不一致 |
| P3 | 1 | 未使用的旧幂等方法，非运行时风险 |

**仍不建议进入 acceptance，也不允许真实 Pilot。** 先修复 P2，并在验收时决定是否一并删除 P3 死代码；修复后重新验证受影响 API、后端回归和 `git diff --check`。

---

## 最终独立复验（2026-08-01）

本节记录 P2/P3 修复后的最终结论；前文保留所有历史缺陷及其复验轨迹。

### 已复验通过

- 管理员 `preview` 与 `PUT` 已共享严格的事件、接收人策略和单渠道校验。独立 HTTP 回归覆盖 `enabled=true` 与 `false` 下的空数组、双渠道和未知渠道，均返回 `400/CHANNEL_NOT_ALLOWED`；错误 `recipient_strategy` 同样拒绝。
- member 调用 preview 返回 403；`visit_reminder` 等未实现事件在 preview 与 PUT 中均返回 `EVENT_NOT_IMPLEMENTED`，未发生功能范围扩大。
- 已删除未使用的 Gateway `IdempotencyStore.existing()`、`reserve()`；源码检索无残留调用。当前 `acquire()`/`finalize()` 的持久锁路径仍由 Gateway 跨重启 retryable、并发和终态测试覆盖，未见原子幂等回归。
- 最终命令结果：`server npm run build && npm test` **128/128**；Gateway build/test **34/34**；`app npm run build:h5` 成功；`git diff --check` 通过。
- `server/data` 哈希与本轮测试前一致；未执行真实网络外呼、OpenClaw 登录、DeepSeek、真实 Pilot 或客户业务操作。

### 最终分级与放行意见

| 分级 | 数量 |
| --- | ---: |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 |

**允许进入 `acceptance_optimizer` 最终验收。** 此结论仅代表自动化、隔离集成和构建验证已通过；不授权真实 Pilot。真实 Pilot 仍必须由最终验收确认所有前置条件后，按用户限定的单条合成消息受控执行。

---

## 第三轮 P2/P3 实现修复补充（待独立复验）

- preview 与 PUT 现共享单渠道和接收人策略校验；`enabled=true` 与 `enabled=false` 都拒绝空数组、多渠道、未知渠道和错误接收人策略。管理员 HTTP 用例比较两端错误码，确认 preview 不返回 `pending`，成员仍为 `403`，`visit_reminder` 的 PUT/preview 仍返回 `EVENT_NOT_IMPLEMENTED`。
- 删除 Gateway `IdempotencyStore.existing`、`reserve` 和无其他调用的 StateStore `findDelivery`、`createDelivery`、`updateDelivery` 包装，唯一状态路径仍为持久事务 `acquireDelivery`/`finalizeDelivery`。
- 实现侧回归：Server build 通过、`npm test` **128/128** 通过；Gateway build 通过、`npm test` **34/34** 通过；H5 build 与 `git diff --check` 通过。上述结果仍需 test_verifier 独立复核。
- 本补充不表示独立验收完成；未进行真实登录、扫码、微信发送或 Pilot。

## 隔离 synthetic 入队实现补充（待独立复验）

- 自动化覆盖相对/仓库内/非私有/非全新 DB 拒绝、首次迁移 `001–007`、唯一测试用户和唯一任务、严格 snapshot 与隐私、同键不新增、队列连续两次 SAFE、额外任务 UNSAFE、Worker→OpenClaw Channel→伪 Gateway 的一条 Fake 链路及第二次 Worker 不二发。
- 测试拦截 `fetch` 并只返回内存伪 Gateway 回执；没有真实网络、OpenClaw 登录、微信发送、Provider 或业务表读取。
- 实现侧回归：Server build 与 **134/134** 测试、Gateway build 与 **34/34** 测试、H5 build、`git diff --check` 全部通过；`server/data` 前后哈希一致。仍待 test_verifier 独立复验。

---

## 隔离 synthetic 入队扩展独立复验（2026-08-01）

### 测试环境、基线与范围

- 工作区：`/home/yj/xiansuo`；测试开始前已存在 OpenClaw 实现、文档和本次 synthetic 入队相关差异。测试代理未恢复、覆盖或清理它们，仅写入本报告。
- 测试前 `git diff --check` 通过。`server/data` 哈希基线为 `app.db=8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2`，测试过程中未作为目标数据库。
- 范围：synthetic CLI/隔离路径、重复入队封存校验、queue-check、Worker→伪 Gateway、迁移 `001–007` 回归及 H5 构建。未执行 HTTP 业务联调、真实网络、OpenClaw 登录、扫码、真实微信发送、DeepSeek 或真实 Pilot。

### 已执行命令及通过项

- `cd server && npm run build && npm test`：通过，**134/134**。现有 synthetic 覆盖确认首次空库迁移 `001–007`、唯一用户/任务、固定快照、Fake Gateway 单发、同键第二次 Worker 不二发，以及基础 queue-check SAFE/额外任务 UNSAFE。
- `cd poc/ilink-gateway && npm run build && npm test`：通过，**34/34**。仅使用 Fake Adapter/本地状态，未访问真实微信。
- `cd app && npm run build:h5`：通过。未构建微信小程序。
- `git diff --check`：测试前通过；本轮未对业务源码作任何修改。

### 失败项

#### P1：临时目录仅进行词法检查，接受含上级符号链接的路径

位置：[openclaw-synthetic-pilot.ts](/home/yj/xiansuo/server/src/openclaw-synthetic-pilot.ts:45)。

最小复现：创建 `/tmp/xiansuo-synthetic-parent-link-*` 指向另一临时目录，在其下建立 `0700 private/`，再执行 synthetic 入队。独立命令输出：

```json
{"result":"created","requestedPath":"/tmp/xiansuo-synthetic-parent-link-…/private/openclaw-synthetic-pilot.db","realDatabasePath":"/tmp/xiansuo-synthetic-target-…/private/openclaw-synthetic-pilot.db","ancestorSymlinkAccepted":true}
```

实际结果：`privateTemporaryDirectory()` 用 `path.relative()` 判断词法上位于 `/tmp`，且只 `lstat()` 末级 `private`；上级符号链接未被拒绝，也没有先验证 `realpath(directory)` 仍在真实临时根之内。

预期结果：只接受真实路径位于真实临时根下的全新私有目录，并拒绝路径链中任一符号链接或逃逸。

建议修复：逐段 `lstat` 路径组件拒绝链接；再对目录及最终数据库路径的已解析真实路径做边界比较，确保仍在 `realpath(os.tmpdir())` 下；补充“上级链接但末级 0700”与“链接逃逸”测试。

#### P1：既有库的 sealed 重复校验可接受污染和关键任务字段篡改，queue-check 仍给出 SAFE

位置：[openclaw-synthetic-pilot.ts](/home/yj/xiansuo/server/src/openclaw-synthetic-pilot.ts:65)、[pilot-queue-check.ts](/home/yj/xiansuo/server/src/pilot-queue-check.ts:20)。

最小复现：在首次成功入队后，以 SQLite 修改隔离库：插入一条 `tags` 业务记录；将 `daily_report` 规则置为启用；将唯一任务 `max_attempts=10` 并将 `rule_snapshot_json` 替换为非预期值。再以同一 idempotency key 入队并运行 synthetic queue-check。

独立输出：

```json
{"first":"created","repeat":"deduplicated","before":{"tags":1,"enabled":1,"maxAttempts":10},"queueConclusion":"SAFE","blockers":[]}
```

实际结果：`assertSealedRepeatState()` 仅核验迁移记录、`users` 和 `notification_logs` 的部分 envelope。它没有核验目录/数据库权限、业务/跟进/审计/AI 表计数为零、规则仍全关闭，亦未固定校验 `status`、所有尝试/租约/回执字段、`max_attempts`、`rule_snapshot_json`、`available_at`、`expires_at` 等。`isSyntheticPilotTask()` 也不覆盖上述字段，所以 queue-check 仍将被污染库的唯一可领取任务视为 SAFE。

预期结果：重复仅能对完整 sealed 状态去重；任一业务数据、规则开启、任务不可变字段或文件权限变化都必须拒绝。投递前 queue-check 应证明数据库完整、外键正确、无额外/污染数据并输出相应证据。

建议修复：建立并验证完整白名单封存清单（所有表计数、唯一规则默认关闭、唯一任务全部不可变字段、文件与目录权限）；首次入队前后及重复/queue-check 均显式执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`，并将检查结果、隔离表计数和隐私扫描摘要纳入 CLI/queue-check 输出；为每一项篡改增加拒绝回归测试。

### 规则与隐私观察

- Worker 对 `event_source=openclaw_synthetic_pilot` 会要求 `isSyntheticPilotTask()` 完整匹配后才选用固定测试正文；伪造 source、operation、snapshot 或 recipient 会走永久失败 `OPENCLAW_SYNTHETIC_TASK_INVALID`，未发现该正文降级为业务正文的路径。
- 但上述 P1 表明“完整”封存范围实际不足，且入队/queue-check 没有独立的完整性、外键、关键表零计数和隐私门禁。因此不能把现有代码检查或 Fake Gateway 通过视为受控实况发送前证明。

### 测试阶段文件变化

- 本测试阶段仅更新本报告：[OPENCLAW_INTERNAL_NOTIFICATION_TEST_REPORT.md](/home/yj/xiansuo/docs/03-测试验证/OPENCLAW_INTERNAL_NOTIFICATION_TEST_REPORT.md)。
- 两个最小复现只使用 `/tmp` 中的临时目录和临时 SQLite，并在命令结束时删除；没有写入 `server/data`、业务源码或真实 Gateway 状态。

### 复验结论

| 分级 | 数量 | 结论 |
| --- | ---: | --- |
| P1 | 2 | 临时路径可绕过真实隔离边界；污染/篡改的封存库可被判定 SAFE 并进入投递链路 |
| P2 | 0 | 无新增 P2 |
| P3 | 0 | 无新增 P3 |

**不允许进入 `acceptance_optimizer`，不允许真实 Pilot。** 必须先修复两项 P1，并新增完整性/外键、路径链、权限、所有关键表零计数、sealed 字段和污染库拒绝的独立回归；修复后重新执行 Server、Gateway、H5、`git diff --check` 和 `server/data` 哈希核验。真实 Pilot 仍须在通过最终验收后，另行按单条合成消息门禁执行。

---

## P1 修复后的实现侧回归（待 test_verifier 独立复验）

上述两项 P1 事实保留。实现已新增 realpath 边界、精确权限/hardlink 校验及共享 sealed-state 门禁；定向 7 项测试覆盖上级链接、硬链接、DB/WAL/SHM `0600`、各业务表污染、规则启用、任务篡改和外键异常，均通过。实现侧已重新运行 `server npm run build && npm test`（**135/135**）、Gateway build/test（**34/34**）和 H5 build，均通过；未进行真实外呼。该段不是独立测试结论，P1 是否关闭仍由 test_verifier 判定。

### 后续 P1：污染批次的 Worker 全局失败关闭（待独立复验）

独立验证发现：含 synthetic 任务及额外 OpenClaw 任务的污染库会被 Worker 一次领取两项，synthetic 虽拒绝，排序在前的非 synthetic 项仍可调用 Gateway。实现已增加 marker 驱动的 Worker 批次门禁，分别在 claim 前和有任务的 claim 后校验整个 sealed DB。新增回归覆盖额外 `pending`、`retry_wait`、可恢复 `sending` 各自的两种任务排列，并显式覆盖两任务已领取后的门禁；8 项 synthetic 测试均通过且每组 Gateway 调用为 0。此为实现侧结果，独立 verifier 必须重新判定该 P1。

---

## synthetic 隔离 P1 修复后独立复验（2026-08-01）

本节关闭上文历史 P1；历史发现和原始复现证据保留，不被改写。

### 已独立复验通过

- 路径和文件门禁：`assertSyntheticDatabasePath()` 以 `realpath` 后的真实临时根做边界校验，要求请求目录与真实目录完全一致；上级符号链接、仓库内/相对路径、非 `0700` 目录均拒绝。DB、WAL、SHM 必须是非链接、普通、单硬链接且精确 `0600`；定向测试覆盖上级链接、hardlink、非 `0600` DB/WAL/SHM，均通过。
- sealed-state：创建后、同键重复、queue-check 与 Worker 前/后领取共用 `assertSyntheticDatabaseSafety`。它检查 `integrity_check=ok`、空 `foreign_key_check`、`001–007` checksum、唯一测试 member、完整默认关闭规则、业务/跟进/审计/AI 等非白名单表为零、唯一任务的固定 envelope/快照/尝试/租约/时间/回执阶段字段和快照隐私。
- 重复语义独立最小复现：`created → pending deduplicated → sent deduplicated`；将任务改为 `failed/OPENCLAW_SEND_RESULT_UNKNOWN` 后重复被拒绝，输出为 `{"first":"created","pending":"deduplicated","sent":"deduplicated","failedRejected":true}`。
- queue-check 仍使用只读 SQLite：同一封存库连续两次均为 `SAFE`，主 DB 文件 SHA-256 前后相同，输出为 `{"first":"SAFE","second":"SAFE","hashUnchanged":true}`。
- 重点回归：运行定向 synthetic 测试，额外 `pending`、`retry_wait`、可恢复 `sending` 各两种排序（共六组）均在 claim 前输出 `notification.worker.synthetic_batch_blocked`；每组伪 Gateway 调用均为 **0**。测试还显式领取两任务批次并验证 claim 后 sealed 门禁拒绝，避免排序或 batch size 绕过。
- 伪 Gateway 正常链路仍验证唯一封存任务只发送一次；请求正文是固定测试文字，不含客户、联系人、手机号、微信号、需求、跟进、Prompt、JWT、Cookie 或 Key。全程拦截 `fetch`，没有真实网络或微信调用。

### 已执行命令

- `cd server && npm run build && npm test`：通过，**135/135**。
- `cd server && npx tsx --test --test-name-pattern='synthetic 标记库的污染批次' test/openclaw-synthetic-pilot.test.ts`：通过，**1/1**；六种污染/排序组合均阻断 Gateway。
- `cd poc/ilink-gateway && npm run build && npm test`：通过，**34/34**。
- `cd app && npm run build:h5`：通过；未构建小程序。
- `git diff --check`：通过。`server/data` 的所有文件哈希与本轮开始前一致；测试仅在 `/tmp` 创建并清理隔离 SQLite。

### 当前结论

| 分级 | 数量 | 结论 |
| --- | ---: | --- |
| P1 | 0 | 路径逃逸、污染 sealed 重复和污染批次外呼均已独立复验关闭 |
| P2 | 0 | 未发现新增中等级问题 |
| P3 | 0 | 未发现新增低等级问题 |

**允许进入 `acceptance_optimizer` 最终验收。** 本结论仅覆盖自动化、临时 SQLite 和伪 Gateway；不授权真实 Pilot、扫码、OpenClaw 登录或真实微信发送。真实 Pilot 仍需最终验收确认全部前置条件后，按单条合成消息流程另行受控执行。

---

## OpenClaw 2026.7.1-2 structured channel status 独立复验（2026-08-01）

### 范围与方法

- 基线包含实现阶段已存在的 [official-runtime.ts](/home/yj/xiansuo/poc/ilink-gateway/src/official-runtime.ts) 和 Gateway 测试差异；本测试阶段只更新本报告。
- 以伪 `OfficialCommandRunner` 返回官方 CLI JSON，未启动 OpenClaw daemon、未登录、未扫码、未运行真实官方发送命令或 HTTP 外呼。
- 该版本没有可配置的发送账号 ID 绑定字段；`ILINK_POC_RECIPIENT_EXTERNAL_ID` 是接收人标识而非账号绑定。因此“accountId mismatch”无可适用的绑定语义；解析器仍只使用 accountId 的类型/非空校验，且公开输出不投影它。

### 已独立复验通过

- 仅当精确配置渠道 `openclaw-weixin` 的 `configured=true`，且该渠道恰有一个完整账号（非空字符串 accountId、布尔 enabled/configured/running/restartPending、`lastError` 显式存在、非负整数 reconnectAttempts），并且 `enabled/running=true`、`restartPending=false`、`lastError=null`、`reconnectAttempts=0` 时，状态为 `authenticated`。
- 伪 CLI 矩阵验证：空账号→`login_required`；多账号、错误渠道、缺失 `lastError`、错误 accountId/reconnectAttempts/lastError 类型、或 reconnectAttempts>0/lastError 非空→`unknown`；enabled=false、running=false、restartPending=true→`offline`；账号或渠道 configured=false→`login_required`；仅账户显式 `status='restricted'` 才为 `restricted`。`lastError` 中包含 “restricted” 的文字仍为 `unknown`，不会从错误文案推断限制状态。
- 旧顶层 `{status:'authenticated'}` 仍由 `OfficialRuntime.sessionStatus()` 的 legacy 路径兼容为 authenticated；但任何带有 `channels` 或 `channelAccounts` 的不完整 structured envelope 均为权威输入，不能被同一 payload 的顶层 authenticated 宽松放行。
- 独立发送门禁复现：伪 CLI 返回 `{status:'authenticated', channels:{}, channelAccounts:{}}`，Adapter 返回 `permanent_failure/ILINK_SESSION_STATUS_UNKNOWN`，伪 transport 调用数为 **0**。因此 unknown 不会进入发送 transport。
- `official-session-status` 的公开投影仅有 installed、loggedIn、sessionStatus、requiresHumanLogin、code；结构化健康用例确认 accountId 不出现在输出。

### 命令与结果

- `cd poc/ilink-gateway && npm run build && npm test`：通过，**36/36**。
- `cd server && npm run build && npm test`：通过，**137/137**。
- `cd app && npm run build:h5`：通过；未构建小程序。
- `git diff --check`：通过；`server/data` 全部哈希保持基线值。

### 结论

| 分级 | 数量 |
| --- | ---: |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 |

**允许再次进入 `acceptance_optimizer`。** 本次仅验证伪 CLI 与伪 transport 的失败关闭；不构成真实 daemon、真实微信账号或真实 Pilot 的授权。

---

## 最终验收范围内加固（2026-08-01，非独立测试结论）

`acceptance_optimizer` 在最终顺序审查中复现：Worker 原先在 synthetic sealed 门禁前运行 retention cleanup，额外终态污染若已到保留期会先被删除，存在污染证据被清除后继续投递的可能。验收将 sealed 门禁前移到任何队列维护之前，并新增“额外过期 failed 行”回归，确认污染行不被删除且 Gateway 调用为 0。普通无 synthetic marker 的 Worker 仍执行原 retention 流程。

同时补齐唯一任务的 `lease_recovery_count`、`management_audit_json`、`row_version`、`last_attempt_at`、`sent_at`、`retain_until` 和固定 TTL 封存；新增相应篡改拒绝用例。验收执行结果：Server build 与 **137/137** 测试通过，Gateway build 与 **34/34** 测试通过，H5 build 通过，`git diff --check` 通过，`server/data` 哈希未变化。未登录微信、未发送消息、未调用 DeepSeek。

该加固由最终验收角色完成并复跑全量验证，不追溯改写上面的独立复验事实。修复后最终分级为 P1/P2/P3 = **0/0/0**。

---

## 实况前 P1：OpenClaw 2026.7 structured status 兼容（实现记录，已由上文独立复验关闭）

实况前置检查发现 OpenClaw `2026.7.1-2` 的官方 `channels status --channel openclaw-weixin --probe --json` 输出没有旧的 top-level `status`、`session.status` 或 `channel.status`，而是 `channels.openclaw-weixin.configured=true` 和 `channelAccounts.openclaw-weixin` 的单账号运行状态。因此旧 Gateway 映射为 `unknown` 并拒绝实况；该 P1 发生在 daemon 已停止、未入队和未发送的前置检查阶段。

实现新增严格兼容解析：仅精确指定 channel、configured、恰好一个账号、`enabled/configured/running=true`、`restartPending=false`、`lastError=null`、`reconnectAttempts=0` 且账号字段类型完整时映射 authenticated。空/多账号、缺失、错误、重连、停止或篡改均不会认证；明确 `configured=false` 映射 login_required，明确 disabled/running=false/restartPending 映射 offline，仅 `account.status` 的官方精确枚举可映射 restricted，错误文本绝不推断限制。账号 ID 不输出。该初始实现的 Gateway build/test 为 **36/36**；上文记录了 test_verifier 的独立复验结论。

---

## structured status 最终验收加固（2026-08-01，非独立测试结论）

`acceptance_optimizer` 复现：结构化账号如果携带未知字符串或非字符串 `status`，初始解析器会忽略该字段，并可能由其他健康字段认证；纯空格 accountId 也会通过非空检查。验收修复后，status 缺失仍兼容实际 2026.7 结构，存在时必须属于明确健康或明确状态枚举，否则返回 unknown；accountId 必须 trim 后非空。

新增持久回归确认未知 status 返回 `permanent_failure/ILINK_SESSION_STATUS_UNKNOWN`，发送 transport 调用数为 0，结果中不含 accountId。最终命令：Gateway build 与 **37/37**、Server build 与 **137/137**、H5 build、`git diff --check` 全部通过，`server/data` 哈希不变。未启动 daemon、未登录、未扫码、未发送消息。最终 P1/P2/P3 = **0/0/0**。
