# OpenClaw 普通微信内部通知实现

本实现为实验性内部渠道，不是客户消息或大规模生产渠道。用户已接受专用账号长轮询、人工扫码、会话失效及账号风控风险；系统仍禁止 Hook、RPA、逆向协议、自动换号、批量发送、客户自动回复和任何入站业务接口。

链路为业务 outbox → 单实例 notification-worker → 回环 iLink Gateway → 固定测试接收人。Gateway 不访问业务数据库；API、AI Scheduler、H5 不读取微信会话或 Gateway Secret。Secret 仅从仓库外精确 0600 文件读取；Gateway 使用规范 `OPENCLAW_STATE_DIR` 作为官方会话状态目录，旧 `ILINK_POC_SESSION_DIR` 仅兼容别名且不可并存。

迁移 `007` 在单事务内重建 `notification_logs`，保持字段、数据、索引和外键，再将 `channel` 限制扩展为 `NULL`、`mock`、`openclaw`。不改 `001` 至 `006`，不回填、不补发、不启用规则。

OpenClaw 仅支持一个正整数 pilot 用户，以及 `owner_changed`、`scheduled_follow_overdue`、`daily_report` 三个事件的单一 `openclaw` 规则。消息使用固定隐私模板和 `https://xs.tomatopia.top/`，不携带客户数据、AI 输出或登录凭证。`result_unknown` 记录为不可重试 `failed`，不自动重发。

Gateway 对同一幂等键持久保存投递状态和原子发送锁。只有明确 `retryable_failure` 才能在 Worker 的两次尝试上限内重新获取发送权；重启后仍可重试。同键的并发请求不能重复调用 Adapter；`sent`、`permanent_failure`、`result_unknown` 均失败关闭。`deduplicated` 必须返回已持久化的原本地回执，否则安全失败。OpenClaw 超时完全由 `OPENCLAW_GATEWAY_TIMEOUT_MS` 控制；Worker 的旧 10 秒保护只保留给 Mock。

管理员规则 preview 和 PUT 共用事件接收人策略、单渠道门禁：规则启用与否均必须恰好指定 `mock` 或 `openclaw`。空数组、多渠道和其他渠道均被拒绝，preview 不会将无渠道规则显示为 `pending`。Gateway 已删除无调用的旧 `existing`/`reserve` 及 StateStore 独立创建、更新、查询包装；投递状态仅经原子 `acquire`/`finalize` 路径维护。
