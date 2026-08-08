# XYY-xiansuo API 调整计划

> **后续决策覆盖说明（2026-08-01）：** 用户决定取消企业微信自建应用并暂停所有真实外部消息渠道；OpenClaw daemon 与 Direct iLink 为 No-Go，Hook/RPA/逆向/Windows 自动化继续禁止。本文中普通微信、企业微信、降级/fallback、PoC、Gateway 和相关迁移的设计/计划均不是当前计划，只保留为历史方案。现行正式通知仅为 H5 站内通知，Mock 仅用于测试/灰度；阶段三 outbox、通知规则、租约、重试、TTL、审计及阶段四 DeepSeek 调度、`scheduled_follow_overdue`、`daily_report`、AI 审计和模板降级保留，但不向真实外部渠道发送。迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 暂缓，不进入实现，不补发。只有官方普通微信提供独立 client/session 且支持主动通知，或用户批准公众号/服务号/其他合法官方渠道后，才可重新审计。

> 文档性质：兼容性 API 设计
> 修订日期：2026-07-30
> 当前阶段不修改、发布或调用任何接口

## 1. 设计原则

- 保留现有 `/api` 路径和 `{ code, msg, data }` 响应外形；
- 不破坏现有线索、跟进、工作台、导入导出流程；
- 外部微信和 DeepSeek 请求不在业务事务中执行；
- 前端不得直连微信或 DeepSeek；
- member 的 AI 数据范围严格限定为自己负责的客户；
- 新接口默认 JWT 鉴权，管理接口必须使用数据库实时角色；
- 普通微信入站使用独立服务认证，不能冒充用户 JWT；
- 不增加销售阶段请求字段或专用接口；
- 不提供公开“手动生成逾期通知”接口。

API、数据库和 worker 统一使用以下事件名：

```text
owner_changed
scheduled_follow_overdue
visit_reminder
status_changed
daily_report
weekly_report
inactive_lead（可选、默认关闭）
```

不存在 `lead_created` 事件：普通新增线索不通知。

## 2. 当前 API 权限事实

当前后端不是“所有读取都按 owner 隔离”：

| 能力 | 当前事实 |
| --- | --- |
| 线索列表 | 登录用户可不传 owner_id 查询全部 |
| 线索详情 | 登录即可读取，不校验 owner |
| 跟进列表 | 登录即可按 lead_id 读取 |
| 线索池 | 登录用户可查看 |
| 审计/关联线索 | 存在登录可读路径 |
| 工作台 | 多项统计为公司全量 |
| 写线索/跟进 | member 多数只能操作自己负责的线索 |

本计划不在通知/AI 开发中顺便重写所有页面权限，但 AI 接口必须使用独立、更严格的数据授权：

```text
member: lead.owner_id = request.user.id
admin: 按专用管理权限
```

无权限资源推荐返回 404 或统一无权响应，避免枚举 lead_id。

## 3. 现有线索接口调整

### 3.1 `POST /api/leads`

保持现有请求兼容，不增加通知。普通创建、无论 owner 如何确定，都不生成微信事件。

当前允许 member 传任意 `owner_id`。开发前需选择：

#### 方案 A：只能创建给自己

member 请求中的 `owner_id`：

- 省略：使用自己；
- 等于自己：允许；
- 其他值：403/400。

admin 可指定存在且启用的目标用户。

#### 方案 B：允许创建给其他业务员

member 和 admin 都必须由后端校验：

- 目标用户存在；
- `is_active = 1`；
- 角色符合业务规则；
- 操作者具有分配权限。

不能仅依赖前端用户下拉框。业务未确认前，文档不替公司选择。

### 3.2 `PATCH /api/leads/:id`

保持现有字段兼容，重点把 owner 和 status 变化交给内部统一服务。

建议流程：

```text
解析允许字段
→ 查询 lead 与 actor
→ 原有写权限校验
→ 校验目标 owner/status
→ BEGIN
→ 更新真实变化字段
→ 写 audit
→ owner/status 满足规则时写 pending 通知
→ COMMIT
→ 返回原兼容响应
```

规则：

- owner 新旧相同：不写 transfer，不通知；
- 新负责人等于 actor：可以转移，但默认 suppressed/not-created；
- 新负责人不同于 actor：通知新负责人；
- actor 可以是 admin 或 member，不限制为管理员；
- status 新旧相同：不通知；
- 普通字段变化永不通知；
- 请求不包含 `sales_stage`。

为了避免多字段部分成功，建议整个更新放在一个事务中。

### 3.3 `POST /api/leads/batch`

保留现有：

```json
{
  "ids": [1, 2],
  "action": "transfer",
  "owner_id": 3
}
```

实现必须改为内部批量服务逐条处理：

1. 限制 IDs 数量并去重；
2. 一次读取所有目标 lead、old owner 和 status；
3. 验证操作者对每条均有权限；
4. 验证新负责人存在且启用；
5. 事务内逐条更新真实变化；
6. 每条写 transfer audit；
7. 每条按 `old != new AND new != actor` 写通知；
8. 返回实际 changed、unchanged、not_found 计数。

建议兼容返回可增加：

```json
{
  "code": 0,
  "msg": "批量更新完成",
  "data": {
    "requested": 2,
    "changed": 1,
    "unchanged": 1
  }
}
```

第一阶段不增加批量销售阶段操作。

### 3.4 `POST /api/pool/:id/claim`

继续认领给当前用户。必须走统一负责人服务以得到一致的权限、审计和并发控制，但 event source 标记为 `pool_claim`。

因为：

```text
new_owner_id = actor_user_id
```

默认不发送负责人变更通知。

### 3.5 跟进接口

#### `POST /api/leads/:id/follow-ups`

保留现有请求字段。事务内：

- 写 follow_up；
- 设置 `last_follow_at`；
- 替换或清空当前 `next_follow_at`；
- 更新真实 status；
- status 真实变化时按规则写通知；
- 使旧约定逾期 pending 任务失效。

#### `PATCH /api/follow-ups/:fid`

当前只更新 follow_ups，不同步 leads。未来必须：

- 判断被编辑记录是否影响当前最新跟进/待办；
- 按权威算法重算 `last_follow_at` 和 `next_follow_at`；
- 事务内使旧 due_date 通知失效；
- 不因编辑普通内容产生微信通知。

#### `DELETE /api/follow-ups/:fid`

当前删除后不重算。未来必须：

- 权限校验；
- 删除；
- 重算 lead 派生字段；
- 处理没有剩余跟进时的业务规则；
- 取消失效逾期任务；
- 同事务写审计。

约定逾期提醒上线前，这三条路径必须完成一致性测试。

### 3.6 跟进类型

API 目前只接受：

```text
电话、微信、拜访、其他
```

前端快捷入口存在“邮件”是基线缺陷。API 不应在通知或 AI 开发中静默接受邮件。若业务要保留邮件，需单独更新前后端 schema 和数据库 CHECK。

## 4. 内部负责人变更服务

建议内部契约：

```ts
type TransferLeadCommand = {
  leadId: number
  newOwnerId: number
  actorUserId: number
  source: 'single_edit' | 'batch_transfer' | 'pool_claim' | 'admin'
  operationId: string
}
```

输出：

```ts
type TransferLeadResult = {
  changed: boolean
  oldOwnerId: number | null
  newOwnerId: number
  notificationDecision: 'pending' | 'suppressed'
}
```

该服务是后端内部职责，不新增一个让前端绕过现有写权限的“万能转移 API”。

## 5. 通知规则 API

全部要求 `requireAdmin`，且 role 使用数据库实时值。

### 5.1 查询

```http
GET /api/admin/notification-rules
GET /api/admin/notification-rules/:eventType
```

返回：

```json
{
  "event_type": "scheduled_follow_overdue",
  "enabled": false,
  "recipient_strategy": "rule",
  "channel_order": ["personal_wechat", "wecom_app"],
  "config": {
    "schema_version": 1,
    "include_paused": false,
    "levels": []
  },
  "version": 1
}
```

### 5.2 修改

```http
PUT /api/admin/notification-rules/:eventType
```

请求：

```json
{
  "enabled": true,
  "recipient_strategy": "rule",
  "channel_order": ["personal_wechat", "wecom_app"],
  "config": {
    "schema_version": 1,
    "include_paused": false,
    "levels": [
      {
        "key": "due_today",
        "days": 0,
        "send_at": "09:00",
        "recipient": "owner"
      },
      {
        "key": "overdue_2d",
        "days": 2,
        "send_at": "09:00",
        "recipient": "configured_admins",
        "user_ids": [1]
      }
    ]
  },
  "expected_version": 1
}
```

要求：

- eventType 白名单；
- 不同事件使用不同 schema；
- user_ids 必须存在、启用且符合角色；
- channel 白名单；
- 乐观锁避免覆盖；
- config 不得含 URL、secret 或 token；
- 修改写管理员审计。

### 5.3 Dry-run 预览

```http
POST /api/admin/notification-rules/:eventType/preview
```

请求可以传候选配置，但不落库、不发送：

```json
{
  "config": {},
  "as_of": "2026-07-30"
}
```

返回：

- 预计命中数量；
- 各接收人数量；
- 被抑制数量和原因；
- 脱敏消息样例；
- 数据扫描时间。

不返回完整手机号、微信号或跟进内容。第一版不提供“手动生成并发送逾期”公开接口。

## 6. 通知日志 API

### 6.1 管理查询

```http
GET /api/admin/notification-logs
```

筛选：

```text
event_type、status、channel、recipient_user_id、date_from、date_to、page
```

返回脱敏内容和错误码，不返回渠道 token 或外部原始错误体。

### 6.2 单条重试

```http
POST /api/admin/notification-logs/:id/retry
```

只允许 `failed` 且业务状态仍有效的记录。重试前：

- 重新检查规则；
- 重新检查接收人和绑定；
- 重新检查事件版本；
- 保留原 dedupe_key；
- 写管理员操作审计。

不能用 retry 发送已 cancelled/suppressed 或已经 sent 的任务。

### 6.3 当前站内通知兼容

现有：

```http
GET /api/notifications
```

第一阶段可以继续保留原响应，避免前端破坏。未来若改为读持久化日志，应通过版本兼容或适配输出，不直接让前端依赖内部队列字段。

## 7. 微信绑定 API

绑定方式必须等普通微信 PoC 确定，以下只是稳定的业务侧最小接口。

### 7.1 管理查询

```http
GET /api/admin/wechat-bindings
```

只返回：

- 系统 user；
- channel；
- 非秘密实例别名；
- 脱敏 external identifier；
- status；
- verified_at；
- adapter health 摘要。

### 7.2 创建/验证

```http
POST /api/admin/wechat-bindings
POST /api/admin/wechat-bindings/:id/verify
PATCH /api/admin/wechat-bindings/:id
```

请求不允许包含：

- 微信密码；
- 二维码；
- bot/puppet/access token；
- 企业微信 secret；
- webhook 完整密钥。

`personal_wechat` 的 identifier 格式在 PoC 前不固定。企业微信 userid 可以由管理员配置并通过适配器发送受控验证消息。

### 7.3 自助绑定

第一阶段不默认开放 member 自助绑定。iLink、RPA 和企业微信的身份确认方式不同，需 PoC 和安全设计后再决定。

## 8. 拜访计划 API

### 8.1 列表和详情

```http
GET /api/visit-plans
GET /api/visit-plans/:id
```

筛选：

```text
date_from、date_to、status、lead_id
```

member 后端强制 `owner_id = request.user.id`，忽略/拒绝扩大 owner 范围的参数；admin 按管理权限。

### 8.2 创建

```http
POST /api/visit-plans
```

请求：

```json
{
  "lead_id": 26,
  "starts_at": "2026-08-01T10:00:00+08:00",
  "address": "杭州市……",
  "note": "携带方案"
}
```

后端重新查询 lead。member 只能为自己负责客户创建，owner_id 从授权上下文确定，不能信任请求正文。

### 8.3 修改、完成、取消

```http
PATCH /api/visit-plans/:id
POST /api/visit-plans/:id/complete
POST /api/visit-plans/:id/cancel
```

PATCH 使用 `expected_revision`：

```json
{
  "starts_at": "2026-08-01T14:00:00+08:00",
  "address": "新地址",
  "expected_revision": 1
}
```

修改增加 revision，并取消旧提醒；完成/取消使全部待发提醒失效。

不把未来计划写成 `follow_ups.type = 拜访`。拜访结束后用户可另行新增真实跟进。

## 9. 确定性报告 API

### 9.1 个人报告

```http
GET /api/reports/daily?date=2026-07-30
GET /api/reports/weekly?week=2026-W31
```

member 永远只返回自己数据。返回 SQL 数字和明细计数：

```json
{
  "scope": "self",
  "date": "2026-07-30",
  "metrics": {
    "follow_up_records": 3,
    "followed_leads": 2,
    "scheduled_overdue": 4,
    "visit_plans": 1,
    "quoted_changes": 1,
    "won_changes": 0,
    "lost_changes": 0
  }
}
```

### 9.2 管理报告

```http
GET /api/admin/reports/daily?date=2026-07-30
GET /api/admin/reports/weekly?week=2026-W31
```

要求 admin，并以数据库实时角色校验。是否展示公司全量以现有管理权限和业务确认为准。

报告数字接口不依赖 AI。AI 文案只是另一个字段或另一个调用结果，失败不能改变 metrics。

## 10. AI API

### 10.1 客户沟通总结

```http
POST /api/ai/leads/:leadId/communication-summary
```

请求：

```json
{
  "focus": "重点整理预算和交付时间"
}
```

`focus` 限长，例如 500 字。前端不能上传完整客户对象、跟进数组或 owner_id。

返回：

```json
{
  "request_id": "uuid",
  "lead_id": 26,
  "result": {
    "needs": ["……"],
    "current_issues": ["……"],
    "next_steps": ["……"]
  },
  "generated_at": "2026-07-30T10:00:00+08:00",
  "disclaimer": "AI辅助内容，请结合实际业务判断"
}
```

### 10.2 跟进建议

```http
POST /api/ai/leads/:leadId/follow-up-advice
```

返回：

- 建议沟通方向；
- 建议提问；
- 建议准备材料；
- 注意事项。

不返回客户等级、价值分或成交概率。

### 10.3 个人日报/周报文案

```http
POST /api/ai/reports/daily
POST /api/ai/reports/weekly
```

请求只含 date/week 和有限关注点。后端先调用确定性统计服务，再把结构化数字交给模型。member scope 固定 self。

### 10.4 管理日报/周报文案

```http
POST /api/admin/ai/reports/daily
POST /api/admin/ai/reports/weekly
```

仅 admin。模型仍不拥有管理 API，不能修改任何业务数据。

### 10.5 历史结果

```http
GET /api/ai/history
GET /api/ai/history/:requestId
```

member 只能查看自己的允许记录，且对应 lead 仍满足数据权限；若负责人后来变化，历史结果是否继续可见需要业务确认，安全默认是不再展示客户正文。

管理员审计使用独立接口：

```http
GET /api/admin/ai-audit
```

只返回脱敏、限权信息。

### 10.6 AI 后端校验顺序

```text
authenticate
→ 以数据库实时用户为准
→ 检查 AI feature permission
→ 限流/配额
→ 查询 lead
→ member owner 校验
→ 后端查询跟进
→ 裁剪和脱敏
→ DeepSeek
→ 受控解析
→ 写 AI 审计
→ 返回
```

模型超时建议 504/受控业务错误；权限拒绝和不存在统一处理；provider 原始错误、key 和响应 header 不返回前端。

## 11. 普通微信入站接口

PoC 未选定前不冻结具体公开路径。推荐最终由独立适配服务调用私有端点，例如：

```http
POST /internal/channels/personal-wechat/events
```

安全要求：

- 内网或 mTLS；
- 服务级签名；
- timestamp + nonce 防重放；
- adapter event_id 幂等；
- payload 大小和类型限制；
- external user 只通过 active binding 映射；
- 不接受适配器传来的 role、owner_id 或客户上下文；
- 只调用受限的微信对话编排服务；
- 不接受或转发任意模型工具调用。

若选择 iLink，context_token 保存在适配服务的受控凭证存储，不进入此 API、业务数据库或普通日志。

## 12. Scheduler 内部契约

第一版不需要开放 HTTP“触发逾期”。scheduler 直接调用后端内部服务或受保护 worker 入口：

```text
scanScheduledFollow(asOfDate)
scanVisitReminders(asOfTime)
buildDailyReports(reportDate)
buildWeeklyReports(week)
```

每次扫描：

- 记录 scan_id；
- 使用固定 as_of；
- 插入唯一 dedupe_key；
- 只生成 pending/suppressed；
- 不直接调渠道；
- 支持 dry-run；
- 支持最大扫描量和超时。

## 13. 通知消息参数

统一消息对象建议：

```ts
type NotificationMessage = {
  title: string
  lines: string[]
  detailUrl?: string
  classification: 'internal'
}
```

负责人变化示例：

```text
客户负责人已变更
客户：某某公司
原负责人：张三
新负责人：李四
当前状态：跟进中
查看详情：https://受控域名/leads/26
```

不得包含完整手机号、微信号、完整沟通记录或 secret。详情 URL 必须进入系统后再做 JWT 和数据权限校验，不能把通知链接当授权。

## 14. 错误码和幂等

建议新增稳定业务码：

| code | 含义 |
| --- | --- |
| `AI_FORBIDDEN` | AI 功能或数据无权 |
| `AI_RATE_LIMITED` | 配额/频率超限 |
| `AI_PROVIDER_TIMEOUT` | 模型超时 |
| `RULE_VERSION_CONFLICT` | 规则乐观锁冲突 |
| `VISIT_VERSION_CONFLICT` | 拜访计划版本冲突 |
| `CHANNEL_BINDING_INVALID` | 绑定失效 |
| `NOTIFICATION_STALE` | 事件已失效，不可重试 |

不要把 provider 堆栈、SQL、环境变量或完整外部错误返回前端。

写接口的 operation_id 可从服务端 request_id 生成。客户端重试批量操作时，后续可支持 `Idempotency-Key` header，但服务端必须限制作用域和保留期。

## 15. 兼容与发布

1. 先保持旧响应字段；
2. 新字段只追加；
3. 新表和 worker 在规则关闭时不改变现有行为；
4. scheduler 先 dry-run；
5. owner_changed 先小范围启用；
6. 普通微信 PoC 适配器与生产 API 隔离；
7. 企业微信降级演练后再放量；
8. AI 单独开关和配额；
9. 回滚时停止 worker/adapter，不删除新表；
10. 对旧客户端做回归。

## 16. 明确删除的旧设计

第一阶段 API 计划不包含：

- `sales_stage` 请求或返回改造；
- 销售阶段专用更新/批量接口；
- 销售阶段通知；
- 客户价值评分接口；
- 公开手动发送逾期接口；
- 前端上传完整客户上下文；
- AI 修改线索、负责人、状态或跟进的接口。
