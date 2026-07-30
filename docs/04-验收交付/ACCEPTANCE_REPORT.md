# 阶段一验收报告：安全与数据库基线

日期：2026-07-30  
验收阶段：第四阶段（验收优化）  
基线提交：`d77b600 Initial project import`  
结论：**代码与自动化验收通过；当前不建议直接生产上线，须先完成生产环境与备份恢复门禁。**

## 1. 验收依据与边界

- 权威需求：用户提供的“XYY-xiansuo 开发实现阶段一：安全与数据库基线”。
- 批准设计：[`SYSTEM_ANALYSIS.md`](../01-审计与设计/SYSTEM_ANALYSIS.md)、[`TECH_DESIGN.md`](../01-审计与设计/TECH_DESIGN.md)、[`DATABASE_CHANGE_PLAN.md`](../01-审计与设计/DATABASE_CHANGE_PLAN.md)、[`API_CHANGE_PLAN.md`](../01-审计与设计/API_CHANGE_PLAN.md)、[`DEVELOPMENT_PLAN.md`](../01-审计与设计/DEVELOPMENT_PLAN.md)。
- 实施与独立测试证据：[`BASELINE_IMPLEMENTATION_REPORT.md`](../02-开发实现/BASELINE_IMPLEMENTATION_REPORT.md)、[`TEST_REPORT.md`](../03-测试验证/TEST_REPORT.md)。
- 本阶段只修复独立测试已确认的迁移日志阻断；未实现通知、微信、DeepSeek、AI、拜访、日报、`sales_stage` 或新的权限口径。
- 未操作 `server/data/app.db` 或任何生产数据库；验收测试使用 `/tmp` 临时数据库。
- 补充验收前记录到 14 个既有 `/tmp/xiansuo-pool-*` 目录。修复后分别运行定向测试和完整测试，运行前后目录集合均保持同一 14 项，没有新增残留；这些无法归因到本次运行的既有目录未被擅自删除。

## 2. 已确认修复

独立测试报告确认的高严重级问题“迁移没有输出版本和结果日志”已修复：

- `runMigrations()` 支持注入 `MigrationLogger`，并提供默认结构化 logger。
- 成功提交且连接外键状态恢复后记录 `version`、`description`、`result=applied`。
- 已有同版本且 checksum 匹配时记录 `result=skipped`。
- checksum 冲突或迁移异常时记录 `result=failed` 和仅含错误类型/安全错误码的 `errorSummary`，不记录错误消息、SQL 参数、客户数据、密码或哈希。
- logger 自身抛错会被隔离，原迁移异常仍原样抛出；失败迁移不写完成记录。
- 新增 applied、skipped、failed 三类自动化测试，并验证敏感错误消息不会进入日志事件。

补充验收发现并修复了公海测试的临时数据库清理缺口：

- `pool.test.ts` 显式保存其唯一 `testDirectory`。
- `test.after()` 依次关闭 Fastify、调用 `closeDb()`，再精确删除该测试创建的目录。
- 定向测试 3/3 和完整后端测试 28/28 后，验收前后 `/tmp/xiansuo-pool-*` 集合一致。

## 3. 验收矩阵

| 验收域 | 结果 | 主要证据 |
| --- | --- | --- |
| JWT 实时身份与角色 | 通过 | 历史 JWT 只取 user ID；数据库实时覆盖 username/name/role/is_active；升降级、停用、删除、401/403 测试通过。 |
| 默认管理员安全 | 通过 | 空库才初始化；生产缺密码拒绝；短密码拒绝；开发/测试使用 `crypto.randomBytes`；已有用户不重复初始化。 |
| `DB_PATH` | 通过 | 默认、绝对、相对路径及 import 后动态环境变量均有测试；父目录创建、不可用路径失败、连接关闭、隔离及测试目录清理通过。 |
| SQLite 连接保护 | 通过 | 每个应用/测试连接开启 WAL 和 foreign keys，并断言 `foreign_keys=1`；非法外键失败、合法写入成功。 |
| 版本化迁移 | 通过 | `schema_migrations`、固定版本/描述/checksum、顺序执行、幂等、checksum 冲突阻断、失败回滚及 applied/skipped/failed 日志均通过。 |
| 旧结构兼容 | 通过 | 空库、无迁移记录的当前库、缺表/缺列/旧 leads 约束均可升级；记录、主键、关系、11 个索引保留，无临时残表。 |
| 启动门禁 | 通过 | 迁移/checksum 或管理员初始化失败时 `buildApp()` reject，HTTP 实例不会进入监听。 |
| API 兼容 | 通过 | 登录、当前用户、管理员接口、线索创建/列表、跟进创建、用户角色和停用回归通过，响应包络保持 `{ code, msg, data }`。 |
| 范围控制 | 通过 | 阶段一未新增通知、微信、AI、拜访、日报或 `sales_stage` 代码；验收阶段未修改前端。 |
| 文档与部署 | 通过 | 环境变量、备份、迁移时机、部署门禁、监控和回滚说明齐备。 |

## 4. 最终验证结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 通过，28/28 |
| `cd app && npm run build:h5` | 通过；仅有未配置 uni Appid 的统计提示 |
| `cd app && npm run build:mp-weixin` | 通过；仅有同一 Appid 提示 |
| `cd server && npm audit --omit=dev` | 通过，0 vulnerabilities |
| `cd app && npm audit --omit=dev` | 通过，0 vulnerabilities |
| `git grep -n "xyy123456"` | 无匹配 |
| 阶段范围源码扫描 | 未发现通知、微信、DeepSeek、AI、拜访或 `sales_stage` 新增 |
| 公海临时目录前后核对 | 通过；完整测试前后均为同一 14 个历史目录，无新增残留 |
| `git diff --check` | 通过 |

## 5. 差异归因

- 验收阶段业务源码修改仅为 `server/src/db.ts` 的迁移 logger。
- 验收阶段测试修改为 `server/test/migrations.test.ts` 的三类日志结果测试，以及 `server/test/pool.test.ts` 的连接关闭与精确临时目录清理。
- 验收阶段新增/更新本文及 [`CHANGELOG.md`](../02-开发实现/CHANGELOG.md)、[`DEPLOYMENT_NOTES.md`](DEPLOYMENT_NOTES.md)、[`ROLLBACK_PLAN.md`](ROLLBACK_PLAN.md)、实施/测试报告。
- 当前工作区其他前端、公海、路由、依赖、部署和脚本差异在验收开始前已经存在；本阶段未回滚、覆盖或宣称这些差异均属于阶段一。

## 6. 已知问题与残余风险

| 严重级别 | 风险 | 影响与处置 |
| --- | --- | --- |
| 高（上线门禁） | 生产实际 commit、环境变量和真实 `DB_PATH` 未核验 | 当前工作区为未提交状态，不能直接视为发布物；上线前必须形成可追溯制品并核对服务器配置。 |
| 高（上线门禁） | 未在生产数据库备份副本完成迁移及恢复演练 | 不允许把真实生产库作为首次试跑目标；按 [`DEPLOYMENT_NOTES.md`](DEPLOYMENT_NOTES.md) 在副本验证并按 [`ROLLBACK_PLAN.md`](ROLLBACK_PLAN.md) 演练。 |
| 中 | 当前仓库包含阶段一以外的既存未提交改动 | 发布前必须逐项评审并决定是否纳入同一制品，避免把无关前端/公海变更夹带上线。 |
| 低 | 微信小程序未配置 uni Appid | 不影响本次构建；正式小程序发布前需配置并在开发者工具复核。 |
| 信息 | `/tmp` 中存在 14 个验收前遗留的 `xiansuo-pool-*` 目录 | 修复后测试不再新增；因无法安全归因，本次未删除，后续可由环境所有者按保留策略处理。 |
| 后续范围 | member 读取隔离、owner 规则、批量转移审计、跟进派生日期、“邮件”枚举 | 均为批准设计记录的后续阻塞项，本阶段不得顺便修改；通知/AI 上线前按各自门禁处理。 |

## 7. 上线建议

- **阶段一代码验收：通过。**
- **立即生产上线：不建议。**
- 完成以下条件后可进入受控上线：锁定并评审发布 commit/制品；确认生产 `NODE_ENV`、绝对 `DB_PATH`、`JWT_SECRET` 和首次管理员配置；备份数据库与上传文件；在数据库副本运行迁移和恢复演练；维护窗口启动后观察每个迁移版本的 `applied/skipped` 日志且无 `failed`；完成登录、实时降权和核心 API 冒烟。
