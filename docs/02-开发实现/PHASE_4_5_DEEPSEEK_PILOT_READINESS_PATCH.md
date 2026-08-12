# 阶段四点五 DeepSeek Pilot Readiness 安全补丁

## 范围

本补丁只为真实 Provider 联调前建立受控门禁；未注入真实 Key、未调用
DeepSeek、未启动通知 Worker、未操作生产数据库，也未修改迁移 `001` 至 `005`。

## 实现内容

- `scheduled_follow_overdue` 和 `daily_report` 各自拥有版本化系统 Prompt、严格字段限制和虚构 JSON 示例。业务数据只通过 `untrusted_business_data` 用户消息边界传入。
- DeepSeek 请求固定为非流式 JSON Output，显式关闭思考模式，禁止 tools/tool_choice，并由 Scheduler 独占解析 `AI_MAX_OUTPUT_TOKENS`（默认 2048、范围 256–4096）。
- Provider 拒绝空内容、截断/过滤/资源不足 finish reason、工具调用、Markdown 包裹、非法 Schema 和敏感输出；上游原文不记录也不返回 API。
- `ai:dry-run` 改用 `mode=ro&immutable=1` 的独立只读打开方式。检测到非空 WAL 即拒绝，避免在不稳定副本上读取；不会迁移、切换 WAL、写业务表或创建 sidecar 文件。
- dry-run 从查询本身的顺序输出无 PII 的 `rank`、`item_ref`、内部 lead ID、时间、意向和排序理由，以及候选/展示/裁剪统计。
- 新增 `pilot:queue-check`。它复用 Worker 的可领取/过期租约 SQL 条件，只读核验整个当前可领取队列。任何非本次 pilot 任务、非法快照、实时权限或上下文失效都会输出 `UNSAFE` 并返回非零退出码。

## 兼容性和回滚

没有数据库迁移、公开 HTTP API 或 H5 改动。删除/停用该新 CLI 并恢复本补丁涉及的服务端文件即可回到阶段四行为；不需要数据回滚。
