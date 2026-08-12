# 阶段三通知基础设施验收报告

> H5-only 后续决策说明：本报告中的微信小程序构建命令、数量和通过结论均为决策前历史事实；之后不再构建、发布或验收小程序。

日期：2026-07-30

设计基线：`9a8fe40c900c927ac5b722613666d85e93f08af0`

实现提交：`0f0c4a261fe66d54d6557dea88f2ce0422a73800`

分支：`feature/phase3-notification-infrastructure`

## 1. 验收结论

阶段三批准范围验收通过，未发现未解决 P1/P2。代码可以进入受控部署准备，但生产上线为 **有条件放行**：在数据库副本完成迁移 `004` 和恢复演练、公海关闭检查通过、五个服务端开关保持关闭之前，实际生产发布仍为 NO-GO。

本次未部署、未连接生产数据库、未推送、未创建 PR，也未进入真实渠道、AI 或下一阶段。

## 2. 范围核对

- 线索池、底部入口和“全部线索”保留；搜索、筛选、分页、收藏和详情路径未改变。
- 仅软关闭“公海待认领”页签、筛选、认领按钮以及 `GET /api/pool`、`POST /api/pool/:id/claim`。
- 服务端关闭态在认证后、参数校验和事务前返回 HTTP 403、`LEAD_POOL_CLAIM_DISABLED` 和统一包络。
- 历史 `pool_claim`、负责人、线索、跟进和审计未清理或回填；运行时通知来源只允许 `single_edit`、`batch_transfer`。
- 迁移 `004` 只增加 `notification_rules`、`notification_logs`、批准索引和七条默认关闭规则；`001/002/003` 内容及 checksum 未改变。
- 捕获、Worker、Mock、Scheduler 开关独立且严格解析；默认均为 `false`。
- `owner_changed` 与负责人更新、transfer audit、旧任务取消和 outbox 写入处于同一业务事务；发送在事务外。
- 独立 Worker 使用 60 秒租约、批次 10、并发 2、最多五次自动尝试、24 小时 TTL、180 天终态保留和限批清理。
- Mock 只生成确定性 receipt，不读取真实凭证、不修改业务表，也没有外部网络路径。
- 七个管理 API 使用实时 `requireAdmin`，支持乐观锁、preview 零写入、日志脱敏和受限人工重试。
- Scheduler registry 为空，只有可注入 `as_of`、limit、deadline 的 dry-run 选项结构。

## 3. 验收阶段确认并修复的问题

### P2-1 静默时段未生效

原实现解析了 `quiet_hours`，但捕获和 preview 的 `available_at` 未延后。验收用例复现跨午夜 `22:00–08:00` 在 23:15 仍立即可用。

修复后捕获与 preview 复用同一 Asia/Shanghai 计算，结果为次日 08:00，并将时间格式收紧为合法 `HH:mm`。

### P2-2 幂等冲突误判

原实现只比较 operation、lead、new owner 和 recipient；actor、old owner、source 或 occurred_at 不一致仍可能被当作幂等命中。

修复后核对完整不可变事件字段；不一致时输出 `notification.task.dedupe_conflict` 并回滚当前业务事务。

### P2-3 Worker 发送前缺少有效性门禁

Worker 原先未在渠道调用前复核线索当前负责人和接收人状态，也重新拼装消息而未消费任务快照。

修复后失效任务以 lease token 条件转为 cancelled，旧租约不能覆盖；发送使用不可变消息快照，非法快照和不可恢复任务数据进入永久失败且禁止人工重试。

### P2-4 运维和管理边界不完整

修复包括：Worker 启用时要求显式绝对 `DB_PATH`；PM2 单实例默认关闭时不重启循环；队列维护限批；管理日志非法 ID 保持统一包络；failed 人工重试增加当前负责人、接收人、规则和 Mock 恢复检查。

## 4. 验证结果

- 独立阶段三验收矩阵：19/19。
- 后端 TypeScript 构建：通过。
- 后端完整测试：61/61。
- H5 构建：通过。
- 微信小程序构建：通过。
- `VITE_LEAD_POOL_CLAIM_ENABLED=invalid` H5 构建：按预期失败。
- `git diff --check`：通过。
- PM2 配置结构检查：通过，Worker 为单实例 fork。
- 生产依赖审计：未执行；依赖字段和锁文件没有变化，仅增加 npm scripts。

`server/data` 五个文件验收前后 SHA-256 保持：

| 文件 | SHA-256 |
| --- | --- |
| `app.db` | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `app.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `app.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `leads.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `xiansuo.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

迁移 `004` checksum 为 `61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75`。

## 5. 已知限制和残余风险

- 未在真实 PM2 进程中执行 SIGTERM、强制终止和长期双进程锁竞争；核心租约竞争、恢复、旧 token 和优雅关闭代码路径已自动化验证。
- 未进行 H5 浏览器和微信开发者工具真机交互；两目标编译及关闭态静态路径已验证。
- 生产数据库副本迁移和恢复演练尚未执行，这是生产上线前外部门禁。
- Mock 幂等不代表未来真实渠道 exactly-once；真实渠道接入必须重新审计。
- 当前 `/api/notifications` 与可靠 outbox 仍是两套语义，符合冻结设计。

## 6. 上线建议

**CONDITIONAL GO。** 完成部署说明中的备份/恢复演练和关闭态验证后，可以部署本阶段制品；生产环境通知捕获、Worker、Mock、Scheduler 和全部规则继续保持关闭。任何真实渠道、AI、拜访或新事件开发均不得随本阶段上线。
