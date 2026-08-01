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
