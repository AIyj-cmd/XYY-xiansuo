# OpenClaw 内部通知验收报告

日期：2026-08-01
基线：`feature/openclaw-internal-notifications` / `6e4a1e6823fcc339b17f9cff4a1d509f2b39c706` 之后的一次性 synthetic 隔离增量
结论：**自动化与隔离集成验收通过；允许按运行手册进入一次受控真实 Pilot（CONDITIONAL GO），不得生产部署或扩大灰度。**

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
| `server npm test` | 137/137 通过（含 sealed-state、终态污染与元数据篡改回归） |
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

仅当运行手册的前置检查全部满足时，才允许执行一次真实 Pilot：专用已登录账号、固定测试接收人、一个 pilot 系统用户、全新的 `/tmp` 隔离库、Gateway/Worker 单实例、DeepSeek 与 AI Scheduler 关闭。Pilot 完成后必须立即关闭真实开关并停止进程。

用户已批准仅限隔离临时库的一次性 synthetic 入队扩展。它不增加第四事件或 schema：严格 envelope 仍是 `daily_report`，仅以受限 `event_source`/operation 区分。只有 `openclaw:enqueue-synthetic-pilot` 成功创建的唯一任务才可让 Worker 使用固定测试正文；空/非新库、仓库内路径、任何第二用户/第二任务及非匹配快照均拒绝。受控实况前必须连续两次运行带同键的 `pilot:queue-check` 并得到 SAFE；任何其他可领取任务继续为 UNSAFE。

自动化验收通过不等于正式生产批准。真实 Pilot 若出现 `result_unknown`、账号限制、重复发送、非测试接收人收到、业务数据库/DeepSeek 访问或任何客户数据，立即停止并判定不通过。

P1 修复以共享的阶段化 sealed-state 校验取代原先的部分 envelope 校验：真实临时路径、权限/链接、`integrity_check`、`foreign_key_check`、迁移 checksum、业务表零记录、规则默认值和任务完整状态必须在创建、重复、queue-check 及 Worker 发送前全部成立。test_verifier 已独立复验 realpath、链接/权限、污染表/规则/任务、两次 SAFE 和污染批次零 Gateway 调用。

最终验收另行复现并修复一项 P1：retention cleanup 原先先于 sealed 门禁，可能删除已到保留期的终态污染证据。现在门禁先于任何队列维护；新增回归证明额外终态行仍保留且 Gateway 调用为 0。验收同时补齐任务 `lease_recovery_count`、`management_audit_json`、`row_version`、尝试/发送/保留时间的严格封存。修复后 Server 137/137、Gateway 34/34、H5 build 与数据哈希复核均通过。

本结论仅放行“一条固定合成消息”的受控实况步骤，不代表渠道生产批准；实况尚未执行，也未发生微信登录、消息发送或 DeepSeek 调用。
