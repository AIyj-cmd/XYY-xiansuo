# 阶段三通知基础设施部署说明

## 1. 上线前门禁

1. 使用本阶段已验收本地提交构建，不混入其他分支或工作区文件。
2. 设置同一个显式绝对 `DB_PATH` 给 API 和 Worker；确认目标不是仓库 `server/data` 中的开发数据库。
3. 对实际 SQLite 数据库执行一致性备份，并在隔离副本验证恢复。
4. 在副本启动阶段三后端，使迁移按 `001 → 002 → 003 → 004` 执行。
5. 核对副本 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、迁移 checksum、两张通知表和七条默认关闭规则。
6. 确认没有依赖或锁文件变化；本阶段不需要新增生产依赖。

生产初始配置：

```text
LEAD_POOL_CLAIM_ENABLED=false
NOTIFICATION_CAPTURE_ENABLED=false
NOTIFICATION_WORKER_ENABLED=false
NOTIFICATION_MOCK_ENABLED=false
NOTIFICATION_SCHEDULER_ENABLED=false
VITE_LEAD_POOL_CLAIM_ENABLED=false
```

所有布尔值只接受小写 `true` 或 `false`。非法值必须使 API 启动或前端构建失败。

## 2. 推荐部署顺序

1. 备份生产库并完成副本迁移/恢复演练。
2. 以全部通知开关关闭部署 API，确认迁移 `004` 成功。
3. 用 admin 和 member 分别验证两个公海接口均为 403、`LEAD_POOL_CLAIM_DISABLED`；未认证仍为 401。
4. 验证 `GET /api/leads`、详情、搜索、筛选、收藏、单条和批量负责人转移。
5. 部署以 `VITE_LEAD_POOL_CLAIM_ENABLED=false` 构建的 H5/小程序，验证线索池只显示“全部线索”。
6. 将实现提交 `0f0c4a261fe66d54d6557dea88f2ce0422a73800` 的后端制品和关闭配置记为“公海关闭最低安全回滚基线”。
7. 保持生产捕获、Worker、Mock、Scheduler 和规则关闭。
8. 仅在非生产试运行环境开启 `NOTIFICATION_CAPTURE_ENABLED=true`，规则仍关闭，验证合格变更写入 `suppressed/rule_disabled`。
9. 通过 admin preview 验证规则、接收人和静默时段，不落库、不发送。
10. 非生产环境再依次开启 `NOTIFICATION_MOCK_ENABLED=true`、`owner_changed` 规则、`NOTIFICATION_WORKER_ENABLED=true`。

捕获和 Worker 相互独立：Worker 关闭时已捕获任务必须保留；捕获关闭时业务和 transfer audit 继续，但该期间事件不会补发。

## 3. PM2

API 使用 `deploy/ecosystem.config.cjs`。Worker 使用：

```bash
XIANSUO_SERVER_DIR=/opt/xiansuo/server \
DB_PATH=/absolute/path/to/app.db \
NOTIFICATION_WORKER_ENABLED=false \
pm2 startOrReload deploy/ecosystem.phase3.config.cjs --update-env
```

Worker 配置固定 `instances: 1`、`exec_mode: fork`。默认关闭时正常退出，PM2 不应重启循环；启用时若 `DB_PATH` 缺失或不是绝对路径，进程启动失败。

启用 Worker 前再次比较 API 与 Worker 的 `DB_PATH`，不得只依赖工作目录或相对路径。

## 4. 迁移副本检查

迁移 `004` 预期 checksum：

```text
61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75
```

副本应满足：

- `001/002/003` checksum 与冻结基线一致；
- 只新增 `notification_rules`、`notification_logs` 和通知索引；
- 七条规则全部 `enabled=0`；
- 历史 `audit_logs.source='pool_claim'` 数量和内容不变；
- leads、follow_ups、负责人关系和公海阈值数据不变；
- 重复启动只跳过已完成迁移。

迁移失败时停止部署，不手工修改 `schema_migrations`。

## 5. 监控信号

重点观察：

- `notification.capture.disabled`，其中明确事件不会补发；
- `notification.task.created/suppressed/dedupe_conflict`；
- `notification.worker.claimed/sent/retry_scheduled/failed/cancelled/lease_lost`；
- `notification.worker.retention_cleaned`；
- SQLite busy/locked、迁移失败、Worker 启动失败；
- pending/retry_wait 数量、最老任务年龄、失败率和租约恢复次数。

日志不得记录客户完整隐私、消息全文、SQL 参数、凭证或原始 provider 错误。

## 6. 发布后检查

- 公海查询和认领仍被后端拒绝，且不新增 `pool_claim`。
- 线索池与“全部线索”正常。
- 普通新增和普通字段编辑不生成通知。
- 合格单条/批量转移在规则关闭时产生 suppressed；捕获关闭时只产生业务审计和结构化警告。
- 生产没有真实微信、AI、拜访、日报、周报或外部网络调用。
