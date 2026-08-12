# 阶段四点五：Provider 延迟审计修复

本修复关闭真实单用户联调发现的 P2：Provider 已返回 `latencyMs`，但 AI 审计库与管理员只读日志没有持久化该值。

## 迁移与语义

新增前向迁移 `006`，描述为 `add provider latency audit to ai request logs`，在 `ai_request_logs` 追加 `latency_ms INTEGER NULL`。迁移 `001` 至 `005` 的内容、版本、描述和 checksum 均未修改。

`latency_ms` 是一个 AI 任务已经实际发起的全部 Provider 请求尝试的累计耗时，单位为毫秒；它不包含数据库、调度、上下文/模板构造或通知处理。

- 没有实际 Provider 调用时为 `NULL`，绝不用 `0` 代替。
- 成功、HTTP/网络错误、超时、取消、响应读取/解析、Schema 或安全输出拒绝均使用 `performance.now()` 取得非负整数毫秒。
- 调用前取消、配置错误、额度阻止、规则关闭和空上下文不制造虚假耗时。
- 每个已完成尝试原子累加；租约恢复不会清零或覆盖既有值。
- 终态、fallback、结果快照清理和 outbox 关联均不会修改已有值。

Provider 异常只保留安全分类 `code`、`retryable` 和 `latencyMs`，不会记录上游正文、Prompt、上下文、Authorization 或 API Key。

## 数据与 API

迁移约束为：`latency_ms IS NULL OR (typeof(latency_ms) = 'integer' AND latency_ms >= 0)`。历史 `005` 记录在升级到 `006` 后保持 `NULL`，不会估算或回填。

`GET /api/admin/ai/request-logs` 的既有 admin-only 安全投影新增 `latency_ms`。它只返回非负整数或 `null`，不新增筛选参数，也不暴露结果快照、Prompt、上下文、原始错误或任何密钥。

未修改 H5、通知 Worker、allowlist、Provider 请求格式或权限口径；未执行真实 DeepSeek、真实 Key、Scheduler/Worker 或生产数据库操作。补丁验收通过后，仍需使用新的隔离副本按原单用户范围重新执行受控真实 Provider 联调。
