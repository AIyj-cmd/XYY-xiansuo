# 阶段三通知基础设施开发实现

实施基线：`9a8fe40c900c927ac5b722613666d85e93f08af0`（`feature/phase3-notification-infrastructure`）。

## 已实现内容

- 服务端严格解析 `LEAD_POOL_CLAIM_ENABLED`、`NOTIFICATION_CAPTURE_ENABLED`、`NOTIFICATION_WORKER_ENABLED`、`NOTIFICATION_MOCK_ENABLED`、`NOTIFICATION_SCHEDULER_ENABLED`；未设置默认为 `false`，非法值启动失败。
- 公海列表和认领在认证后、解析参数前返回 403 与 `LEAD_POOL_CLAIM_DISABLED`。前端保留线索池“全部线索”并以 `VITE_LEAD_POOL_CLAIM_ENABLED` 隐藏公海入口和交互。
- 迁移 `004` 创建规则表、事务性 outbox、状态/事件/幂等/租约/保留索引及全部关闭的初始规则。没有处理 `pool_claim` 或业务表。
- `single_edit`、`batch_transfer` 的真实负责人变更在同一事务内完成业务审计、取消失效队列项和 outbox 写入；普通编辑、同负责人和操作者转给自己不创建任务。
- Worker 作为独立入口，使用同一 `DB_PATH` 的独立连接；支持短事务领取、60 秒租约、lease token 保护、最多五次尝试、24 小时 TTL、180 天终态保留和每批 100 条清理。
- 仅有无网络、无凭证、确定性 receipt 的 Mock 渠道；管理 API 使用实时 `requireAdmin` 和统一包络。Scheduler registry 保持为空。

## 运维配置

`.env.example` 与 `deploy/.env.example` 写明默认关闭的开关；`deploy/ecosystem.phase3.config.cjs` 提供 PM2 单实例 Worker 示例。启用捕获、Mock、规则及 Worker 前须按顺序显式批准并配置。

## 验证

- `server`: `npm run build`、`npm test`（42/42）。
- `app`: `npm run build:h5`、`npm run build:mp-weixin`。
- 所有自动化数据库均在 `/tmp` 临时目录；未使用或修改 `server/data`。

未提交、未推送、未创建 PR、未操作生产数据库。

## 独立验证后的修复

- 空渠道规则改为 `suppressed/no_usable_channel`，不再产生无法投递的 `pending`。
- 迁移004的所有规则与任务 JSON 字段增加对象/数组类型约束；成功发送也计入尝试次数。
- 已过期的 `sending` 任务立即取消，不等待租约；Worker 按每批 10、并发 2 发送。
- Vite 配置和运行时均严格校验 `VITE_LEAD_POOL_CLAIM_ENABLED`，非法值拒绝构建或启动。
