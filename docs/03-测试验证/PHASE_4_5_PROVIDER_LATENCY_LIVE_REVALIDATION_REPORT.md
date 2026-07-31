# 阶段四点五 Provider 延迟审计：真实单用户联调重新验证报告

验证日期：2026-07-31
验证角色：`test_verifier`（只读独立复核）
结论：**通过本次单用户受控联调门禁；不得据此扩大灰度、启用日报或接入真实消息渠道。**

## 1. 基线与验证边界

- 分支：`validation/phase4-provider-latency-live-pilot`
- 提交：`8fd1a9f5b1ebf5dbf1492a915aa728b22a37b429`
- 工作区：验证开始时干净；本验证只新增本报告。
- 仅对隔离副本进行只读 SQL 和只读 CLI 复核；报告只记录其路径哈希
  `318d8643f91f673e`，不记录实际路径。
- 未读取、使用、回显或记录任何密钥、JWT、Prompt、上下文、客户数据、AI
  正文、消息正文或上游错误正文。
- 未发起网络或真实 Provider 调用，未启动 API、AI Scheduler 或通知 Worker，
  未修改源码、迁移、隔离副本或生产数据库。

官方接口复核时间：2026-07-31；Base URL：`https://api.deepseek.com`；本次真实
联调使用模型：`deepseek-v4-flash`。真实 DeepSeek 请求已经在受控执行中发生
**1 次**；本验证代理未再发起请求。真实消息渠道调用：**0 次**。

## 2. 数据库副本与迁移门禁

只读复核结果：

- `schema_migrations` 仅含 `001`–`006`，checksum 均与冻结版本一致；其中
  006 为 `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a`。
- `PRAGMA integrity_check` 返回 `ok`；`PRAGMA foreign_key_check` 无结果。
- `scheduled_follow_overdue` 规则已为本次受控联调启用；`daily_report` 仍关闭。
- 本次后态仅有一条 AI 审计记录和一条通知记录；未观察到其他可领取任务。

## 3. dry-run 只读证据

来自主代理受控执行的第二轮、无附加连接 dry-run 原始工具输出摘要：

- 接收人：`2`；范围：`self`；业务日期：`2026-08-01`；时区：
  `Asia/Shanghai`。
- 候选总数、查询数、展示数均为 `5`；排序规则版本
  `phase4.5-v1`；上下文哈希
  `29a43506b292dfa76e5fc7fe68663680ddbb12466f4033e527b75c16190db4a0`；
  上下文字符数 `1709`；三个裁剪计数均为 `0`。
- dry-run 的脱敏声明确认未查询或输出客户 PII、需求/跟进正文、通知正文或
  AI 正文。
- 紧邻运行前后文件指纹完全一致：主库 SHA-256
  `91554fca798f7899bdb29284ee25efbcd578563507dc960148e107f97185d335`，大小
  `245760`，mtime `1785478398`；WAL 为空文件哈希，大小 `0`，mtime
  `1785478411`；SHM SHA-256
  `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`，大小
  `32768`，mtime `1785478455`。

首次含附加只读行数检查的采样改变了 SHM mtime，已明确弃用，未作为本报告
证据。上述第二轮是唯一有效的 dry-run 只读证据。

## 4. Provider、AI 审计与 outbox 后态

隔离副本只读查询确认唯一记录满足：

| 对象 | 已核验安全元数据 |
| --- | --- |
| `ai_request_logs` | `scheduled_follow_overdue`、接收人 `2`、业务日期 `2026-08-01`、`completed`、尝试 `1`、fallback `0`、Provider `deepseek`、模型 `deepseek-v4-flash`、token `1049/241`、`latency_ms=3922`、通知 operation 已关联、临时结果快照已清空 |
| `notification_logs` | `scheduled_follow_overdue`、`ai_scheduler`、接收人 `2`、`sent`、渠道 `mock`、无 lead/actor/new-owner 业务字段 |

Mock receipt 未在报告中写入；其 SHA-256 为
`574ee2c82130c6f8bbaffac76ce57f964e9d480b4412cc12d8853dd57c9a937f`。

主代理已在无 Key 的隔离 API 中复核 admin 安全投影：返回同一
`latency_ms=3922`，且不包含结果快照、Prompt、上下文、密钥或上游错误。

## 5. 队列隔离证据与事后复核

### 5.1 Worker 启动前的有效放行证据

主代理在 Worker 启动前、同一受控命令中连续两次执行原始 queue-check；当时
两次均为 `SAFE`，且无单独持久化运行日志。本报告据其原始工具输出记录以下
脱敏摘要：

- 检查时间：2026-07-31 14:18:15；数据库路径哈希
  `318d8643f91f673e`。
- 接收人 `2`、业务日期 `2026-08-01`、事件
  `scheduled_follow_overdue`。
- 可领取任务 `1`；pilot `1`；非 pilot `0`；按事件和状态均仅为该事件的
  `pending:1`；无 blocker。
- 两次连续预检前后指纹完全一致：主库 SHA-256
  `2d7dc1dfee1194374683e276582f303053861e14b7048883d3dc7cea7570029e`，大小
  `245760`，mtime `1785478612`；WAL 为空文件哈希、大小 `0`、mtime
  `1785478622`；SHM SHA-256
  `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`，大小
  `32768`、mtime `1785478677`。

### 5.2 Worker 完成后的只读重跑

本验证在任务已变为 `sent` 后，按真实 CLI 语义只读重跑 queue-check 两次。两次
均为 `UNSAFE / target_pilot_task_missing`，可领取任务数为 `0`；数据库、WAL、
SHM 指纹保持不变。

这是状态机的预期后态：queue-check 的放行条件要求当前存在可领取目标 pilot
任务。它不能作为新的 SAFE 证据，也不否定 Worker 启动前已经获得的两次 SAFE。

## 6. 本地污染、服务与 Git 检查

- 当前隔离副本后态主库 SHA-256：
  `d85db6347c405e36552f1ca9c9d56d274151a0efcb468a3288917245fc6a328c`；WAL 和
  SHM 分别为既有空文件哈希及
  `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`。
- `server/data` 三个文件保持基线：主库
  `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3`；WAL
  为空文件哈希；SHM
  `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`。
- 进程检查未发现运行中的项目 API、AI Scheduler 或通知 Worker。
- 验证开始时 Git 工作区干净；未发现 Git 跟踪的密钥、数据库副本或环境文件
  差异。验证后仅本报告待提交。

## 7. 问题分级与准入结论

- P1：0
- P2：0
- P3：0

`latency_ms=3922` 已由新生成的真实 Provider 任务持久化并可由 admin 安全投影
审计；没有对迁移 005 之前的历史记录伪造回填。单用户到期提醒的
DeepSeek → outbox → 两次前置 SAFE → Mock Worker 链路满足本次受控联调门禁。

仍然禁止：扩大 allowlist、真实日报、真实微信/企业微信、生产数据库操作和
生产部署。后续任何新的 Worker 启动前都必须重新运行实时 queue-check；已发送
任务的事后 UNSAFE 不能被当作放行证据。
