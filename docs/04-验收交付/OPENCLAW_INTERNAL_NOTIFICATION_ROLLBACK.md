# OpenClaw 内部通知回滚

## 渠道停用

立即将 `OPENCLAW_CHANNEL_ENABLED=false` 与 `ILINK_POC_LIVE_ENABLED=false`，先正常停止 notification-worker，再停止 Gateway 和 OpenClaw daemon。确认无残留进程和本地监听。Worker 会保留未领取的 `openclaw` outbox 任务，不会切换到 Mock 或其他渠道；随后由管理员禁用相应规则，使尚未领取的 `pending`/`retry_wait` 任务按现有状态机取消。

`result_unknown` 必须隔离并人工核对微信端，禁止更换幂等键、人工重试或切换渠道。明确已 `sent` 的任务不得补发；明确失败的任务也不得在未重新批准前恢复。保留 notification 与 Gateway 幂等审计，日志不得补写原始消息或凭证。

## 制品与数据库

迁移 `007` 不删除历史记录且不改旧迁移；如需数据库结构回滚，应在维护窗口从验证过的备份恢复，而不是手工修改迁移历史。撤销本功能后仍需安全保管/轮换仓库外 Secret 和会话文件。

应用回滚只能回到能够识别数据库迁移 `007` 的兼容制品。不得修改 `schema_migrations`、执行破坏性 down migration，或用旧备份覆盖迁移后已产生新业务写入的数据库。若只回滚渠道代码，保留 `007` 和全部通知记录即可；`openclaw` 任务在开关关闭时不会被领取。

隔离 synthetic DB 不是生产数据，也不得由入队 CLI 自动删除。实况结束后仅由主代理在确认任务终态、Gateway 回执和两次去重证据后，按单独授权精确清理该一个已记录临时目录；不得使用通配符、递归清理临时根目录或触及 `server/data`。

如 sealed-state 检查报出路径、权限、完整性、外键、规则或任务异常，立即视为未发送并保持真实渠道关闭；不得通过修正数据库、等待 retention cleanup 删除污染、重建任务或更换幂等键绕过门禁，改由独立复验后使用全新隔离库重新开始。

## 验证

回滚后核对 API、线索、跟进、负责人、H5 站内通知和 Mock 行为；确认 AI Scheduler 不因渠道失败重新调用 Provider，Gateway 不访问业务数据库，所有真实渠道关闭，`server/data` 未变化。Secret 如疑似暴露必须在仓库外轮换；会话失效仅允许专用账号人工重新登录。
