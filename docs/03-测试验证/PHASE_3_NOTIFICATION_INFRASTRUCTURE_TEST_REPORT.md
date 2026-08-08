# 阶段三通知基础设施独立测试报告

> H5-only 后续决策说明：本报告中的微信小程序构建命令、数量和通过结论均为决策前历史事实；之后不再构建、发布或验收小程序。

日期：2026-07-30

测试角色：`test_verifier`（独立验证，未修改业务实现）

实现基线：`feature/phase3-notification-infrastructure` / `9a8fe40c900c927ac5b722613666d85e93f08af0`

## 结论

**允许进入验收阶段。** 原报告的 6 项 P2 已由原 implementer 修复并由同一独立矩阵复测通过；后端完整测试为 53 通过 / 0 失败。独立失败用例已保留并恢复为精确通过断言。

## 测试环境与数据保护

- Node/TypeScript 项目本地依赖；所有新增和独立运行的服务端测试均设置 `DB_PATH=/tmp/xiansuo-phase3-independent-*/verification.db`。
- 未打开、写入或迁移 `server/data`。测试前后五个文件路径、大小与 SHA-256 完全一致：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `server/data/app.db` | 94208 | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `server/data/app.db-shm` | 32768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `server/data/app.db-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/leads.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/xiansuo.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

- 测试前已有阶段三实现差异；测试阶段仅新增 `server/test/phase3-independent-verifier.test.ts` 与本报告。未恢复、覆盖或清理其他改动。

## 执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过 |
| `cd app && npm run build:h5` | 通过 |
| `cd app && npm run build:mp-weixin` | 通过 |
| `cd server && npx tsx --test test/phase3-independent-verifier.test.ts` | 11 通过 / 0 失败（隔离库） |
| `cd server && npm test` | 53 通过 / 0 失败 |
| `git diff --check` | 通过 |
| `VITE_LEAD_POOL_CLAIM_ENABLED=invalid npm run build:h5` | 按预期失败，提示只接受 `true` 或 `false` |
| 生产依赖审计 | 未执行：`dependencies`、锁文件无变更，仅增加 worker npm scripts |

## 已通过验证

- 关闭态公海：未认证请求为 401；认证 admin/member 的 `GET /api/pool?days=invalid` 和 `POST /api/pool/not-a-number/claim` 都在参数处理前返回 HTTP 403、统一包络和 `LEAD_POOL_CLAIM_DISABLED`；无负责人、`pool_claim` 审计或 outbox 变化。
- “全部线索”仍能按关键字读取；线索池前端页保留全部线索、搜索/筛选/收藏/详情代码路径。默认构建时 UI 开关为 false，不展示公海页签和认领控件。
- `001/002/003` checksum 与批准基线一致；空库执行到 `004`，初始七条规则均关闭；`004` 只新增 `notification_rules`、`notification_logs` 和通知索引，不建立公海表。
- 迁移重复执行、旧库兼容、校验和冲突、失败迁移未写完成记录、外键和基础完整性测试均通过。
- 五个服务端开关的默认 false 和非法值启动拒绝通过；捕获关闭时，负责人和 transfer 审计保留、outbox 不写，并输出 `notification.capture.disabled` 结构化警告及不补发说明。
- `single_edit` 合格负责人变更在规则关闭时写 `suppressed/rule_disabled`；普通字段编辑不写任务；自己转自己/no-op 沿用无重复变更路径。
- 注入 `notification_logs` 写入失败时，单条负责人与 transfer 审计整体回滚；Mock/Worker 发送不在业务事务中。
- 管理 API 的实时管理员权限、member 403、规则 preview 零日志写入、敏感字段拒绝和规则版本冲突 409 通过；响应均使用既有 `{ code, msg, data }` 包络，列表/详情投影不返回规则快照、消息快照或错误正文。
- 租约 token 比较：旧 token 不能覆盖有效 token 的 sent 更新。Mock 仅使用确定性 SHA-256 receipt，无网络调用；静态范围搜索未发现微信/企微、Wechaty、iLink、RPA、Hook、DeepSeek/AI、拜访/日报/周报、`lead_created`、`sales_stage`、第三投递表或规则历史表。
- PM2 示例为单实例 `fork`，Worker 是独立入口；数据库连接配置已设置 `busy_timeout=5000`。Scheduler 提供可导入的空 `schedulerRegistry`、`SchedulerJob`/结果类型和 `schedulerDryRunOptions({as_of, limit, deadline_ms})`，没有注册真实 job 或写库/发送路径。未提供 HTTP dry-run 路由；冻结设计未指定固定路由，故记录为内部可调用契约，不单列缺陷。

## P2 修复复测

| 原问题 | 修复与复测结果 |
| --- | --- |
| P2-1 无可用渠道仍为 pending | `captureOwnerChanged()` 现在校验 `channel_order` 是否包含 Mock；同一独立用例精确断言 `suppressed/no_usable_channel`，通过。 |
| P2-2 JSON 类型约束缺失 | `004` 的规则、快照和管理审计 JSON CHECK 已增加 `json_type` object/array 限制；`config_json='[]'` 被拒绝，通过。`004` 新 checksum 为 `61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75`，`001/002/003` checksum 未变。 |
| P2-3 成功未记 attempt | sent 路径递增 `attempt_count`、`automatic_attempt_count` 并记录 `last_attempt_at`；独立断言 `attempt_count=1`，通过。 |
| P2-4 sending TTL 不即时取消 | 过期 sending 任务现在不再等待 lease 到期，复测精确断言 `cancelled/task_expired`，通过。 |
| P2-5 Vite 开关不严格 | `app/vite.config.ts` 与页面启动路径均拒绝非法值；`VITE_LEAD_POOL_CLAIM_ENABLED=invalid npm run build:h5` 退出码 1，符合预期。 |
| P2-6 Worker 并发为 1 | Worker 以批次 10、每组 2 个的 `Promise.all` 处理；静态复核确认并发上限为 2，短事务领取和事务外发送保持不变。 |

## 未覆盖或仅静态覆盖（非阻塞）

- 未启动长期 Worker 进程进行 SIGTERM 优雅关闭、真实双进程 SQLite 竞争和 PM2 运行态验证；已验证领取/旧 token 的核心函数与单实例配置。修复 P2 后需补充两进程竞争、租约恢复、5 次重试、TTL、180 天清理和关闭恢复测试。
- Mock 的 success/duplicate/delay/timeout/rate-limit/temporary-5xx/permanent-config-error 是静态及单元实现审阅；尚未逐模式由独立端到端 Worker 运行验证。
- 管理 API 已覆盖权限、preview、秘密字段、乐观锁与脱敏投影；日志分页筛选、failed 人工 retry 成功、sent/suppressed/cancelled/expired retry 拒绝需在修复后扩展独立 API 测试。
- H5 默认构建和微信小程序构建通过；未进行真机/微信开发者工具交互测试。

## 测试阶段文件变化

- 新增：`server/test/phase3-independent-verifier.test.ts`（独立失败用例保留）。
- 新增：`docs/03-测试验证/PHASE_3_NOTIFICATION_INFRASTRUCTURE_TEST_REPORT.md`。
- 未修改 `app/src`、`server/src`、迁移、部署实现、业务数据库或现有实现报告。

## 放行条件

已完成原 `test_verifier` 复测、完整构建与差异检查。未发现未修复 P1/P2；允许进入 `acceptance_optimizer`，但不授权超出阶段三批准范围的新增功能。
