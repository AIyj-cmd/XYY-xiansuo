# 阶段三通知基础设施冻结设计

状态：已由用户确认，作为阶段三后续实现的批准设计边界。
设计基线：`baseline/phase2-freeze-20260730`
基线提交：`126873489a927f975e4786fdd85e81b4d7a7ce8c`

修订原因：

> 根据用户最新业务决定，保留线索池和全部线索功能，仅关闭“公海待认领”子入口及认领能力；历史数据与审计保留，关闭后不再产生新的 `pool_claim`。

## 1. 目标与范围

阶段三建设一个不依赖真实消息渠道的可靠通知基础设施：

```text
业务事件
→ 通知规则
→ 持久化通知任务
→ 独立 Worker
→ Mock 通知渠道
→ 成功、失败、重试、取消、抑制和审计
```

首批只接入 `owner_changed`。以下事件只预留枚举和扩展方式，不接入真实业务扫描或发送流程：

```text
scheduled_follow_overdue
visit_reminder
status_changed
daily_report
weekly_report
inactive_lead
```

其中：

- `inactive_lead` 默认关闭；
- `visit_reminder` 等待拜访计划模块；
- 日报、周报等待统计和后续 AI 模块；
- 不得增加 `lead_created` 或 `sales_stage_changed`。

阶段三明确不做：

- 普通微信、企业微信或其他真实消息渠道；
- 微信绑定、登录二维码、token 或渠道凭证；
- DeepSeek 或任何 AI 能力；
- 拜访计划、日报、周报或 `sales_stage`；
- Redis、BullMQ、Kafka、RabbitMQ 或独立数据库；
- 外部网络请求；
- 管理员通知前端页面；
- 全面调整现有线索读取权限；
- 将现有 `/api/notifications` 改造成 outbox 查询接口。

### 1.1 线索池功能边界

线索池结构冻结为：

```text
线索池
├── 全部线索：保留
└── 公海待认领：软关闭
```

必须保留：

- 底部导航中的“线索池”入口；
- `pages/pool/index.vue` 线索池页面；
- “全部线索”模式；
- 全部线索的查看、搜索、筛选、排序、分页、收藏和详情跳转；
- `GET /api/leads` 及线索详情接口；
- 管理员分配负责人；
- 单条和批量负责人转移；
- 已有线索、跟进、负责人关系和审计记录。

只关闭：

- “公海待认领”模式入口；
- 公海未跟进天数筛选和列表；
- 公海认领按钮和交互；
- `GET /api/pool`；
- `POST /api/pool/:id/claim`；
- 旧客户端或手工 HTTP 请求绕过前端执行公海查询或认领的能力。

该决定不是关闭整个线索池，也不改变“全部线索”行为。采用可回滚软关闭：保留历史代码和数据，只有经过新的业务批准并显式开启独立配置后才能恢复。

## 2. 当前代码扩展点

### 2.1 负责人统一变更

负责人真实变化统一经过：

```text
server/src/services/lead-owner.ts
  transferLeadOwner()
```

该服务负责：

1. 校验新负责人存在且启用；
2. 读取旧负责人；
3. 相同负责人返回 `changed: false`；
4. 使用旧负责人条件更新，避免并发覆盖；
5. 写 `audit_logs.action='transfer'`；
6. 保存 `source` 和 `operation_id`。

事务由 `server/src/routes/leads.ts` 的调用入口控制：

- 单条编辑：`single_edit`；
- 批量转移：`batch_transfer`，整个批次共享 `operation_id`；
- 当前冻结基线仍包含公海认领入口和历史兼容来源 `pool_claim`。

阶段三实施前必须先以 `LEAD_POOL_CLAIM_ENABLED=false` 关闭公海子功能。关闭判断发生在公海查询、参数校验、事务和负责人变更之前，因此运行时不再产生新的 `pool_claim`。

阶段三通知只能在单条和批量负责人变更的统一事务内创建 `owner_changed` outbox，不得在路由中分别拼装通知，也不得通过事后轮询 `audit_logs` 推导待发送任务。

### 2.2 数据库与迁移

`server/src/db.ts` 当前使用：

- `node:sqlite` 的 `DatabaseSync`；
- WAL；
- `PRAGMA foreign_keys=ON`；
- 版本化迁移和固定 checksum；
- `BEGIN IMMEDIATE`；
- `integrity_check` 和 `foreign_key_check`。

迁移 `004` 只追加到现有 `MIGRATIONS`，不得修改 `001`、`002`、`003`。

### 2.3 Fastify、权限和后台任务

- `server/src/index.ts::buildApp()` 负责数据库初始化、管理员初始化、错误处理和路由注册。
- 管理 API 复用 `server/src/middleware/auth.ts::requireAdmin`，角色和启用状态每次请求从数据库实时读取。
- Worker 不从 `buildApp()` 自动启动，使用同仓库独立进程入口。
- Scheduler 只建设空任务注册框架和 dry-run，不接入真实业务扫描器。

### 2.4 现有通知页面

当前 `GET /api/notifications` 只是实时合并：

- `audit_logs` 中转给当前用户的负责人变化；
- 当前用户的逾期跟进线索。

前端通知页面和 H5 Notification API 只是动态列表、本地已读时间和浏览器提醒，不具备持久化、重试、租约或可靠发送能力。

阶段三保留该接口、页面和历史数据。公海待认领关闭后不会再产生新的 `pool_claim` 审计；已有 `pool_claim` 不删除、不改写，也不得转换成新的 `notification_logs`。

当前 `/api/notifications` 可能继续展示部分历史认领记录。是否过滤历史展示属于后续站内通知中心优化，不纳入阶段三。

### 2.5 线索池前端和后端现状

当前 `app/src/pages/pool/index.vue` 同时承载：

- “全部线索”：使用 `GET /api/leads`；
- “公海待认领”：使用 `GET /api/pool` 和 `POST /api/pool/:id/claim`。

关闭状态下页面继续存在，默认且只展示“全部线索”；不展示公海模式、未跟进天数选择器、统计文案、空状态、`idle_days` 和认领按钮，也不发起两个公海请求。

前端隐藏不是安全边界。后端必须通过独立开关拒绝两个公海接口，防止旧 H5、小程序和手工请求绕过。

## 3. `owner_changed` 事件

事件模型：

```ts
type OwnerChangedEvent = {
  schemaVersion: 1
  eventType: 'owner_changed'
  operationId: string
  source: 'single_edit' | 'batch_transfer'
  occurredAt: string
  leadId: number
  actorUserId: number
  oldOwnerId: number | null
  newOwnerId: number
}
```

通知资格：

```text
old_owner_id != new_owner_id
AND new_owner_id != actor_user_id
```

适用：

- admin 单条转给其他用户；
- member 将自己负责的线索转给其他用户；
- admin 或 member 合法批量转移中的每条真实变化。

不写 `notification_logs`：

- 新旧负责人相同；
- 操作者转给自己；
- API 重复提交形成的负责人 no-op；
- 普通新增线索；
- 普通字段编辑。

通知记录与业务审计严格分离：

- 所有真实负责人变化继续写 `audit_logs`；
- 相同负责人沿用阶段二规则，不写重复 transfer 审计；
- 关闭前历史公海真实认领产生的 `audit_logs.source='pool_claim'` 永久保留；
- 显式重新开启公海功能后，真实认领仍必须沿用原业务审计规则；
- 公海关闭状态下请求在负责人事务前被拒绝，因此不产生负责人变化、业务审计或通知任务；
- `pool_claim` 只作为 `OwnerTransferSource` 和历史审计来源兼容，不属于阶段三 `OwnerChangedEvent.source`。

建议区分：

```ts
type OwnerTransferSource =
  | 'single_edit'
  | 'batch_transfer'
  | 'pool_claim' // 业务审计和历史兼容

type NotifiableOwnerTransferSource =
  | 'single_edit'
  | 'batch_transfer'
```

接收人不能由请求传入，固定由后端计算：

```text
recipient_user_id = new_owner_id
```

## 4. 功能开关、事件捕获与发送开关

### 4.1 公海待认领开关

必须增加独立服务端配置：

```text
LEAD_POOL_CLAIM_ENABLED=false
```

严格解析：

- `true`：启用原公海子功能；
- `false`：关闭；
- 未设置：默认关闭；
- 非法值：启动失败，不静默回退。

不要使用 `LEAD_POOL_ENABLED`，因为线索池和“全部线索”继续保留。

前端使用构建期开关：

```text
VITE_LEAD_POOL_CLAIM_ENABLED=false
```

- 后端开关是安全和业务事实源；
- 前端开关只负责软关闭 UI；
- 两者不一致时以后端为准；
- 关闭时不删除公海代码或历史数据。

两个公海接口统一契约：

```text
HTTP 403
error_code: LEAD_POOL_CLAIM_DISABLED
```

`GET /api/pool`：

```json
{
  "code": 1,
  "msg": "公海待认领功能已关闭，线索池“全部线索”仍可正常使用",
  "data": {
    "error_code": "LEAD_POOL_CLAIM_DISABLED"
  }
}
```

处理顺序：

```text
authenticate
→ 检查 LEAD_POOL_CLAIM_ENABLED
→ 校验查询参数
→ 查询数据库
```

`POST /api/pool/:id/claim`：

```json
{
  "code": 1,
  "msg": "公海待认领功能已关闭，暂不支持认领线索",
  "data": {
    "error_code": "LEAD_POOL_CLAIM_DISABLED"
  }
}
```

处理顺序：

```text
authenticate
→ 检查 LEAD_POOL_CLAIM_ENABLED
→ 校验 ID
→ BEGIN IMMEDIATE
→ 原有公海校验和认领
```

选择 403 是因为合法登录用户被业务功能开关禁止。不得使用会诱导重试的 503，也不使用无法准确表达关闭原因的 404 或表示单条状态冲突的 409。

### 4.2 通知捕获和 Worker 开关

必须使用两个独立开关：

```text
NOTIFICATION_CAPTURE_ENABLED
NOTIFICATION_WORKER_ENABLED
```

辅助开关：

```text
NOTIFICATION_MOCK_ENABLED
NOTIFICATION_SCHEDULER_ENABLED
```

规则：

1. `NOTIFICATION_CAPTURE_ENABLED=true`
   - 符合通知资格的业务事件必须在业务事务内写 outbox；
   - 对应规则关闭时写 `suppressed`；
   - outbox 写入失败时负责人变化和 transfer 审计一起回滚。
2. `NOTIFICATION_CAPTURE_ENABLED=false`
   - 负责人业务和原有 `audit_logs` 正常执行；
   - 不写 `notification_logs`；
   - 必须输出结构化警告 `notification.capture.disabled`；
   - 警告必须明确该期间事件不会补发；
   - 只允许用于迁移尚未完成或通知基础设施紧急故障。
3. `NOTIFICATION_WORKER_ENABLED=false`
   - Worker 不领取或发送；
   - 已写入的 `pending`、`retry_wait` 和 `suppressed` 记录保留；
   - API 和事件捕获不受影响。
4. 所有规则默认关闭，Worker 默认关闭。
5. 开发和试运行环境在迁移 `004` 完成后可以开启事件捕获。
6. Mock 默认关闭；启用引用 Mock 的规则前必须显式开启。

不再使用一个含义模糊的 `NOTIFICATION_INFRA_ENABLED` 同时控制捕获和发送。

## 5. 规则服务

建议接口：

```ts
interface NotificationRuleService {
  loadRule(eventType, database): ParsedRule
  evaluateOwnerChanged(event, database, asOf): NotificationDecision
  preview(eventType, candidateRule, sample, asOf): PreviewResult
}
```

### 5.1 加载和校验

- 事件生成时直接通过当前事务连接读取规则；
- 每个事件使用独立、严格模式的 Zod schema；
- `owner_changed.recipient_strategy` 固定为 `new_owner`；
- 阶段三 `channel_order` 只能包含单一 `mock`；
- `config_json` 最大 16 KiB；
- 禁止 URL、token、secret、password、webhook、key 等渠道秘密字段；
- 未实现事件不能启用。

`owner_changed` 配置版本 1：

```json
{
  "schema_version": 1,
  "quiet_hours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00",
    "timezone": "Asia/Shanghai"
  },
  "max_attempts": 5,
  "ttl_minutes": 1440
}
```

### 5.2 规则结果

- 不符合事件资格：不写通知记录；
- 捕获开启、事件符合资格、规则关闭：写 `suppressed/rule_disabled`；
- 接收人不存在或停用：写 `suppressed/recipient_inactive`；
- 没有可用渠道：写 `suppressed/no_usable_channel`；
- 命中静默时间：写 `pending`，延后 `available_at`；
- 正常：写 `pending`。

### 5.3 规则变更

- 配置变化只影响新任务；
- 每条通知保存 `rule_version` 和不可变规则快照；
- 关闭规则时，在规则更新事务内取消该规则产生的 `pending/retry_wait`；
- 已经处于 `sending` 的任务按领取时快照继续完成，不被规则更新事务修改；
- `sent/suppressed/cancelled/failed` 历史不变；
- 不重新渲染旧任务。

阶段三不新增规则历史表，先使用：

```text
version
updated_by
updated_at
```

完整规则变更历史列为后续优化。

## 6. 迁移 `004`

建议描述：

```text
create notification rules and reliable notification outbox
```

要求：

- 仅创建 `notification_rules`、`notification_logs` 及索引；
- 不修改现有业务表和数据；
- 不读取或更新公海候选线索；
- 不修改 `leads.owner_id`、`last_follow_at` 或公海阈值配置；
- 不更新、删除、回填 `audit_logs.source='pool_claim'`；
- 不创建公海表、认领状态字段或数据清理任务；
- 不把 `LEAD_POOL_CLAIM_ENABLED` 存入数据库；
- 不把历史 `pool_claim` 转换为 `notification_logs`；
- 不改变 `GET /api/leads` 和“全部线索”的行为；
- 不关闭外键；
- 不修改 `001`、`002`、`003` 的内容或 checksum；
- checksum 只在最终 SQL 冻结后计算；
- 空库按 `001 → 002 → 003 → 004` 执行；
- 阶段二数据库校验前三个 checksum 后只执行 `004`；
- 重复执行安全跳过；
- 失败时由现有迁移事务整体回滚。

## 7. `notification_rules`

建议字段：

```text
event_type               TEXT PRIMARY KEY
enabled                  INTEGER NOT NULL
recipient_strategy       TEXT NOT NULL
channel_order_json       TEXT NOT NULL
config_schema_version    INTEGER NOT NULL
config_json              TEXT NOT NULL
version                  INTEGER NOT NULL
updated_by               INTEGER NULL FK users
created_at               TEXT NOT NULL
updated_at               TEXT NOT NULL
```

约束：

- `enabled IN (0,1)`；
- `event_type` 只允许批准的七个枚举；
- `owner_changed` 的 `recipient_strategy='new_owner'`；
- JSON 必须 `json_valid`、类型正确并限制长度；
- `version >= 1`；
- `updated_by REFERENCES users(id) ON DELETE SET NULL`。

种子：

- `owner_changed`：关闭、`new_owner`、`["mock"]`、schema v1；
- 其他预留事件：关闭、`reserved`、空渠道，API 不允许启用。

## 8. `notification_logs`

该表同时承担事务性 outbox、待处理队列、幂等、租约、重试、结果和管理审计。

### 8.1 事件和主体

```text
id
event_type
event_source
operation_id
subject_type
subject_id
lead_id
actor_user_id
old_owner_id
new_owner_id
recipient_user_id
occurred_at
```

### 8.2 幂等和快照

```text
dedupe_key
delivery_idempotency_key
rule_version
rule_snapshot_json
channel_order_snapshot_json
channel
message_snapshot_json
```

### 8.3 状态、租约和重试

```text
status
attempt_count
automatic_attempt_count
manual_retry_count
max_attempts
available_at
lease_token
lease_owner
lease_until
lease_recovery_count
retry_allowed
```

### 8.4 结果和生命周期

```text
provider_message_id
failure_class
last_error_code
last_error_message
suppression_reason
cancellation_reason
management_audit_json
expires_at
retain_until
last_attempt_at
sent_at
failed_at
suppressed_at
cancelled_at
row_version
created_at
updated_at
```

关键约束：

- 状态只允许七种批准状态；
- `channel` 为空或 `mock`；
- `event_type='owner_changed'` 时，`event_source` 只允许 `single_edit` 或 `batch_transfer`；
- JSON 合法、类型正确并限制长度；
- 尝试次数非负，`max_attempts` 为 1～10；
- `sending` 必须有完整租约；
- `sent` 必须有 `sent_at` 和 `provider_message_id`；
- `suppressed/cancelled` 必须有对应原因；
- `owner_changed` 必须满足：
  - lead、actor、new owner、recipient 非空；
  - recipient 等于 new owner；
  - old owner 与 new owner不同；
  - actor 与 new owner不同。

事件主体外键建议使用 `ON DELETE RESTRICT`，保留历史审计主体。

### 8.5 索引

至少包括：

```text
唯一 dedupe_key
唯一 delivery_idempotency_key（非空）
owner_changed 复合唯一索引
status + available_at 就绪队列索引
sending + lease_until 租约回收索引
created_at + id 管理列表索引
recipient_user_id + created_at
event_type + occurred_at
lead_id + created_at
retain_until 终态清理索引
```

## 9. 幂等

业务事件规范化原文：

```text
v1|owner_changed
|operation_id=<operation_id>
|lead_id=<lead_id>
|new_owner_id=<new_owner_id>
|recipient_user_id=<recipient_user_id>
```

```text
dedupe_key = SHA-256(规范化原文)
```

同时建立：

```text
UNIQUE (
  event_type,
  operation_id,
  lead_id,
  new_owner_id,
  recipient_user_id
)
WHERE event_type = 'owner_changed'
```

唯一冲突处理：

- 已有记录的不可变事件字段完全相同：幂等命中；
- 字段不一致：数据异常，回滚当前业务事务。

渠道发送使用独立键：

```text
delivery_idempotency_key =
SHA-256("v1|channel=mock|event=" + dedupe_key)
```

阶段三不新增投递明细表。业务事件幂等、单 Mock 渠道、receipt 和发送结果都保存在 `notification_logs`。真实渠道或多渠道 fallback 接入前必须重新评估独立投递明细。

## 10. 状态机、TTL 和保留

状态：

```text
pending
sending
retry_wait
sent
suppressed
cancelled
failed
```

合法转换：

```text
pending → sending
retry_wait → sending
sending → sent
sending → retry_wait
sending → failed
pending/retry_wait → cancelled
过期 sending → sending（租约回收且未超过 TTL）
符合资格但规则抑制 → suppressed
```

禁止：

- `sent` 再次发送；
- `suppressed/cancelled` 直接重试；
- 终态自动返回 `sending`；
- 无限自动重试。

TTL 和清理：

1. `owner_changed` 默认 `expires_at = occurred_at + 24小时`。
2. Worker 每轮领取前执行有上限的队列维护：
   - 过期 `pending/retry_wait` 转为 `cancelled/task_expired`；
   - 过期且租约已经失效的 `sending` 转为 `cancelled/task_expired`；
   - 未过期的失效租约可以重新领取。
3. `suppressed/sent/failed/cancelled` 为终态，`retain_until` 固定为终态时间加 180 天。
4. Worker 使用独立的小批量清理事务删除 `retain_until <= now` 的终态记录。
5. Worker 关闭时不执行自动清理，记录允许保留超过 180 天，但绝不能提前删除。
6. 清理只操作通知表，不操作业务表；每批默认不超过 100 条，并记录结构化统计。
7. 生产启用清理前必须完成数据库副本和恢复演练。

## 11. Worker

阶段三采用同仓库独立 PM2 进程：

```text
Fastify API 进程
notification-worker 进程（instances: 1）
```

约束：

- 两个进程使用同一绝对 `DB_PATH`；
- Worker 建立自己的 SQLite 连接，复用 WAL、外键和连接配置；
- 建议 `busy_timeout=5000`；
- 默认批次 10、并发 2；
- 领取和状态更新使用短事务；
- 渠道调用永远在事务外；
- Worker 停止、异常或延迟不影响 API；
- 优雅关闭停止领取，最多等待 10 秒；
- 进程重启后通过租约继续处理。

原子领取必须：

- 使用 `BEGIN IMMEDIATE`；
- 只领取 `available_at <= now` 且未过期的 `pending/retry_wait`；
- 或回收未过期但租约已失效的 `sending`；
- 设置唯一 `lease_token`、`lease_owner`、`lease_until`；
- 使用 `RETURNING` 获取任务；
- 最终状态更新必须带 `lease_token` 条件，旧 Worker 不能覆盖新租约。

默认租约 60 秒。

临时错误：

```text
timeout
rate_limit
temporary_5xx
temporary_unavailable
```

永久错误：

```text
invalid_channel_config
invalid_message_schema
unrecoverable_task_data
mock_disabled
```

最多自动尝试 5 次，包括首次。建议退避：

```text
30秒
2分钟
10分钟
30分钟
```

增加 ±20% jitter；安全的 `retry_after` 可覆盖退避但不超过 30 分钟。

管理员只可重试未过期、允许重试、配置已恢复、接收人仍有效且没有成功 receipt 的 `failed` 任务。

## 12. Mock 渠道

统一接口：

```ts
interface NotificationChannel {
  readonly name: 'mock'
  send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
    idempotencyKey: string,
    signal: AbortSignal
  ): Promise<{
    providerMessageId: string
    deduplicated: boolean
  }>
  health(): Promise<{
    status: 'ok' | 'degraded' | 'down'
    code?: string
  }>
}
```

阶段三只实现 `MockNotificationChannel`，支持测试和开发环境故障注入：

```text
success
timeout
rate_limit
temporary_5xx
permanent_config_error
duplicate
delay
```

Mock 必须：

- 不访问网络；
- 不读取任何真实凭证；
- 不修改 leads、follow_ups、users 或 audit_logs；
- 相同 delivery key 返回确定性的相同 receipt；
- 重启后重复调用不会形成新的 Mock 副作用；
- 生产默认关闭；
- 普通业务 API 不能控制故障模式。

## 13. Scheduler 和 dry-run

只设计并实现可测试框架：

```ts
interface SchedulerJob<T> {
  readonly eventType: NotificationEventType
  scan(options: {
    asOf: string
    limit: number
    deadlineAt: number
    dryRun: boolean
  }): Promise<SchedulerScanResult<T>>
}
```

要求：

- `as_of` 可注入；
- 默认上限 100，最大 1000；
- 默认超时 5 秒；
- dry-run 只返回候选、抑制原因和脱敏样例；
- dry-run 不写数据库、不调用 Mock；
- 单个 job 异常不导致 Fastify 或 Worker 退出；
- 阶段三 registry 为空，不注册逾期、拜访、日报、周报或 inactive 扫描器。

队列 TTL 和保留清理属于 Worker 内部队列维护，不是业务 Scheduler 事件扫描。

## 14. 管理 API

全部使用数据库实时 `requireAdmin`，保持 `{ code, msg, data }`。

```text
GET  /api/admin/notification-rules
GET  /api/admin/notification-rules/:eventType
PUT  /api/admin/notification-rules/:eventType
POST /api/admin/notification-rules/:eventType/preview

GET  /api/admin/notification-logs
GET  /api/admin/notification-logs/:id
POST /api/admin/notification-logs/:id/retry
```

规则更新：

- 请求包含 `expected_version`；
- 使用 `UPDATE ... WHERE event_type=? AND version=?`；
- 成功后 `version+1`；
- 保存 `updated_by`；
- 非 `owner_changed` 启用返回 `EVENT_NOT_IMPLEMENTED`；
- 非 Mock 渠道返回 `CHANNEL_NOT_ALLOWED`；
- 配置非法返回 `RULE_CONFIG_INVALID`；
- 版本冲突使用 HTTP 409 和 `RULE_VERSION_CONFLICT`。

preview：

- 支持候选规则、示例主体和固定 `as_of`；
- 接收人仍由后端计算；
- 返回 `pending/suppressed/no_event`、可发送时间和脱敏消息；
- 不写规则、不写日志、不发送。

日志列表：

- 支持 event、status、channel、recipient、lead、operation、日期筛选；
- 默认每页 20，最大 100；
- 排序 `created_at DESC, id DESC`；
- 只返回脱敏摘要和安全错误码。

日志详情不得返回 SQL、参数、token、secret 或完整隐私。

管理员 retry 只接受：

```json
{
  "expected_version": 8,
  "reason": "配置已修复，人工重试"
}
```

`sent/suppressed/cancelled/expired` 均不得重发。

## 15. 权限与安全

- 只有 admin 可以管理规则、查看全量日志、preview 和 retry；
- member 对全部管理接口返回 403；
- admin 降级或停用后旧 JWT 立即失效；
- 接收人完全由后端计算；
- 通知详情路径不是授权凭证；
- 消息只保存相对详情路径；
- 消息和日志不得保存完整手机号、微信号、跟进内容、需求内容或 source_note；
- 不保存 SQL 参数、堆栈、原始 provider 错误或渠道秘密；
- Worker 和 Mock 只能修改通知表；
- Mock 失败不能回滚已提交的负责人变化；
- 捕获事务写入失败必须回滚负责人变化和 transfer audit；
- AI 权限、微信身份和渠道凭证不属于阶段三。

## 16. 可观测性

结构化事件：

```text
notification.capture.disabled
notification.task.created
notification.task.suppressed
notification.task.dedupe_conflict
notification.worker.claimed
notification.worker.sent
notification.worker.retry_scheduled
notification.worker.failed
notification.worker.cancelled
notification.worker.lease_recovered
notification.worker.retention_cleaned
notification.rule.updated
notification.admin.retry
notification.scheduler.scan
```

指标：

- 创建、pending、retry_wait、failed 数量；
- 最老待处理任务年龄；
- Worker 领取数和发送耗时；
- 尝试和重试次数；
- 幂等冲突数；
- suppressed、cancelled 数；
- lease 回收数；
- retention 清理数；
- 规则最近触发时间。

日志不得记录客户完整隐私、消息全文、SQL 参数、secret、微信凭证或模型输入。

## 17. 测试矩阵

### 17.1 数据库和迁移

- 空库执行 001～004；
- 阶段二数据库从 003 升级；
- 重复迁移；
- 004 checksum 冲突；
- 001/002/003 内容和 checksum 不变；
- JSON、状态、事件、渠道 CHECK；
- 外键、唯一约束和索引；
- integrity 和 foreign key check；
- 004 失败整体回滚；
- 无微信、AI、拜访或 sales_stage 对象。

### 17.2 事件和事务

- 普通新增、普通字段编辑不生成通知；
- admin/member 转给他人各生成一条；
- 转给自己、相同 owner 不写通知；
- 真实负责人变化仍按阶段二规则写 `audit_logs`；
- 历史 `pool_claim` 不转换为 outbox；
- `owner_changed.event_source` 只出现 `single_edit/batch_transfer`；
- 批量每条真实变化各一条，批次共享 operation_id；
- 捕获开启、规则关闭时写 suppressed；
- 捕获关闭时不写通知、业务审计保留且输出结构化警告；
- 通知写入失败时负责人、审计和整个批次全部回滚；
- Mock 失败不回滚负责人；
- 负责人再次变化取消旧 pending/retry_wait。

### 17.3 公海待认领软关闭

后端关闭态：

- 未登录访问两个公海接口仍先返回 401；
- admin/member 访问 `GET /api/pool` 均返回 403；
- admin/member 访问 `POST /api/pool/:id/claim` 均返回 403；
- 两个接口均返回 `LEAD_POOL_CLAIM_DISABLED` 和统一包络；
- 关闭检查发生在参数校验、数据库查询和事务之前；
- 旧客户端和手工请求不能绕过；
- POST 被拒绝后 owner 不变；
- 不新增 transfer audit 或 `pool_claim`；
- 不新增 `notification_logs`；
- 不开启负责人变更事务；
- 重复请求结果稳定。

后端启用态：

- `LEAD_POOL_CLAIM_ENABLED=true` 时原公海查询和认领功能恢复；
- 原权限、负责人事务和审计规则兼容；
- 公海认领仍不接入阶段三 `owner_changed` 通知来源。

前端关闭态：

- 底部“线索池”入口保留；
- 线索池页面正常打开；
- 默认且只显示“全部线索”；
- 不显示“公海待认领”、未跟进天数选择器或认领按钮；
- 不调用两个公海接口；
- `GET /api/leads`、搜索、筛选、分页、收藏和详情正常；
- H5 和微信小程序构建通过。

数据保护：

- 历史 `pool_claim` 审计数量和内容不变；
- 历史负责人关系不变；
- 不删除线索或跟进；
- 004 前后公海相关业务数据不变；
- 001/002/003 内容和 checksum 不变；
- 不创建公海数据清理迁移。

### 17.4 幂等

- API 响应丢失后重试；
- 相同 operation_id 和事件字段重复；
- dedupe key 唯一；
- 冲突字段不一致时失败；
- 批量每条 lead 独立；
- Worker 重复扫描和进程重启；
- delivery key 返回相同 Mock receipt；
- Scheduler fake job 重复扫描；
- preview 重复调用不落库。

### 17.5 Worker

- 成功、临时失败、永久失败、超时、限流和 5xx；
- 最大重试；
- 过期 lease 回收；
- 两 Worker 竞争；
- 旧 lease token 失效；
- TTL 过期转 cancelled；
- 180 天保留清理；
- Worker关闭保留事件；
- 优雅关闭和强制终止恢复；
- Mock关闭；
- Worker异常不影响 API；
- 无外部网络访问。

### 17.6 规则和管理 API

- admin 正常，member 403；
- admin 降权和停用实时生效；
- 乐观锁冲突；
- 非法 JSON、schema 和 secret-like 字段；
- owner_changed 固定新负责人；
- quiet hours 跨午夜；
- 未实现事件不能启用；
- preview 不写库、不发送；
- 日志分页、筛选和脱敏；
- retry 状态、TTL、规则和接收人限制；
- `{ code, msg, data }` 包络兼容。

### 17.7 功能回归和范围

- 原 39 项后端测试全部通过；
- 线索池“全部线索”列表、搜索、筛选、分页、收藏和详情不受影响；
- 单条、批量负责人转移和管理员分配负责人不受影响；
- 跟进新增、编辑和删除不受影响；
- 原有权限和 API 包络不受影响；
- 后端、H5、微信小程序构建通过；
- `git diff --check`；
- 001/002/003 未变化；
- 测试不污染 `server/data`；
- 无真实微信、企业微信、DeepSeek、AI、拜访、sales_stage 或外部网络请求。

## 18. 部署和回滚

默认配置：

```text
LEAD_POOL_CLAIM_ENABLED=false
NOTIFICATION_CAPTURE_ENABLED=false
NOTIFICATION_WORKER_ENABLED=false
NOTIFICATION_MOCK_ENABLED=false
NOTIFICATION_SCHEDULER_ENABLED=false
```

上线顺序：

1. 增加并校验后端 `LEAD_POOL_CLAIM_ENABLED=false`；
2. 先部署后端公海接口拒绝逻辑；
3. 验证旧 H5、小程序和手工请求均被 403 阻止；
4. 以 `VITE_LEAD_POOL_CLAIM_ENABLED=false` 构建并部署前端；
5. 验证底部线索池、全部线索、搜索、筛选和详情正常；
6. 冻结“公海待认领关闭”的最低回滚基线；
7. 完成生产数据库副本备份和恢复验证；
8. 在副本执行 `004`；
9. 完整迁移、回归和完整性检查；
10. 部署通知应用，全部通知开关关闭；
11. 开发或试运行环境开启事件捕获，规则仍全部关闭；
12. 通过 preview 和 suppressed 记录核验事件；
13. 非生产环境显式开启 Mock 和 Worker；
14. 显式启用 `owner_changed` 规则完成完整链路验收；
15. 生产真实渠道仍保持关闭，等待单独设计和批准。

关闭行为：

- 公海开关关闭：只拒绝公海查询和认领，线索池与全部线索正常；
- Worker关闭：任务保留，API和捕获正常；
- 规则关闭：新符合事件写 suppressed，旧 pending/retry_wait 取消；
- 捕获关闭：不写 outbox，业务继续，必须警告事件不会补发；
- Mock关闭：不得启用引用 Mock 的规则；
- Scheduler关闭：不影响 owner_changed。

回滚：

- 先停止 Worker；
- 关闭捕获和全部规则；
- 通知实现可以回滚，但不得回滚掉公海接口拒绝逻辑；
- `LEAD_POOL_CLAIM_ENABLED=false` 必须继续生效；
- 如果被迫回滚到不认识该开关的旧后端制品，必须先在反向代理精确阻断 `GET /api/pool` 和 `POST /api/pool/:id/claim`；
- 反向代理不得阻断 `GET /api/leads` 或线索池前端页面；
- 保留通知表、迁移记录和历史；
- 保留全部历史 `pool_claim`、负责人关系、线索和跟进；
- 不提供破坏性向下迁移；
- 迁移失败时恢复完整数据库备份；
- 不手工删除 `004` 记录或通知表。

## 19. 后续实现任务拆分

设计确认后的实现顺序固定为：

1. 增加、严格解析和测试 `LEAD_POOL_CLAIM_ENABLED`；
2. 后端两个公海接口增加统一功能开关拒绝；
3. 前端软关闭“公海待认领”，保留线索池和全部线索；
4. 完成公海关闭、历史数据和功能回归专项测试；
5. 冻结公海关闭最低回滚基线；
6. 迁移 `004`、两张表、索引、种子和迁移测试；
7. 通知环境开关、事件模型、Zod、规则服务和脱敏快照；
8. 在统一负责人事务中接入捕获、suppressed 和旧任务取消，运行时来源只含 `single_edit/batch_transfer`；
9. Worker 状态机、原子租约、TTL 和保留清理；
10. Mock 渠道和确定性 receipt；
11. 管理规则、日志、preview 和 retry API；
12. 空 Scheduler registry 和 dry-run；
13. 独立测试验证；
14. 最终验收。

阶段三实现仍属于高风险任务，必须继续按照 `AGENTS.md` 顺序执行 implementer、test_verifier 和 acceptance_optimizer。

## 20. 风险和冻结结论

主要风险：

- 文案或实现误把“公海待认领关闭”扩大为关闭整个线索池；
- 旧 H5、小程序仍显示或调用认领能力；
- 前后端公海开关配置漂移；
- 回滚到不识别开关的旧后端重新开放认领；
- 误删历史 `pool_claim` 或误把历史审计转换为 outbox；
- 公海关闭误伤 `GET /api/leads` 和“全部线索”；
- API 与 Worker 同写 SQLite 可能产生锁竞争；
- 捕获写入失败会阻断负责人变化；
- 关闭捕获期间的事件不会补发；
- Mock 幂等不能代表未来真实渠道 exactly-once；
- 负责人可能在 Worker 发送前再次变化；
- 现有 `/api/notifications` 与可靠 outbox 仍是两套语义；
- 当前详情读取权限较宽；
- 暂无完整规则变更历史。

处置边界：

- 后端开关是最终门禁，前端开关只控制 UI；
- 默认前后端公海开关均关闭，部署时双向验证；
- 公海关闭形成独立最低回滚基线；
- 迁移 004 和关闭实现不得修改历史 `pool_claim` 或负责人数据；
- `owner_changed.event_source` 只允许 `single_edit/batch_transfer`；
- 对管理员和 member 一致拒绝关闭的公海接口；
- 持续回归线索池、全部线索、搜索、筛选、收藏和详情；
- 单 Worker、小批量、短事务、busy timeout；
- 捕获关闭只作为迁移或紧急故障旁路；
- 任务发送前进行必要的负责人和接收人有效性检查；
- 真实渠道接入前重新审计投递明细和幂等边界；
- 站内通知中心统一和规则完整历史均列为后续优化。

本文件根据用户最新决定完成修订，并重新冻结阶段三通知基础设施的批准设计：线索池和“全部线索”保留，只软关闭“公海待认领”子入口及认领能力；历史数据和审计保留，关闭后不再产生新的 `pool_claim`。

任何涉及重新开放公海认领、真实渠道、AI、第三张投递或规则审计表、事件范围扩大、生产多 Worker 或外部队列的变更，都必须重新进入审计和用户确认门禁。
