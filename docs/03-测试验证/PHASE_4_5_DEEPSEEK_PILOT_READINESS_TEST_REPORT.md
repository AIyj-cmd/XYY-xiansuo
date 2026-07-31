# 阶段四点五 DeepSeek Pilot Readiness 测试报告

## 结论

允许进入验收阶段：**是（代码补丁验收）**。

本报告不等同于真实 Provider 联调放行。真实 Key 注入前仍须在隔离的生产数据库副本上执行 dry-run；启动 Worker 前必须立即运行 `pilot:queue-check` 并取得 `SAFE`，且之后不得有其他进程写入通知队列。

未发现未解决的 P1、P2 或 P3。测试期间发现的 P2 已修复并独立复测：两类固定 JSON 示例曾有前导 `+`，导致不是合法 JSON；修复后示例可解析并通过各自 Zod Schema。

## 环境与测试前基线

- 工作目录：`/home/yj/xiansuo`
- 分支：`fix/phase4-deepseek-pilot-readiness`
- 起点提交：`95c95bce3928d73aa0504415b1f9348e5190050d`
- Node：仓库配置的 Node 22 `node:sqlite` / TypeScript 测试环境
- 测试数据库：内存数据库或 `/tmp` 下的临时 SQLite 文件；未连接生产数据库。

开始时工作区已有本补丁实现方的未提交改动，覆盖 Provider、配置、dry-run、队列预检、PM2/环境示例、部署文档及其测试。验证期间未恢复、覆盖或暂存这些改动。

`server/data` 文件 SHA-256 在测试前后完全一致：

| 文件 | SHA-256 |
| --- | --- |
| `app.db` | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `app.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `app.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `leads.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `xiansuo.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## 测试计划与覆盖

1. 复核 Prompt 契约、虚构 JSON 示例、业务数据 `untrusted_business_data` 边界、`item_ref` 和日报 metrics 限制。
2. 以本地 mock `fetch` 验证请求体及 Provider 正常、异常、拒绝和重试分类；不访问外网。
3. 验证 `AI_MAX_OUTPUT_TOKENS` 默认值、闭区间和非法值拒绝。
4. 验证 dry-run 的 SQLite 真只读行为、WAL 拒绝、主文件/sidecar 哈希、大小和 mtime 不变，以及排序证据与 PII 排除。
5. 验证 pilot 队列预检与 Worker 的领取/恢复边界、SAFE/UNSAFE 矩阵、快照/权限/operation 校验和只读性。
6. 回归迁移 001–005、后端全量测试、H5 构建与差异格式检查。

## 已执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npx tsx --test test/phase45-independent-verifier.test.ts` | 5/5 通过（修复前曾 3/4，通过修复后的复测为 5/5） |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 117/117 通过，0 fail / 0 skip |
| `cd app && npm run build:h5` | 通过 |
| `git diff --check` | 通过 |
| `git diff --unified=0 <baseline> -- server/src/db.ts` | 仅只读打开函数新增；迁移 001–005 定义和 checksum 未改 |

没有依赖或锁文件变化，因此未重复运行依赖审计。

## 关键验证结果

- 两类任务分别具有版本化系统 Prompt；固定示例均为虚构、可 `JSON.parse`、并通过严格 Zod Schema。Prompt 明确禁止额外字段、工具、敏感信息、额外数据请求和执行不可信业务数据指令；日报禁止重写 metrics，到期任务限制输入 `item_ref`。
- DeepSeek 请求经 mock 精确验证：`stream=false`、`response_format.type=json_object`、`thinking.type=disabled`、受配置控制的 `max_tokens`；不存在 `tools` 与 `tool_choice`。模型名来自运行时配置，未写死。
- Provider 拒绝缺失 choices/message、null/空白 content、非 JSON、Markdown 包裹、`length`/`content_filter`/`insufficient_system_resource`、`tool_calls`/`function_call`、额外或缺失字段、未知/重复 `item_ref`、敏感输出及超长输出。429、500、503、网络和 timeout 的允许重试规则保持受限；认证、Schema 与敏感输出不放宽。
- `AI_MAX_OUTPUT_TOKENS` 默认 2048，仅接受 256–4096 的整数；空、非整数及越界拒绝。API 和 notification-worker 未导入 AI 配置解析或 DeepSeek Key。
- dry-run 使用 `mode=ro&immutable=1` 的独立打开方式，不调用普通初始化、迁移或 WAL PRAGMA；非空 WAL 被明确拒绝，避免 `immutable=1` 读取未 checkpoint 数据。临时副本中主库、WAL、SHM 的 SHA-256、大小和 mtime 前后一致；INSERT/UPDATE 失败，迁移/AI/通知行数不变，不调用 Provider。输出的排序证据来自候选查询顺序，并排除客户、联系方式、跟进和通知正文。
- dry-run CLI 未提供 `--business-date` 时正确回退到当天业务日期；缺少 `--job` 或 `--user-id` 仍拒绝执行。其配置解析仅读取上下文裁剪参数，不读取 Provider 凭据或 Provider 专用输出上限。
- `pilot:queue-check` 复用 Worker 的领取条件，对 pending、retry_wait、可恢复 sending、available_at、expires_at 与 lease 边界验证。目标任务可得 SAFE；owner_changed、其他接收人/日期/operation、可恢复非 pilot sending、非法快照、停用接收人和上下文失效均得 UNSAFE；未到 available_at 或未到租约恢复时间的任务不误报。输出仅含哈希化数据库路径/operation 标识及聚合统计。
- 迁移空库、重复执行、checksum 冲突、失败回滚、005 原始占位规则保护及 001–005 完整性均由回归测试覆盖；本补丁未修改迁移定义。

## 未覆盖与联调前条件

未执行真实 DeepSeek、真实 Key、真实外部网络、真实通知 Worker、真实微信或生产数据库副本操作；这些均在本轮禁止范围内。没有提供实际隔离生产副本和 pilot 任务，故未产生一次真实库的 `SAFE` 预检结果。

进入真实 Key 联调前的必要条件：

1. 在隔离的、已迁移 005 且通过完整性检查的生产副本执行 dry-run，并保留文件不变证据；
2. 仅向 AI Scheduler 注入 Key，配置单一启用用户；
3. 第二轮生成 outbox 后，立即运行 `pilot:queue-check`；结果必须为 `SAFE`；
4. 预检后停止其他通知写入来源，或在启动 Worker 前重新预检。

## 测试阶段文件变化

测试阶段新增且保留的独立测试：`server/test/phase45-independent-verifier.test.ts`。

本报告为测试阶段新增文件。未修改 `app/src`、`server/src`、`scripts` 或 `deploy` 的业务/部署实现；未修改任何迁移、数据库或锁文件。
