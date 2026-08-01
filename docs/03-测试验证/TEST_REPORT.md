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

## 9. OpenClaw `result_unknown` 人工确认与受控重试复验（2026-08-01）

### 测试环境、基线与范围

- 工作目录：`/home/yj/xiansuo`。本轮开始时的工作区已有 OpenClaw Gateway、Worker、合成 Pilot、实现/验收报告及设计文档改动（详见下方文件基线）；这些均视为测试前已有改动，未被恢复、覆盖、暂存或提交。
- 本轮仅使用临时目录中的 SQLite Gateway 状态库、Fake Adapter 和伪造 HTTP 响应；未启动 OpenClaw、notification-worker 或 Gateway 进程，未访问真实微信/网络，未调用 DeepSeek，未打开 H5 真实服务，也未改动 `server/data`。
- 开始及结束前均执行 `git diff --check`。`server/data` SHA-256 基线与测试后结果一致：`app.db=8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2`，`app.db-shm=fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`，`app.db-wal=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- 覆盖了 Gateway 状态迁移/校验和、旧状态数据保留、审计链、目录与 DB/WAL/SHM 的基础 symlink/hardlink 防护、受控授权的单次消费、超时后的 `result_unknown`、Worker 的结果映射和合成 Pilot 隔离。未执行真实 Pilot；由于下述 P1，真实发送被明确禁止。

### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，40/40。包含内部状态迁移、控制面及超时 `result_unknown` 测试。|
| `cd server && npm run build && npm test` | 通过，137/137；其中包含迁移 007、OpenClaw Worker 映射、隐私模板、合成 Pilot 与队列边界回归。|
| `cd app && npm run build:h5` | 通过。仅有未配置 Appid 的 uni-app 统计提示；按本轮范围未构建小程序。|
| Gateway 旧状态 v1 升级、校验和篡改 | 通过：遗留 `deliveries` 中 `sent/provider_message_id` 原值保留，新增状态迁移版本为 `001`；篡改已记录 checksum 后重开被拒绝。|
| Gateway 状态目录/DB 文件安全最小复现 | 通过：上级目录符号链接及状态 DB hardlink 均在 SQLite 打开前被拒绝。|
| Fake Adapter 超时/断连 | 通过：已消费授权在 Adapter 抛错后返回 `result_unknown`，再次提交同一受控请求不再调用 Adapter。|
| `git diff --check`、`server/data` 前后哈希核对 | 通过。|

### 通过项与边界结论

- 状态库已具有迁移账本、迁移 checksum 冲突拒绝、审计 hash 链校验及人工确认/审计表的 update/delete append-only trigger。
- 受控请求在 Gateway 中会先消费授权，再进入 Adapter；无效 control 的 `deliveryRequestId` 不匹配会在 Adapter 前返回 `ILINK_PILOT_CONTROL_INVALID`。已消费且因超时形成 `result_unknown` 的同一受控请求不能再次调用 Adapter。
- Worker 将 `result_unknown` 映射为 `failed`、`retry_allowed=0` 和 `OPENCLAW_SEND_RESULT_UNKNOWN`；OpenClaw Channel 对 timeout、断连、非 JSON/bare 5xx 采用未知结果而不是自动重发。迁移 007 与 Mock 回归由后端全量测试覆盖。
- Gateway 测试的绿色结果不能替代下面两条独立对抗复现：现有测试没有覆盖“已烧毁键通过普通 deliveries 接口”的路径，也没有覆盖人工确认与未知技术结果的强关联及终态语义。

### 失败项与最小复现

#### P1-1：人工确认未绑定真实 `result_unknown`，且历史 `confirmed_not_received` 可在后续确认已收到后仍授权新代

- 预期：只有已经存在、已结束且技术状态为 `result_unknown` 的旧幂等键，才能追加一次与该未知结果绑定的人工确认；只有当前/最终人工结论为 `confirmed_not_received` 才能准备下一代。`confirmed_received`、`inconclusive` 或无未知结果均不得产生新一代。
- 实际：`StateStore.recordManualConfirmation()` 直接向 `manual_delivery_confirmations` 插入任意 64 位 hash，未查询 `delivery_attempts`。最小离线复现：新建私有临时状态目录后调用 `recordManualConfirmation('a'.repeat(64), 'confirmed_not_received', process.getuid(), 1)`，调用成功且 `verifyAuditChain()` 通过，输出 `{"confirmationWithoutUnknownAccepted":true}`。
- 进一步复现：创建/消费 generation 1 并以 `result_unknown` 结束，先追加 `confirmed_not_received`，再追加 `confirmed_received`；`prepareGeneration()` 仍成功创建 generation 2，输出 `{"generationAfterLaterConfirmedReceivedAllowed":true}`。根因是查询“是否曾有” `confirmed_not_received`，而非验证唯一、绑定且最终的人工结论。
- 影响：操作员可对任意键伪造“未收到”，或在已确认收到后继续重新发起，破坏人工确认闭环及重复发送的强制人工门禁。
- 建议修复：把人工确认写入限制为对应 `delivery_attempts.technical_status='result_unknown'` 的唯一终态事实，并以外键/受控事务绑定 `delivery_request_id`；拒绝无匹配未知结果、重复/矛盾确认。下一代准备必须校验父代已关闭、前一代键一致、唯一最终确认是 `confirmed_not_received`，且父代/新代均未被取消、过期或复用。

#### P1-2：已烧毁的旧幂等键可绕过 Pilot 控制面，直接触发 Adapter

- 预期：legacy 或旧 generation 的所有已烧毁幂等键，均不能通过普通 `/deliveries` 路径再次进入 Adapter；无 `pilotControl` 不应成为绕过预留键的方式。
- 实际最小复现：在临时私有状态库调用 `burnLegacyKey('legacy-burn-bypass-key-123', uid, now)`；随后以同一键构造普通 Gateway 请求（无 `pilotControl`），使用 Fake Adapter 调用 `GatewayService.deliver()`。输出为 `{"status":"sent","adapterCalls":1}`。
- 根因：`reserved_idempotency_keys` 由 `burnLegacyKey()` 写入，但 `GatewayService`/`IdempotencyStore.acquire()` 只查询 `deliveries`，没有在首次 acquire 前拒绝已预留且非当前受控授权的 key。
- 影响：旧键“永久烧毁”承诺失效；调用者可跳过 prepare/authorize/consume 的控制面，存在重复或未经人工确认发送的直接路径。
- 建议修复：在同一 SQLite `BEGIN IMMEDIATE` 事务内，将“键预留来源、generation/authorization 绑定、delivery acquire”合并为不可绕过的状态转换；普通路径必须拒绝 `legacy`/`generation` 预留键，且非受控请求不能使用 synthetic/历史键。新增覆盖 legacy、sent、explicit_failure、result_unknown、cancelled/expired 等所有旧键状态的 Adapter 调用次数为零断言。

### 未覆盖范围、修复后必须补充的验证

- 尚未以独立自动化测试完整覆盖 DB/WAL/SHM 的每一种 owner、mode、realpath 与损坏组合，以及 CLI 的 UID/live=false/进程探测、stdin 与私钥文件 owner/argv secret 矩阵；本轮只验证了关键 symlink/hardlink 和现有测试覆盖的 0700/0600 分支。
- 尚未对 Worker 的每个 fetch 分支（超时、上游 abort、disconnect、非法 JSON、bare 5xx）逐一作黑盒入库断言；代码与全量回归显示它们映射到 `result_unknown`，但必须在修复 P1 后增加独立的 channel + outbox 端到端测试，断言日志事件、`failed`、`retry_allowed=0` 与同键零重发。
- 未运行真实单用户 Pilot，未调用真实 Gateway、OpenClaw、微信或 DeepSeek；这不是通过项，也不得因测试绿而视为可实况发送。

### 测试阶段产生的变化与放行结论

- 本测试阶段仅修改本报告；未修改 `app/src`、`server/src`、`scripts` 或 `deploy`。构建未产生新的 Git 状态条目。开始时已有的改动仍为：`docs/02-开发实现/CHANGELOG.md`、OpenClaw 测试/验收/Pilot 报告、Gateway `package.json` 与 `src/*`、Server Worker/Channel/合成 Pilot 及测试，以及未跟踪的设计与 Gateway 控制面文件；未对其清理或归因。
- 严重级别统计：**P1=2，P2=0，P3=0**。尽管后端、Gateway、H5 回归均通过，两个 P1 直接违反 `result_unknown` 人工确认和旧键永久烧毁的高风险验收条件。
- **不允许进入验收或真实 Pilot（NO-GO）**。修复两项 P1、补足上述防回归测试并重跑 Gateway/Server/H5/`git diff --check`、核对 `server/data` 哈希后，才可重新进行独立测试评估；届时仍须先获得所有自动化测试与验收通过，才考虑最多一条的离线隔离实况验证。

## 10. OpenClaw `result_unknown` 修复复验草案（2026-08-01，等待 P2/P3 修复）

### 已关闭的原 P1

- 无任何 `result_unknown` attempt 的 hash 调用 `recordManualConfirmation(..., 'confirmed_not_received', ...)` 已拒绝；离线复验输出 `noUnknown:true`。
- 同一未知 attempt 的人工确认现为一次性终态：`confirmed_received` 与 `inconclusive` 均拒绝 prepare 下一代，冲突的第二次确认均被拒绝；仅 `confirmed_not_received` 允许准备下一代。离线复验输出：`received={prepare:false,conflicting:true}`、`inconclusive={prepare:false,conflicting:true}`、`notReceived={prepare:true,conflicting:true}`。
- 已烧毁 legacy key、尚未受控消费的 generation key，普通无 `pilotControl` Gateway 请求均为 `ILINK_IDEMPOTENCY_KEY_BURNED` 且 Fake Adapter 调用数为零。普通 delivery key 首次 `sent`、重复为 `deduplicated`，第二次 Adapter 增量调用为零。
- 同一个受控 generation 的两个并发请求结果为 `sent` 与 `ILINK_PILOT_AUTHORIZATION_INVALID`，Fake Adapter 总调用数为一，证明授权消费在 Adapter 之前且只成功一次。
- Gateway `npm run build && npm test`：42/42 通过；H5 `npm run build:h5`：通过；后端第二次完整 `npm test`：137/137 通过。首次完整后端运行曾为 136/137，原因见 P3，不能从记录中删除。

### P2：同一 attempt 可重复写入相互矛盾的终态审计事件

- 最小复现：创建并消费一个受控 generation；先调用 `finalizeAttempt(deliveryId, 'result_unknown', ..., 'FIRST', 4)`，再调用 `finalizeAttempt(deliveryId, 'sent', 'SECOND', ..., 5)`。
- 实际：第二次调用未抛错，`delivery_attempts` 行仍保留第一次的 `technical_status='result_unknown'`、`error_code='FIRST'`，但 `pilot_audit_events` 中出现两条 `attempt_finalized` 事件。复现输出：`{"secondRejected":false,"attempt":{"technical_status":"result_unknown","error_code":"FIRST","completed_at":4},"terminalAuditEvents":2}`。
- 预期：同一 attempt 只能有一个终态与一条相符的终态审计事件；重复 finalize 必须拒绝或明确作为无状态变化的审计事件，不能附带矛盾结果。
- 影响与建议：P2。当前 Gateway 正常流程通常只调用一次，但可审计性与状态机“每 attempt 唯一终态”不成立；应以 `UPDATE ... WHERE technical_status='in_flight'` 的 `changes` 为门禁，在 changes 为零时拒绝且不 append `attempt_finalized`，并补重复/并发 finalize 断言。

### P3：合成 Pilot 密封门禁测试存在随机漏检

- 首次 `cd server && npm run build && npm test` 结果为 136/137，失败于 `test/openclaw-synthetic-pilot.test.ts:195`，断言预期 `CONTROL_UNSAFE` 却未抛出；单文件重跑 9/9，随后全量重跑 137/137。
- 根因：测试使用 `manifest_hash='0' || substr(manifest_hash,2)` 制造篡改；当随机生成的原 SHA-256 恰好以 `0` 开头时，赋值结果不变（约 1/16），因此未触发门禁。该失败可由源码和首次完整运行直接复现，不能按稳定通过处理。
- 影响与建议：P3 测试可靠性问题，但会掩盖密封控制数据篡改路径；应固定写入一个保证不同的 64 位合法 hash 或翻转确定字符，消除随机性。

### 草案结论

- 当前统计：**P1=0、P2=1、P3=1**。根据主代理指示，这两项修复前仍为 **NO-GO**，不得进入验收或真实 Pilot。
- 本轮没有启动真实 OpenClaw/Worker/Gateway 进程，没有网络、微信或 DeepSeek 调用；测试临时目录已清理。测试阶段唯一新增修改为本报告内容，所有其他工作区改动均在本轮开始前已存在。

## 11. OpenClaw `result_unknown` 最终独立复验（2026-08-01）

### P2/P3 修复验证

- `finalizeAttempt()` 现只允许 `in_flight → 终态` 的一次状态转换。独立临时状态库复现：第一次以 `result_unknown/FIRST` 结束后，重复以 `sent/bad` 结束被拒绝 `ILINK_ATTEMPT_ALREADY_FINALIZED`，`attempt_finalized` 审计事件数为 1。并发重复调用亦由新增 Gateway 测试覆盖并全部拒绝。
- 合成 Pilot 的 manifest 篡改测试改为确定性翻转首字符（`0` 与 `1` 互换），不会再出现 hash 原首字符为 `0` 而未改变值的随机漏检。最终完整 Server 测试通过，包含该密封门禁路径。

### 核心 P1 最小复验

- 无 `result_unknown` 的人工确认拒绝：`missingUnknown:true`。
- 已确认收到的 attempt：冲突确认拒绝，且不能 prepare 新 generation：`conflicting:true`、`receivedPrepare:false`。
- 已烧毁 legacy key 及未受控消费的 generation key 在普通 Gateway 路径均返回 `ILINK_IDEMPOTENCY_KEY_BURNED`；Fake Adapter 不被调用。
- 同一受控 generation 并发两次请求结果为 `sent` 和 `permanent_failure:ILINK_PILOT_AUTHORIZATION_INVALID`，Fake Adapter 总调用数为 1。

### 最终命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，43/43。|
| `cd server && npm run build && npm test` | 通过，137/137。|
| `cd app && npm run build:h5` | 通过；仅有未配置 Appid 的统计提示。|
| `git diff --check` | 通过。|
| `server/data` SHA-256 前后核对 | 一致；`app.db`、WAL/SHM、备份和其他数据文件均未被测试改动。|

### 最终结论与剩余范围

- 严重级别：**P1=0、P2=0、P3=0**。第 9、10 节中的失败为历史复现记录，均已由本节的独立复验关闭。
- **允许进入验收阶段（代码验收放行）**。条件是验收阶段继续保持所有真实开关关闭；不得把本结论解释为真实微信 Pilot 已通过。
- 未执行真实 Pilot、未启动真实 OpenClaw/Worker/Gateway、未访问网络/微信/DeepSeek；真实单条测试仍必须由验收阶段在既定的独立账号、隔离数据库与人工停止条件下单独授权和记录。
- 本阶段只更新本报告；未修改业务源码、未提交、未推送。开始时已有的 OpenClaw 实现/测试/文档差异仍保留，未被清理或归因为测试改动。

## 12. 验收新增范围复验草案（2026-08-01，等待 CLI P2 修复）

### 已通过的新增闭环

- 临时私有状态库中，`legacy-import` 写入 generation 1 的已关闭 `result_unknown` attempt；仅在 `confirmed_not_received` 且 `actualReceivedCount=0` 后才可为同一 `runId` prepare generation 2。独立结果依次为：`legacy_result_unknown_imported`、`manually_confirmed_not_received`、`prepared`、`execution_authorized`。
- legacy key 和未授权的 generation 2 key 走普通 Gateway 路径均为 `ILINK_IDEMPOTENCY_KEY_BURNED`；deliveryId/control 不一致为 `ILINK_PILOT_CONTROL_INVALID`；有效 control 仅首次 `sent`，复用返回 `ILINK_PILOT_AUTHORIZATION_INVALID`，Fake Adapter 总调用数为 1。
- UID 不匹配、live=true、检测到 worker 进程、相对 key 路径及 key 文件改为 0644 均被拒绝；CLI 常规结果仅输出截断 hash，不含原始 key。Synthetic CLI 的 generation/lineage/control、0600 key file 或 stdin、`max_attempts=1` 和密封 manifest 路径均由后端 138/138 回归覆盖。
- Gateway 43/43、Server 138/138 和 H5 构建均通过；未执行真实服务或网络调用。

### P2：Pilot-control CLI 忽略未知 argv，允许秘密误入进程参数

- 最小复现：在合法临时私有 Gateway 配置下调用 `runPilotControlCli(['node','pilot-control.js','reconcile','--operator-uid', uid, '--idempotency-key', 'argv-secret-value'])`。
- 实际：调用成功并返回 `{"status":"reconciled","audit":"valid"}`，未知 `--idempotency-key` 未被拒绝。虽然其值未被用作实际 key，调用者仍会把秘密暴露给进程列表，违背 key 只来自 0600 文件或 stdin、不得通过 argv 传递 secret 的边界。
- 建议：与 synthetic CLI 一致，建立 command-specific 严格 flag 白名单，拒绝未知、重复和缺值 flag；为该复现补自动化测试。

### 草案结论

- 当前：**P1=0、P2=1、P3=0，NO-GO**。本节是验收范围新增改动的草案；P2 修复并完成独立回归前不得执行真实 Pilot 或给出最终验收放行。

## 13. 验收新增范围最终独立复验（2026-08-01）

### CLI P2 修复验证

- 原始复现 `reconcile --operator-uid <uid> --idempotency-key argv-secret-value` 现被严格拒绝 `ILINK_PILOT_CLI_USAGE`。
- 独立白名单矩阵均按预期拒绝：未知 key argv、重复 flag、缺失 value、位置参数、命令不允许的 `--stdin`、把 key 跟在 `--stdin` 后以及同时给出 stdin/key-file。唯一合法的非文件来源是实际 stdin；对应 `prepare ... --stdin` 成功。
- Gateway 内置测试新增 command-specific flag allowlist 覆盖，并通过 44/44。

### 新增范围闭环与回归证据

- legacy import 在临时私有状态库登记 generation 1 的 `result_unknown` 事实；`confirmed_not_received` 且实际收到数为 0 后，generation 2 才可 prepare/authorize。legacy key、无 control generation key、delivery/control 不一致、已消费 authorization 均不会调用 Fake Adapter；有效 generation 2 控制面恰好一次发送。
- UID、live、进程检测、相对路径和非 0600 key 文件拒绝；CLI 输出只含截断 hash，不含原始 key。Synthetic CLI 的显式 generation/lineage/control、key 文件或 stdin、`max_attempts=1` 及密封 manifest 由后端回归覆盖。
- `cd poc/ilink-gateway && npm run build && npm test`：44/44；`cd server && npm run build && npm test`：138/138；`cd app && npm run build:h5`：通过。
- `git diff --check` 通过；`server/data` 全部 SHA-256 与本轮开始前一致。没有真实 OpenClaw、Worker、Gateway、微信、网络或 DeepSeek 调用。

### 最终结论

- 严重级别：**P1=0、P2=0、P3=0**。第 12 节 P2 为历史复现，已由本节关闭。
- **允许进入最终验收阶段（代码验收放行）**，但不等同于真实微信 Pilot 已执行或放行。真实单条 Pilot 仍须由验收阶段在独立账号、隔离数据库和人工停止条件下单独授权、执行并记录。
- 测试阶段仅更新本报告；没有提交、推送、真实发送或修改业务实现。工作区其他 OpenClaw 实现、测试与文档改动均是测试开始前已有或实现方后续新增，未被本测试阶段清理或覆盖。
