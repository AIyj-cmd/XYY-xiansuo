# 阶段三独立测试报告：安全与数据库基线

日期：2026-07-30  
原独立测试结论：**不允许无条件进入验收阶段**。除迁移日志可观测性外，已执行的功能、安全、迁移、构建和依赖检查均通过；该缺陷修复并复测后可带条件进入验收。  
第四阶段复测结论：迁移日志阻断已修复，后端 28/28、前后端构建和生产依赖审计均通过；代码验收通过，生产上线仍须完成发布制品、真实环境和备份恢复门禁。

## 1. 测试环境与基线

- 工作目录：`/home/yj/xiansuo`；提交：`d77b600 Initial project import`。
- Node：`v24.18.0`；后端使用 `node:sqlite`，测试数据库均在 `/tmp/xiansuo-independent-*` 创建并清理。未读取、写入或迁移 `server/data/app.db`，未接触生产数据库。
- 测试开始前，工作区已有大量未提交改动：README、前端依赖/线索池、部署/脚本、后端 DB/鉴权/路由/依赖，以及未跟踪设计、配置、实现和测试文件。这些改动均不被视为已部署，也未被恢复、覆盖或清理。
- 测试阶段新增：`server/test/independent-baseline-verification.test.ts` 和本报告；未修改 `server/src`、`app/src`、`scripts` 或 `deploy` 业务/部署实现。构建产物未出现在 Git 状态中。

## 2. 覆盖范围与通过证据

| 范围 | 结果与证据 |
| --- | --- |
| 实时 JWT/权限 | 真实自行签发的七天 HS256 历史 JWT 含旧 `username`、`name`、`role`；`/api/users/me` 返回实时库字段。角色升/降、停用、删除分别即时生效；无 token、错误 token、过期 token 为 401，普通用户访问 `/api/users` 为 403。|
| 核心 API 回归 | 完整 `buildApp()` + Fastify inject：登录、`/api/users/me`、管理员列表、创建线索、列表、创建跟进、用户升降级和停用均返回原 `{ code, msg, data }` 包络。|
| 管理员初始化 | 合法密码建库；生产空库缺密码时 `buildApp()` 拒绝；短密码由配置校验拒绝；开发/测试真实随机密码可验证哈希；已有用户不重复生成/输出；日志不含密码哈希。|
| DB_PATH 与连接 | 验证默认、绝对、相对路径，导入后变更环境变量并关闭连接后生效；自动建父目录；`/dev/null/…` 不可用路径失败；`closeDb()` 后可切换独立库；应用连接 `foreign_keys=1`。|
| 迁移/数据完整性 | 空库、当前 schema 但无迁移记录、旧库缺 `memos`/`favorites`、`leads.phone NOT NULL`、旧 status CHECK、`follow_ups` 缺 `images`/`amount` 均成功；重复执行幂等、校验和冲突拒绝、故意失败迁移回滚且不写版本记录。验证记录数、主键/关系、全部 11 个相关索引、无 `leads_new`/`leads_old` 残表、`integrity_check` 和 `foreign_key_check`。|
| 外键 | 非法 follow-up 外键写入失败，合法写入成功；迁移后 `foreign_key_check=[]`。测试的独立 `DatabaseSync` 连接均显式调用连接配置并断言外键开启。|
| 启动失败 | 迁移校验和冲突和生产空库缺管理员密码都会令 `buildApp()` reject，未返回可监听的 HTTP 实例。|
| 安全/范围 | `git diff --check` 通过；限定源码、脚本、示例与 README 内未发现 `xyy123456`；`.env.example` 不含真实 secret 或密码；未发现通知、微信、DeepSeek、AI、拜访或 `sales_stage` 基线新增。`scripts/seed.ts` 中的 `Math.random()` 仅用于样本数据选择，非初始化密码。|

## 3. 已执行命令

| 命令 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过。|
| `cd server && npm test` | 通过，25/25。包括新增独立测试、原有迁移/启动失败/鉴权/公海/Excel 测试。|
| `cd app && npm run build:h5` | 通过；仅提示未配置 uni Appid，统计不可用。|
| `cd app && npm run build:mp-weixin` | 通过；同一 Appid 提示，产物可由微信开发者工具导入。|
| `cd server && npm audit --omit=dev` | 0 vulnerabilities。|
| `cd app && npm audit --omit=dev` | 0 vulnerabilities。|
| `git diff --check`、Git/源码敏感信息扫描、临时目录检查 | 通过；测试临时数据库均已清理。|

## 4. 失败项与复现

### 高：迁移没有输出版本和结果日志（验收阻断）

- 需求：迁移入口必须输出迁移版本和结果，且不得输出客户数据。
- 最小复现：对空的 `/tmp` 数据库调用 `buildApp()`，或运行 `runMigrations()`；检查启动输出及 `server/src/db.ts`。
- 预期：每个迁移至少记录版本、描述和 `applied` / `skipped` / `failed` 结果；失败只记录非敏感错误摘要。
- 实际：`runMigrations()` 只执行迁移、写入 `schema_migrations` 与检查完整性；`server/src/db.ts:239-275` 没有任何日志调用。`buildApp()` 仅在 `server/src/index.ts` 输出数据库路径，未补足迁移日志。
- 影响：迁移本身可运行且测试通过，但生产部署无法从标准启动日志审计实际执行/跳过了哪些版本，不满足明确验收项。
- 建议修复：在迁移入口注入或使用受控 logger；仅在成功提交后输出 `version`、`description`、`applied/skipped`，失败输出版本和安全错误摘要，禁止 SQL 参数、客户数据、密码或哈希；补充 applied/skipped/failed 日志测试。

## 5. 未覆盖范围与后续风险

- 未核验生产运行 commit、真实 `DB_PATH`、生产环境变量、实际备份恢复演练或真实生产库；这些不在本次授权范围内。
- 按阶段范围未测试或修改 member 读取隔离、负责人统一转移、跟进编辑/删除后的派生字段、前端“邮件”枚举、通知、微信和 AI。
- 依赖审计只覆盖生产依赖；未对开发服务器的公开风险做生产暴露验证。

## 6. 测试阶段文件变化与放行条件

- 测试阶段产生的仓库文件仅为新增独立测试和本报告。一次早期中断运行留下的两个精确 `/tmp/xiansuo-independent-*` 临时目录已删除；最终临时目录检查为空。
- 当前 `git status --short` 仍包含测试前已有的修改/未跟踪基线；未提交、推送或创建 PR。
- 允许进入验收阶段的条件：修复“迁移版本和结果日志”后，新增针对 applied、skipped、failed 三种结果的自动化测试，并重跑 `npm run build`、`npm test`。在此之前不应无条件验收或部署。

## 7. 第四阶段修复与复测（2026-07-30）

- 已为 `runMigrations()` 增加可注入 logger 和默认结构化日志。
- `applied` 在事务提交并恢复外键状态后记录；checksum 匹配记录 `skipped`；异常记录 version、description、`failed` 和不含原始错误消息的安全摘要。
- logger 自身异常被隔离，不会掩盖原迁移异常；失败版本仍不写完成记录。
- 新增 applied、skipped、failed 三类自动化测试，包含客户数据/密码/哈希样例不会进入日志事件的断言。
- 复测：`cd server && npm run build` 通过；`cd server && npm test` 28/28；H5 和微信小程序构建通过；前后端 `npm audit --omit=dev` 均为 0 vulnerabilities；`git diff --check` 通过。
- 原报告中的迁移日志放行条件已满足；其余生产环境和后续业务风险维持不变。

## 8. 补充验收：公海测试临时数据库清理

- 后续最终审计确认 `server/test/pool.test.ts` 原先直接在 `DB_PATH` 表达式内创建临时目录，`test.after()` 只关闭 Fastify，未调用 `closeDb()` 或删除目录；该问题可重复导致 `/tmp/xiansuo-pool-*` 残留。
- 修复后测试显式保存 `testDirectory`，在 after hook 中依次执行 `app.close()`、`closeDb()`、`rmSync(testDirectory, { recursive: true, force: true })`。
- 修复前记录到 14 个既有 `xiansuo-pool-*` 目录。定向公海测试 3/3 后仍为同一 14 项；完整后端测试 28/28 后再次核对，仍为同一 14 项，证明本次运行没有新增残留。
- 既有 14 个目录无法安全归因到本次验收运行，因此未删除；这与“修复后的测试不新增临时文件”分别记录。
- 补充修复后再次通过后端构建、完整测试、H5/微信小程序构建、前后端生产依赖审计和 `git diff --check`。
