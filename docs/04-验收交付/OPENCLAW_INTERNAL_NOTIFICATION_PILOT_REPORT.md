# OpenClaw 内部通知 Pilot 报告

日期：2026-08-01
基线：`feature/openclaw-internal-notifications` / `6ff67fb7b24c34029371b32734777395bed54e46`
状态：**实况 Pilot 未通过（NO-GO）；已按停止条件关闭全部相关进程，不得重试或扩大。**

## 1. 实况边界与前置门禁

本次使用全新的仓库外 `/tmp` 隔离目录、一个 synthetic 用户和一条固定合成通知；未连接生产数据库、`server/data`、真实业务 outbox 或 DeepSeek。OpenClaw 为 `2026.7.1-2`，官方插件为 `2.4.6`，prereq-check 为 `READY`。

在临时 loopback/no-auth 配置下，官方 session 明确为 `authenticated`，Gateway health 为 `healthy/authenticated`。该临时配置、会话副本、Secret、日志和状态均仅存在于本次隔离目录，未写入仓库或报告。

## 2. 入队与队列证明

synthetic CLI 创建了唯一任务：

| 项目 | 结果 |
| --- | --- |
| task ID | 1 |
| 事件 | `daily_report` / `openclaw_synthetic_pilot` |
| pilot user | 1 |
| business date | `2026-08-01` |
| 隔离 DB 哈希标识 | `15e433…` |
| 初始任务状态 | 唯一 `pending` |
| queue-check | 连续两次 `SAFE` |
| queue-check 前后哈希 | 完全不变 |

固定消息不含客户名称、联系人、手机号、微信号、需求、跟进、Prompt、JWT、Key 或真实业务数据。

## 3. 唯一发送尝试

仅启动一个 notification-worker，并只允许第一次尝试。结果如下：

| 证据层 | 结果 |
| --- | --- |
| 业务隔离 DB | `retry_wait` |
| `attempt_count` | 1 |
| `automatic_attempt_count` | 1 |
| Worker 错误码 | `OPENCLAW_GATEWAY_TIMEOUT` |
| Worker receipt | 无 |
| Gateway 持久 delivery | `result_unknown` |
| Gateway 错误码 | `ILINK_SEND_RESULT_UNKNOWN` |
| Gateway receipt | 无 |
| 系统确认发送成功数 | **0** |
| 微信端实际投递数 | **可能为 0 或 1，无法确认** |

Gateway 的终态说明请求可能已提交，但没有取得可解释的最终响应。不得把无回执解释为“明确未发送”，也不得把接口调用解释为“已经发送”。本次没有进行第二次 Worker 尝试，没有以同一或不同幂等键重跑，也没有执行真实 `deduplicated` 验证。

## 4. 停止、数据检查与清理

命中用户批准的 `result_unknown` 停止条件后，立即停止 notification-worker、Gateway 和 OpenClaw。未继续等待 `retry_wait`，未人工修改任务，未尝试补发或查询业务数据。

- 本地端口 `18789` 与 `38115` 均已关闭。
- 清理前隔离库：`integrity_check=ok`、`foreign_key_check=0`。
- 行数：users=1、leads=0、follow_ups=0、audit_logs=0、notification_logs=1、ai_request_logs=0。
- 隐私扫描未发现批准范围外内容。
- 随后精确删除本次整个 `/tmp` 运行目录，包括隔离 DB、Secret、临时配置、日志和 Gateway/OpenClaw 状态。
- `server/data` 未被打开或修改；实况前 Git 工作区干净。
- 未发生 DeepSeek 调用、客户业务操作、第二接收人发送或生产部署。

## 5. 结论与问题分级

| 分级 | 数量 | 说明 |
| --- | ---: | --- |
| P1 | 1 | 唯一真实发送结果为 `result_unknown`；微信端可能收到 0 或 1 条，存在无法安全自动重试的重复风险 |
| P2 | 0 | 无 |
| P3 | 0 | 无 |

结论：**Pilot 未通过。** 自动化的 HMAC、防重放、幂等、sealed DB、队列预检、Gateway 37/37、Server 137/137 和 H5 构建验收事实继续有效，但不能替代真实投递回执。

当前禁止：

- 第二次自动或人工发送；
- 使用相同或新幂等键重试；
- 补做真实 deduplicated 验证；
- 扩大 pilot 用户、接收人或事件；
- 启用 AI 日报或生产规则；
- 将本次结果写成成功、sent 或微信端明确未收到。

只有另行完成 `OPENCLAW_GATEWAY_TIMEOUT / ILINK_SEND_RESULT_UNKNOWN` 根因审计、获得新的用户批准并使用新的隔离环境后，才可讨论新的实况验证。本报告不授权该后续动作。
