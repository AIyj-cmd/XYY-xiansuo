# OpenClaw 内部通知验收报告

日期：2026-08-01
基线：`feature/openclaw-internal-notifications` / `ab87d3ba450d256e4fa51414a8a8ce5788fc216f` 之后的未提交实现
结论：**自动化与隔离集成验收通过；真实 Pilot 为 CONDITIONAL GO，不得生产部署或扩大灰度。**

## 验收结论

- 迁移 `007` 仅重建 `notification_logs` 的 `channel` CHECK，允许 `NULL`、`mock`、`openclaw`；完整记录、47 列、索引和外键均保留，规则不被启用。`001` 至 `006` 的版本与 checksum 全部保持原值，`007` checksum 为 `c09175e80d010ea056c3e93e5f4fdfc61c4b2f4c08c885d0a6b4e96b1f5242da`。
- 管理端只允许 `owner_changed`、`scheduled_follow_overdue`、`daily_report` 使用恰好一个 `mock` 或 `openclaw` 渠道；preview 与 PUT 使用同一门禁，未实现事件继续拒绝。
- Worker 关闭或 OpenClaw 渠道关闭时不会领取 OpenClaw 任务。OpenClaw 仅接受一个正整数 pilot 用户；服务端 Channel 和 Gateway 各自拒绝其他用户。
- Worker 到 Gateway 使用回环 HTTP、HMAC-SHA256、时间戳、nonce、请求体 hash 和持久防重放。共享 Secret 仅从仓库外精确 `0600` 普通文件读取；API、AI Scheduler、H5 和 Gateway 均不获得不属于自身的 Secret/会话/DeepSeek 配置。
- Gateway 对同键并发只调用一次 Adapter；明确可重试失败可在重启后以相同幂等键重试，最多由 Worker 自动尝试两次。`sent`/`deduplicated` 保留原回执；永久失败与 `result_unknown` 均落为不可重试 `failed`，不换键、不 fallback。
- 三类业务通知使用固定最小化文本与 `https://xs.tomatopia.top/` 登录入口，不含客户名称、联系人、手机号、微信号、需求/跟进正文、AI 输出、JWT、Cookie 或 Key。首次 Pilot CLI 固定为用户批准的单条合成文本，不接受自定义正文或接收人。
- Gateway 没有业务数据库、outbox、DeepSeek 或入站业务接口；Mock、`owner_changed`、AI 审计与 H5 构建回归通过。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `server npm run build` | 通过 |
| `server npm test` | 128/128 通过 |
| Gateway build/test | 34/34 通过，全部 Fake/本地测试 |
| `app npm run build:h5` | 通过；未构建小程序 |
| `git diff --check` | 通过 |
| `server/data` | 前后哈希完全一致 |
| 真实微信 / DeepSeek | 均未调用 |

## 问题分级

- P1：0
- P2：0
- P3：0

独立测试曾发现的永久失败人工重试、Secret 非精确 `0600`、retryable 幂等缓存、Worker 超时覆盖、preview 空渠道五类问题均已修复并独立复验。验收补充核对了 `007` 固定 checksum、完整历史行、规则关闭和重复执行/冲突拒绝，并将首次 Pilot 固定文本校准到用户批准内容。

## Pilot 放行条件

仅当运行手册的前置检查全部满足时，才允许真实 Pilot：专用已登录账号、固定测试接收人、一个 pilot 系统用户、Gateway 单实例、DeepSeek 与 AI Scheduler 关闭。Pilot 完成后必须立即关闭真实开关并停止进程。

当前仍有一项需要操作者确认的**实况编排门禁**：现有 `gateway:send-synthetic` 能严格发送用户批准的固定合成文本，但它不经过 `notification_logs`/Worker；Worker 仅处理三种批准事件，并会发送对应的三种固定业务提醒模板。为了保持“仅一条真实消息”且不新增第四事件、私有入队接口或直接伪造 outbox，不能在一次实况中同时证明“固定合成正文”和“真实 outbox→Worker”。因此：

1. 若本次只批准渠道实况，运行 `gateway:send-synthetic`，最多一条，并用同键验证 Gateway 去重；
2. 若要求真实 outbox→Worker 实况，必须另行批准在隔离库触发三种既有事件之一，并接受其对应的最小化业务模板；
3. 未获得上述选择前，不发送真实消息。

自动化验收通过不等于正式生产批准。真实 Pilot 若出现 `result_unknown`、账号限制、重复发送、非测试接收人收到、业务数据库/DeepSeek 访问或任何客户数据，立即停止并判定不通过。
