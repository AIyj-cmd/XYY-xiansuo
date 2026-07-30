# 安全与数据库基线实施报告

日期：2026-07-30  
实施范围：阶段一安全与数据库基线；未接入微信、通知或 AI。

## 1. 基线

- 起始提交：`d77b600 Initial project import`。
- 开始前工作区已有大量未提交修改（后端认证、DB_PATH 初版、路由、前端、部署、依赖和设计文档）。这些修改未被视为已部署，也没有被回滚或覆盖。
- 本次所有测试均使用 `/tmp` 下独立临时数据库，未执行生产数据库操作，也没有使用或修改 `server/data/app.db`。

## 2. 已实现内容

- JWT 新签发 token 只携带用户 ID；认证中间件每次按 ID 查询 `id`、`username`、`name`、`role`、`is_active` 并重建 `request.user`。角色升降、停用和删除对旧 token 立即生效。
- 空 `users` 表才初始化管理员。支持 `ADMIN_INITIAL_USERNAME`、`ADMIN_INITIAL_NAME`、`ADMIN_INITIAL_PASSWORD`；密码至少 12 位。生产空库缺少密码会拒绝启动，开发/测试使用 `crypto.randomBytes` 生成的一次性密码；已有用户时不读取、生成或输出初始化密码。
- `DB_PATH` 在建立连接时解析：默认仍为 `server/data/app.db`，相对路径按进程工作目录，启动只记录规范化路径。连接建立时创建父目录、启用 WAL 和外键并验证外键已开启。
- 新增 `schema_migrations` 和版本迁移：`001` 创建基线 schema，`002` 对齐旧版 `leads`/`follow_ups`。迁移按版本执行、记录固定校验和、校验和冲突即失败、重复执行不重复变更。
- 迁移执行器输出结构化 `applied`、`skipped`、`failed` 结果。失败只记录错误类型/安全错误码，不记录原始错误消息、SQL 参数或业务数据；logger 故障不会掩盖原迁移异常。
- 旧 `leads` 表重建采用显式列复制和前后记录数校验；补齐 `follow_ups.images`、`follow_ups.amount`、`memos`、`favorites` 及索引。迁移在受控流程中临时关闭外键，完成后恢复并验证；每次运行执行 `integrity_check` 和 `foreign_key_check`，失败阻止 HTTP 服务启动。
- 种子脚本移除固定共享密码，要求 `SEED_MEMBER_PASSWORD`；备份脚本支持 `DB_PATH`。新增根目录和部署环境示例，部署脚本要求生产使用绝对 `DB_PATH`。
- 所有阶段一数据库测试使用独立临时库并关闭连接；补充验收修复了公海测试未删除自身临时目录的问题。

## 3. 修改文件

以下清单按本阶段实际归因整理。“本阶段确认”表示文件中的阶段一相关改动已经实施和验证，不表示该文件在任务开始时一定是干净状态。

### 3.1 本阶段确认的安全与数据库源码

- `server/src/db.ts`：`DB_PATH`、连接配置、外键验证、版本化迁移、完整性检查及迁移结果日志。
- `server/src/config.ts`（新增）：JWT secret、初始管理员和相关环境变量校验。
- `server/src/bootstrap.ts`（新增）：仅空库执行的安全管理员初始化。
- `server/src/index.ts`：迁移/管理员初始化成功后才构建和监听 HTTP 服务。
- `server/src/middleware/auth.ts`、`server/src/utils/jwt.ts`：JWT 仅作为身份凭证，实时读取数据库用户和角色。
- `server/package.json`、`server/package-lock.json`、`server/tsconfig.json`：后端构建、测试和 Node/ESM 兼容配置；工作区开始前已有的依赖差异未单独归因。

### 3.2 本阶段确认的测试

- `server/test/auth-db.test.ts`
- `server/test/bootstrap.test.ts`
- `server/test/config.test.ts`
- `server/test/migrations.test.ts`
- `server/test/startup-failure.test.ts`
- `server/test/independent-baseline-verification.test.ts`
- `server/test/pool.test.ts`：本阶段只归因于验收时补充的数据库连接关闭和自身临时目录清理。

`server/test/excel.test.ts` 及公海测试中的既有业务断言属于任务开始前工作区测试上下文，不归因为本阶段新增业务能力。

### 3.3 本阶段确认的环境、部署和脚本说明

- `.env.example`、`deploy/.env.example`
- [`docs/00-项目说明/README.md`](../00-项目说明/README.md)
- `deploy/deploy.sh`、`deploy/ecosystem.config.cjs`
- `scripts/backup.sh`、`scripts/seed.ts`

这些文件只归因于 `DB_PATH`、JWT/管理员环境变量、备份、生产启动门禁和移除固定种子密码等阶段一内容；同文件内其他既有部署差异不在本报告中重新归因。

### 3.4 本阶段文档和报告

- [`BASELINE_IMPLEMENTATION_REPORT.md`](BASELINE_IMPLEMENTATION_REPORT.md)
- [`TEST_REPORT.md`](../03-测试验证/TEST_REPORT.md)
- [`ACCEPTANCE_REPORT.md`](../04-验收交付/ACCEPTANCE_REPORT.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`DEPLOYMENT_NOTES.md`](../04-验收交付/DEPLOYMENT_NOTES.md)
- [`ROLLBACK_PLAN.md`](../04-验收交付/ROLLBACK_PLAN.md)

五份批准设计文档是本阶段输入依据，不作为本阶段代码实现产物。

### 3.5 任务开始前既有、未归因到本阶段的差异

- 前端及依赖：`app/package.json`、`app/package-lock.json`、`app/src/pages/pool/index.vue`、`app/vite.config.ts`。
- 业务路由：`server/src/routes/import_export.ts`、`server/src/routes/leads.ts`、`server/src/routes/memo.ts`、`server/src/routes/upload.ts`、`server/src/routes/users.ts`。
- 其他部署/仓库上下文：`deploy/setup.sh`、`.codex/`、`.github/`、`AGENTS.md` 和五份设计文档等。

上述差异在任务开始前已经存在或无法安全拆分归因；本阶段没有回滚、覆盖，也没有把它们宣称为阶段一已部署内容。

## 4. 数据库迁移版本

| 版本 | 描述 | 作用 |
| --- | --- | --- |
| `001` | `create baseline schema` | 创建当前业务表、索引和迁移记录基础。 |
| `002` | `reconcile legacy lead and follow-up schema` | 兼容旧库缺列、`phone NOT NULL` 和缺少“停止跟进”的状态约束。 |

回滚方式：迁移前对实际 `DB_PATH` 使用 SQLite `.backup` 创建可恢复快照；若迁移或完整性检查失败，服务不启动，使用备份恢复后在副本复查，不在生产库手工跳过迁移记录。

## 5. 自动化测试

- `cd server && npm test`：28 项通过。
- 覆盖实时角色、停用/删除失效、管理员初始化、DB_PATH 隔离、外键、空库/旧库/重复迁移、checksum 冲突、记录和索引保留、迁移失败阻止 `buildApp`、核心 API 回归，以及 applied/skipped/failed 安全日志。
- 公海临时库清理：补充验收前有 14 个历史 `xiansuo-pool-*` 目录；定向测试 3/3 和完整测试 28/28 后仍为同一集合，本次运行无新增残留，既有目录未擅自删除。

## 6. 构建与静态检查

已通过：

- `cd server && npm run build`
- `cd app && npm run build:h5`
- `cd app && npm run build:mp-weixin`
- `cd server && npm audit --omit=dev`、`cd app && npm audit --omit=dev`：均为 0 vulnerabilities。
- `git diff --check`
- 固定默认密码源代码检查：当前已跟踪代码无匹配。

前端构建仅提示未配置 uni Appid，因此未启用统计；构建成功。

## 7. 兼容性

- 保持原有 Bearer Token、API 路径和 `{ code, msg, data }` 响应包络；旧 token 可继续验签，但不再信任其中的姓名或角色。
- 未修改前端业务代码；未修改通知、微信、DeepSeek、AI、拜访、日报、`sales_stage` 或组织架构。

## 8. 未完成项

- 尚未核验生产实际 commit、环境、数据库路径和备份恢复演练；部署前必须完成这些外部确认。
- 第四阶段代码验收已通过；生产立即上线仍受上述生产配置、发布制品和备份恢复门禁约束，详见 [`ACCEPTANCE_REPORT.md`](../04-验收交付/ACCEPTANCE_REPORT.md)、[`DEPLOYMENT_NOTES.md`](../04-验收交付/DEPLOYMENT_NOTES.md)、[`ROLLBACK_PLAN.md`](../04-验收交付/ROLLBACK_PLAN.md)。

## 9. 已知风险

- 当前工作区仍有大量未提交和未跟踪差异，不能直接视为生产发布制品。
- 尚未在生产数据库备份副本完成迁移与恢复演练。
- 微信小程序未配置 uni Appid；不影响本次构建，但正式发布前仍需配置和复核。
- `/tmp` 中有 14 个验收前遗留的公海测试目录；修复后测试不再新增，本阶段因无法安全归因而未删除。

## 10. 后续阻塞项

- member 线索读取隔离和创建时 owner 规则。
- 负责人统一转移、批量逐条审计。
- 跟进编辑/删除后的派生日期重算。
- 前后端“邮件”跟进枚举统一。
- 通知、普通微信、企业微信、拜访、日报和 AI 均须按批准设计完成各自前置门禁后另行实施。
