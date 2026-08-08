# 阶段四点五 DeepSeek Pilot Readiness 最终验收报告

日期：2026-07-31
分支：`fix/phase4-deepseek-pilot-readiness`
基线：`95c95bce3928d73aa0504415b1f9348e5190050d`
结论：**安全补丁验收通过；这不等同于真实 Provider 联调通过。**

## 1. 验收边界

本次只验收真实 DeepSeek 联调前门禁：Provider JSON 契约、输出 token 与非思考
请求、只读 dry-run 和 pilot Worker 队列预检。未注入真实 Key，未调用真实
DeepSeek 或其他外网，未启动通知 Worker，未操作生产数据库，未修改 H5、
阶段四任务范围、周报、微信渠道或迁移 `001` 至 `005`。

验收依据为用户批准的阶段四点五补丁要求、阶段四冻结设计、实际代码差异、
实施报告和独立测试报告。

## 2. Provider 契约验收

- `scheduled_follow_overdue` 与 `daily_report` 使用各自固定、版本化的系统
  Prompt；虚构 JSON 示例可解析并通过对应严格 Zod Schema。
- Prompt 禁止解释、Markdown、额外字段、额外客户、数据内指令、额外数据、
  SQL、工具、业务写入和敏感信息。业务数据只在独立
  `untrusted_business_data` 用户消息 JSON 边界中传入。
- 到期提醒只接受输入中的唯一 `item_ref`；日报输出不含 `metrics`，最终
  metrics 仍由后端确定性组合。
- 请求体固定包含 `stream=false`、
  `response_format.type=json_object`、`thinking.type=disabled` 和严格配置的
  `max_tokens`；不存在 `tools` 或 `tool_choice`。
- `AI_MAX_OUTPUT_TOKENS` 默认 2048，只接受 256–4096 的整数，由 Scheduler
  AI 配置解析；API、通知 Worker、H5 和 dry-run 均不需要解析该 Provider-only
  配置。
- choices/message 缺失、null/空白 content、非 JSON、Markdown 包裹、截断、
  内容过滤、资源不足、tool/function call、Schema 错误、未知/重复 ref、
  超长或敏感输出均被安全拒绝。Schema/敏感输出不重试；原有临时错误重试
  白名单未放宽。上游原始正文、Prompt、上下文和 Authorization 不写日志。

## 3. dry-run 验收

- 使用独立 SQLite `mode=ro&immutable=1` 与 read-only flag；不复用普通连接
  初始化，不执行迁移或 `PRAGMA journal_mode=WAL`。
- 检测到非空 WAL 时立即拒绝，避免 immutable 连接读取未 checkpoint 的过时
  主文件；稳定副本运行前后主库、WAL、SHM 的 SHA-256、大小和 mtime 不变。
- 自动化验证 INSERT、UPDATE 均失败；表数量、`schema_migrations` 内容、
  `ai_request_logs` 和 `notification_logs` 行数完全不变；不调用 Provider，
  不创建 AI 或通知任务。
- CLI 缺省 `--business-date` 时使用当天上海业务日期；显式提供该参数但遗漏
  值、缺少 job 或缺少 user ID 时拒绝执行，避免核验错误业务日。
- 排序证据直接按候选 SQL 返回顺序生成，包含 rank、`item_ref`、内部 lead
  ID、到期时间、意向、最近跟进时间和排序规则；同时输出完整候选数、查询/
  展示数、业务日期、时区、接收人、scope、context hash 和裁剪统计。
- 输出不包含客户/联系人名称、手机号、微信号、需求全文、跟进正文、通知或
  AI 结果正文。

## 4. pilot 队列预检验收

- `pilot:queue-check` 与 Worker 共用可领取 SQL 条件，覆盖当前可领取的
  pending、retry_wait 和可恢复 sending，并准确应用 available、expiry 和
  lease 边界；预检本身只读，不运行队列维护、不改变任务状态、不启动 Worker。
- 只有所有当前可领取任务都属于指定 AI event、recipient、business date 和
  稳定 operation，且快照 Schema、接收人及实时上下文校验通过时才返回
  `SAFE`/退出码 0。
- owner_changed、其他用户/日期/operation、可领取 retry、可恢复非 pilot
  sending、非法快照、停用接收人或上下文失效均返回 `UNSAFE`。尚未到
  available/lease 的任务不误报；已过 TTL 且 Worker 不会发送的任务不计入
  当前可领取集合。
- 验收发现并修复一个 P2：原 CLI 暴露测试用 `--as-of`，可能用历史时点缩小
  可领取集合。现在 CLI 只能使用与 Worker 同源的实时上海时间；测试核心仍可
  通过显式函数参数构造确定性边界。
- 输出只含数据库路径 hash、检查时间、聚合计数、脱敏 operation hash、
  recipient、business date、阻断原因和 SAFE/UNSAFE，不含消息正文或业务
  敏感数据。

自动化 SAFE/UNSAFE 矩阵通过，但本轮没有隔离生产副本和真实 pilot outbox，
因此**没有生成实际联调环境的 SAFE 结论**。

## 5. 变更与兼容性

- 迁移 `001` 至 `005` 内容和 checksum 未改，锁文件和生产依赖未变。
- H5 业务代码未改；没有普通用户 AI API、周报、真实消息渠道或生产 Worker
  语义变更。
- Worker 仍处理统一队列；补丁仅抽取其可领取谓词供只读预检复用。
- `owner_changed` 行为由完整后端回归覆盖，未发现回归。

## 6. 最终验证

| 检查 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 通过；阶段四原 97 项 + 本补丁 20 项 = 117/117，0 fail、0 skip |
| `cd app && npm run build:h5` | 通过 |
| `git diff --check` | 通过 |
| `server/data` SHA-256 | 验收前后完全一致 |
| 真实 DeepSeek / 外网 | 0 次 |
| 未解决 P1 / P2 / P3 | 0 / 0 / 0 |

## 7. 准入建议与残余门禁

**允许进入受控真实 Key 联调准备，不允许直接启用生产 Provider 或生产任务。**

真实 Key 注入前仍必须：

1. 使用已迁移 `005`、完成 integrity/foreign-key/恢复核验且停止其他写入的
   隔离生产数据库副本；
2. 在该副本执行 dry-run，并保留主库/WAL/SHM 零变化及排序证据；
3. 重新核验联调当天官方 endpoint、模型、JSON 参数、响应、错误码和价格；
4. Key 仅注入 AI Scheduler，核对 API、Worker、H5、仓库、数据库和日志均无
   Key；
5. allowlist 只放一名启用 member，先只启用到期提醒；
6. 第二轮保持 Worker 关闭，确认 Provider、AI 日志和 outbox；
7. 第三轮启动 Mock Worker 前立即执行 `pilot:queue-check`，结果必须为
   `SAFE`；预检后任何队列写入都会使结论失效，必须再次检查。

回滚方式为关闭阶段四任务及 Provider 开关、停止 Scheduler，并按阶段四回滚
方案隔离未终态 AI outbox；补丁没有数据库变更，不需要 down migration。
