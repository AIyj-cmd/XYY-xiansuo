# XYY-xiansuo 数据库变更计划

> **后续决策覆盖说明（2026-08-01）：** 用户决定取消企业微信自建应用并暂停所有真实外部消息渠道；OpenClaw daemon 与 Direct iLink 为 No-Go，Hook/RPA/逆向/Windows 自动化继续禁止。本文中普通微信、企业微信、降级/fallback、PoC、Gateway 和相关迁移的设计/计划均不是当前计划，只保留为历史方案。现行正式通知仅为 H5 站内通知，Mock 仅用于测试/灰度；阶段三 outbox、通知规则、租约、重试、TTL、审计及阶段四 DeepSeek 调度、`scheduled_follow_overdue`、`daily_report`、AI 审计和模板降级保留，但不向真实外部渠道发送。迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 暂缓，不进入实现，不补发。只有官方普通微信提供独立 client/session 且支持主动通知，或用户批准公众号/服务号/其他合法官方渠道后，才可重新审计。

> 文档性质：迁移与表结构建议
> 修订日期：2026-07-30
> 当前阶段不执行任何 SQL 或数据库迁移

## 1. 当前数据库事实

### 1.1 代码与物理库不是同一状态

当前工作区 `server/src/db.ts` 声明：

```text
users、leads、follow_ups、tags、lead_tags、memos、audit_logs、favorites
```

本地 `server/data/app.db` 实际只有：

```text
users、leads、follow_ups、tags、lead_tags、audit_logs
```

物理库还存在以下旧约束：

- `leads.phone` 为 NOT NULL；
- status CHECK 没有“停止跟进”；
- `follow_ups` 的 images、amount 是后续 ALTER 加入；
- 当前只读外键检查未返回孤儿行，但新建 `sqlite3` 连接的 `foreign_keys` 默认是 0。

设计不能把代码 DDL 等同于所有已部署数据库。

### 1.2 数据库路径分层

| 层级 | 实际情况 |
| --- | --- |
| 当前已提交版本 | 固定 `server/data/app.db` |
| 当前未提交工作区 | 支持 `DB_PATH`，默认仍为 `server/data/app.db` |
| 生产 | 未核验 |

支持 `DB_PATH` 是建议采用的基线，但必须评审、提交、部署并验证后，才能写成线上事实。

### 1.3 外键分层

当前未提交工作区在应用连接创建时执行：

```sql
PRAGMA foreign_keys = ON;
```

已提交版本只在重建 leads 表的迁移片段中临时开关外键，没有对连接无条件开启。后续必须：

1. 每个连接建立时开启；
2. 启动时读取并断言 `PRAGMA foreign_keys = 1`；
3. 自动化测试验证非法外键写入失败；
4. 每次迁移后运行 `PRAGMA foreign_key_check`；
5. 遇到异常时阻止发布或进入明确的人工处置流程。

## 2. 变更范围

### 2.1 第一阶段建议新增/评估

| 对象 | 建议 | 作用 |
| --- | --- | --- |
| `schema_migrations` | 必需 | 版本化迁移 |
| `notification_rules` | 必需 | 通知规则 |
| `notification_logs` | 必需 | 持久化队列、幂等和投递日志 |
| `wechat_bindings` | 通过 PoC 后启用 | 多渠道用户绑定 |
| `visit_plans` | 拜访阶段必需 | 未来拜访计划 |
| `ai_analysis_logs` | AI 阶段必需 | 脱敏 AI 审计 |
| `ai_permissions` | 视启用策略决定 | 按用户控制 AI 功能 |

### 2.2 第一阶段明确不增加

- `leads.sales_stage`；
- `leads.sales_stage_updated_at`；
- 销售阶段索引、CHECK 和回填；
- `users.supervisor_id`；
- 客户价值分、成交概率、AI 等级字段；
- 微信密码、二维码、token 或任何 secret 字段。

独立销售阶段和主管层级都是后续业务确认后的可选优化，不是通知/AI 前置。

普通新增线索不通知，因此数据库事件白名单中不设计 `lead_created`；普通编辑、标签、收藏和备忘变化同样不进入通知队列。

## 3. 迁移机制

### 3.1 `schema_migrations`

建议最小结构：

```sql
CREATE TABLE schema_migrations (
  version       TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

迁移文件不可在启动时用“看列是否存在就继续 ALTER”的方式无限累积。每个版本需要：

- 唯一版本号；
- 固定校验和；
- 事务边界说明；
- 备份和回滚策略；
- 前置 schema 断言；
- 迁移后 schema 断言；
- `foreign_key_check`；
- 数据量和耗时记录。

SQLite 的表重建迁移需要单独演练。关闭外键的操作只允许出现在受控迁移连接中，并确认不在活动事务里错误执行。

## 4. `notification_rules`

### 4.1 用途

保存管理员配置的事件开关、接收策略、渠道顺序和时间参数。

### 4.2 建议结构

```sql
CREATE TABLE notification_rules (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type            TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 0
                        CHECK (enabled IN (0,1)),
  recipient_strategy    TEXT NOT NULL,
  channel_order_json    TEXT NOT NULL DEFAULT '[]',
  config_json           TEXT NOT NULL DEFAULT '{}',
  version               INTEGER NOT NULL DEFAULT 1,
  updated_by            INTEGER NOT NULL REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (event_type IN (
    'owner_changed',
    'scheduled_follow_overdue',
    'inactive_lead',
    'visit_reminder',
    'status_changed',
    'daily_report',
    'weekly_report'
  )),
  UNIQUE (event_type)
);
```

如果同一事件未来需要多条规则，可在验证需求后把唯一约束扩展为 `(event_type, rule_key)`，第一版不提前复杂化。

### 4.3 JSON 约束

SQLite 无法完整验证业务 JSON，应用层必须按 event_type 使用版本化 Zod schema。

示例：

```json
{
  "schema_version": 1,
  "levels": [
    {"key": "due_today", "days": 0, "send_at": "09:00", "recipient": "owner"},
    {"key": "overdue_2d", "days": 2, "send_at": "09:00", "recipient": "configured_admins"}
  ],
  "configured_admin_user_ids": [1],
  "include_paused": false
}
```

规则中只能存系统用户 ID、非秘密渠道顺序和业务参数。不能存 webhook URL、企业微信 secret 或机器人 token。

### 4.4 默认值

| 事件 | 初始建议 |
| --- | --- |
| owner_changed | 试点开启 |
| scheduled_follow_overdue | 完成派生日期修复后再开启 |
| inactive_lead | 关闭 |
| visit_reminder | 拜访计划上线时开启 |
| status_changed | 只开少量经确认状态 |
| daily_report | 试点用户开启 |
| weekly_report | 日报稳定后开启 |

## 5. `notification_logs`

### 5.1 用途

同一张表承担：

- 事务性 outbox；
- 定时事件幂等；
- 渠道排队和重试；
- 投递审计；
- 取消和抑制记录。

当前规模下无需先引入 Redis、Kafka 或 RabbitMQ。

### 5.2 建议结构

```sql
CREATE TABLE notification_logs (
  id                    TEXT PRIMARY KEY,
  event_type            TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  subject_type          TEXT NOT NULL,
  subject_id            INTEGER,
  lead_id               INTEGER REFERENCES leads(id),
  recipient_user_id     INTEGER REFERENCES users(id),
  binding_id            INTEGER,
  channel               TEXT,
  level_key             TEXT,
  dedupe_key            TEXT NOT NULL UNIQUE,
  subject_version       TEXT,
  message_text          TEXT NOT NULL,
  payload_json          TEXT NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'pending',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  available_at          TEXT NOT NULL,
  lease_until           TEXT,
  provider_message_id   TEXT,
  last_error_code       TEXT,
  occurred_at           TEXT NOT NULL,
  sent_at               TEXT,
  cancelled_at          TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (event_type IN (
    'owner_changed',
    'scheduled_follow_overdue',
    'inactive_lead',
    'visit_reminder',
    'status_changed',
    'daily_report',
    'weekly_report'
  )),
  CHECK (channel IS NULL OR channel IN (
    'personal_wechat',
    'wecom_app',
    'wecom_webhook'
  )),
  CHECK (status IN (
    'pending',
    'sending',
    'retry_wait',
    'sent',
    'failed',
    'cancelled',
    'suppressed'
  ))
);
```

`binding_id` 的外键在创建 `wechat_bindings` 后补齐，或调整迁移顺序使其一开始即可引用。

### 5.3 索引

```sql
CREATE INDEX idx_notification_dispatch
ON notification_logs(status, available_at, lease_until);

CREATE INDEX idx_notification_recipient
ON notification_logs(recipient_user_id, created_at);

CREATE INDEX idx_notification_event
ON notification_logs(event_type, occurred_at);

CREATE INDEX idx_notification_lead
ON notification_logs(lead_id, created_at);
```

### 5.4 幂等键

| 事件 | 建议组成 |
| --- | --- |
| owner_changed | operation_id + lead_id + new_owner_id |
| scheduled_follow_overdue | lead_id + due_date + level + recipient |
| inactive_lead | lead_id + threshold + date bucket + recipient |
| visit_reminder | visit_plan_id + revision + reminder level + recipient |
| status_changed | operation_id + lead_id + new_status + recipient |
| daily_report | report_date + scope + user/recipient |
| weekly_report | ISO week + scope + user/recipient |

同一业务事件切换渠道不应创建第二个业务幂等键。可以在原记录上更新 channel/attempt，或在以后确有逐渠道审计需求时增加子表；第一版优先保持简单。

### 5.5 内容最小化

`message_text` 和 `payload_json` 只保存投递所需内容：

- 客户显示名；
- 用户显示名；
- status；
- 日期/时间；
- 系统详情相对路径或受控 URL；
- 报告确定性数字。

默认不保存手机号、微信号、完整跟进、密码、token 或 secret。`last_error_code` 只存脱敏分类，不存外部服务完整响应。

### 5.6 失效

以下变化要把未发送记录更新为 cancelled：

- 负责人已经再次变化；
- `next_follow_at` 被清空或修改；
- 产生了有效新跟进；
- 客户进入结束状态；
- 拜访计划 revision 变化、取消或完成；
- 规则被关闭且配置要求取消待发任务；
- 绑定失效且没有降级渠道。

worker 发送前必须二次检查 `subject_version` 或当前业务状态，不能只信旧快照。

## 6. `wechat_bindings`

### 6.1 设计原则

不能复用含义不清的 `users.wx_openid`。普通微信 iLink、个人微信 RPA、企业微信 userid 和群 webhook 的标识并不相同。

### 6.2 建议结构

```sql
CREATE TABLE wechat_bindings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  channel               TEXT NOT NULL,
  channel_instance_key  TEXT NOT NULL,
  external_user_id      TEXT NOT NULL,
  display_label         TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  metadata_json         TEXT NOT NULL DEFAULT '{}',
  verified_at           TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (channel IN (
    'personal_wechat',
    'wecom_app',
    'wecom_webhook'
  )),
  CHECK (status IN ('pending','active','disabled','invalid')),
  UNIQUE (channel, channel_instance_key, external_user_id)
);
```

普通微信的 `external_user_id` 和 `channel_instance_key` 具体含义必须由 PoC 后确定：

- iLink 可能是 bot account + peer identifier；
- Windows RPA 可能只能稳定使用备注名或客户端内部 ID；
- 两者不能提前共用同一种语义。

应用层还要限制同一用户、同一 channel instance 只能有一个 active 绑定。

### 6.3 禁止保存

`wechat_bindings` 和其他业务表都不能保存：

- 登录二维码或其图片；
- 微信密码；
- iLink bot token、context_token；
- puppet token；
- 企业微信 corp secret；
- webhook 完整 URL/密钥；
- access token；
- DeepSeek API Key。

这些只能放在适配器环境变量、受控凭证文件或独立 secret 管理中。若适配器需要持久化 session，必须独立加密存储，不进入主业务数据库。

## 7. `visit_plans`

### 7.1 建议结构

```sql
CREATE TABLE visit_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL REFERENCES leads(id),
  owner_id        INTEGER NOT NULL REFERENCES users(id),
  starts_at       TEXT NOT NULL,
  address         TEXT NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'planned',
  revision        INTEGER NOT NULL DEFAULT 1,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  completed_at    TEXT,
  cancelled_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (status IN ('planned','completed','cancelled'))
);

CREATE INDEX idx_visit_owner_time
ON visit_plans(owner_id, status, starts_at);

CREATE INDEX idx_visit_lead
ON visit_plans(lead_id, starts_at);
```

`starts_at` 使用明确的本地时间存储规范或 UTC ISO 8601，开发前必须统一。当前系统以 Asia/Shanghai 业务时间展示，建议数据库存 UTC 并在边界转换；若继续本地时间，必须把时区写入系统约定并禁止混用。

### 7.2 更新规则

- 修改时间、地址、负责人或备注时 `revision + 1`；
- completed/cancelled 不再产生提醒；
- 恢复 cancelled 是否允许需业务确认；
- 完成拜访时可由用户另写历史 follow_up，但不能自动生成虚假跟进；
- 删除建议不用物理 DELETE，使用 cancelled 保留审计。

## 8. `ai_analysis_logs`

### 8.1 建议结构

```sql
CREATE TABLE ai_analysis_logs (
  request_id          TEXT PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  feature_type        TEXT NOT NULL,
  lead_id             INTEGER REFERENCES leads(id),
  scope_json          TEXT NOT NULL DEFAULT '{}',
  input_summary       TEXT,
  response_text       TEXT,
  model               TEXT NOT NULL,
  status              TEXT NOT NULL,
  latency_ms          INTEGER,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  error_code          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at          TEXT NOT NULL,
  CHECK (feature_type IN (
    'customer_communication_summary',
    'follow_up_advice',
    'daily_report_narrative',
    'weekly_report_narrative'
  )),
  CHECK (status IN ('success','failed','rejected','timeout'))
);

CREATE INDEX idx_ai_user_time
ON ai_analysis_logs(user_id, created_at);

CREATE INDEX idx_ai_lead_time
ON ai_analysis_logs(lead_id, created_at);

CREATE INDEX idx_ai_expiry
ON ai_analysis_logs(expires_at);
```

### 8.2 敏感数据控制

- `scope_json` 记录后端实际使用的 ID 范围或计数，不保存整份客户资料；
- `input_summary` 先脱敏、再截断；
- `response_text` 有长度上限、权限和保留期；
- 手机号、微信号、密码、哈希、token、key 使用统一脱敏器；
- provider 原始错误体不落库；
- 定时删除 `expires_at < now` 的日志；
- 删除任务也要写管理员审计，但不把已删除原文复制到新日志。

## 9. `ai_permissions`

如果第一阶段需要按用户逐步放量，建议：

```sql
CREATE TABLE ai_permissions (
  user_id          INTEGER NOT NULL REFERENCES users(id),
  feature_type     TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  daily_limit      INTEGER,
  updated_by       INTEGER NOT NULL REFERENCES users(id),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, feature_type)
);
```

如果所有 member 同时启用相同能力，可先用服务端配置加固定角色策略，不必强制建表。无论是否建表，数据权限都要再次校验，AI 功能开关不能替代 owner 校验。

## 10. `users.supervisor_id` 的评估

当前角色只有 admin/member，公司是否有正式主管层级尚未确认。第一阶段推荐：

- 在 `notification_rules.config_json` 中配置升级接收的管理员 user_id；
- 校验接收人存在、启用且为 admin；
- 不因逾期层级强制引入组织关系。

只有业务确认稳定的“业务员对应主管”且其他业务也要使用该关系后，再设计：

- supervisor 外键；
- 防自引用和循环；
- 主管停用后的接替；
- 历史关系审计；
- 主管是否产生额外数据权限。

## 11. 现有表需要的基线修复

### 11.1 批量负责人转移

当前批量 transfer 没有逐条 audit。数据库层面不一定需要新字段，但实现必须为每条真实变化：

- 读取 old_owner_id；
- 生成 operation_id；
- 写 audit_logs transfer；
- 写 notification_logs 或 suppressed；
- 同事务提交。

可以给 `audit_logs` 后续增加 `operation_id` 和 `source`，用于关联批次和入口；是否加列在实现设计时根据审计查询需求确认。通知不能依赖事后扫描 audit_logs。

### 11.2 跟进派生字段

必须先定义权威算法：

- `last_follow_at` = 最新有效跟进的 created_at；
- `next_follow_at` = 当前有效待办日期；
- 编辑最新跟进的日期后同步主表；
- 删除最新跟进后重算；
- 没有跟进时，是否恢复手工日期。

最后一项当前无法仅靠既有字段可靠判断。建议开发前选定：

- 简单方案：没有剩余跟进时清空 `last_follow_at`，`next_follow_at` 保留/清空按明确业务规则；
- 更完整方案：为手工计划和跟进产生的计划区分来源。

第一版不要在通知 scheduler 中自行猜测来源。

### 11.3 创建时 owner 校验

无论业务选择 A 或 B，都要数据库外键开启并在应用层校验目标用户 `is_active=1`。外键只能保证 ID 存在，不能保证角色和启用状态。

### 11.4 跟进类型

前后端枚举统一前，不新增数据库“邮件”值，也不在 AI/通知表中保存另一个平行枚举。若业务确认需要邮件，再用正式迁移更新 CHECK 和所有端校验。

## 12. 安全基线与默认管理员

当前已提交版本在空数据库自动创建：

```text
admin / xyy123456
```

这是开发前安全阻塞项。当前未提交工作区已经改为：

- `ADMIN_INITIAL_PASSWORD` 至少 12 位；或
- 随机生成一次性密码；
- 随机密码只输出一次。

正式方案还应：

- 生产禁止固定默认密码；
- 首次登录强制修改；
- 不在长期日志重复输出；
- 部署检查确认默认密码已更换；
- 管理员密码和哈希绝不进入 AI、通知或审计正文。

## 13. 推荐迁移顺序

以下仅是未来计划，本阶段不执行：

1. 确认生产实际 commit、DB_PATH 和数据库文件；
2. 停写窗口或维护窗口；
3. 完整备份数据库和上传文件，并验证可恢复；
4. 运行 schema/data preflight；
5. 引入 `schema_migrations`；
6. 对齐现有 leads 物理约束与当前代码；
7. 验证所有连接 foreign_keys=1；
8. 修复/验证跟进派生时间和批量转移审计；
9. 创建 `notification_rules`、`wechat_bindings`、`notification_logs`；
10. 创建 `visit_plans`；
11. AI 阶段创建 `ai_analysis_logs`，按需要创建 `ai_permissions`；
12. 创建索引；
13. 执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`；
14. 运行兼容回归；
15. 先 dry-run，不发送外部消息；
16. 小范围放量。

## 14. 回滚

- 业务表迁移前保留可验证备份；
- 新表在旧代码中无引用，因此应用回滚应保持可读，不急于删表；
- 若新 worker 异常，先停 worker 和规则，不回滚业务数据；
- 若普通微信适配器异常，禁用 channel 并切企业微信/站内；
- 迁移失败优先恢复完整备份，不使用手工删列；
- 回滚后再次执行 integrity_check 和 foreign_key_check。

## 15. 后续可选优化

以下不属于第一阶段：

- 经业务确认后的独立销售阶段体系；
- 主管组织关系；
- 独立 notification_delivery_attempts 子表；
- 多租户；
- PostgreSQL/外部消息队列；
- 复杂团队/部门 RBAC；
- AI 任何写操作。
