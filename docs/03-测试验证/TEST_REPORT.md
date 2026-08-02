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

## 14. OpenClaw 轻量级多人接收人映射：测试计划（2026-08-01）

本节先记录本次独立验证计划，随后执行离线验证。范围为 Gateway 的接收人映射配置与投递前拒绝路径；不启动真实 OpenClaw、Gateway 或 Worker，不访问外网、微信、DeepSeek 或业务数据库。

- 配置与安全：验证 JSON 对象根、规范正整数用户键、空映射、最多 50 项、绝对且仓库外的 0600 常规文件，以及链接、相对路径、权限、格式和数量的拒绝。
- 路由与拒绝：以内存 Fake Adapter 验证不同系统用户映射到各自 target、未绑定与 disabled 均在 Adapter 调用前拒绝、map 优先覆盖旧单用户值、无 map 时兼容旧单用户值。
- 生命周期与泄露：验证映射仅在启动时加载，health/日志/deprecated warning 不输出完整 target。
- 回归：执行 Gateway 构建、现有 Gateway 测试与 `git diff --check`；复核成功 messageId、`result_unknown`、幂等和 HMAC 路径。检查本次差异未涉及 server、迁移、H5 或依赖清单。

## 15. OpenClaw 轻量级多人接收人映射：独立验证结果（2026-08-01）

### 环境与开始前基线

- 工作区开始时已有实现差异：根与 deploy 环境示例、Gateway PM2 示例、OpenClaw 实现/Runbook/Changelog 文档，以及 `poc/ilink-gateway` 的 `.env.example`、`src/config.ts`、`src/gateway-service.ts`、`src/server.ts`、`test/gateway.test.ts`。本测试阶段没有恢复、覆盖或清理任何这些差异。
- `git diff --name-only` 未包含 `server/`、迁移文件、`app/`、锁文件或依赖清单；因此本次仅执行受影响 Gateway 验证，未运行无关的 Server/H5 构建。
- Gateway 自动化测试和独立脚本只使用临时私有目录、Fake Adapter 与临时 SQLite 状态库；临时产物均已删除。没有访问 `server/data` 或业务数据库。

### 已执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，46/46。|
| 离线 Node Fake Adapter 映射矩阵 | 通过：多用户路由、未绑定/禁用提前拒绝、静态加载、旧单用户兼容、配置拒绝及脱敏检查均通过。|
| `git diff --check` | 通过。|

### 覆盖与证据

- 映射文件仅接受 JSON 对象根、规范正整数且安全的系统用户 ID 键、严格 `{target, enabled}` 值；数组、非规范键、51 项、错误权限、相对路径、仓库内路径和符号链接均被拒绝。实现以 `realpath`、`lstat` 和精确 `0600` 检查保证映射文件为仓库外普通文件。
- 静态 Fake Adapter 复测了两个启用用户的不同 target 路由；`enabled=false` 返回 `OPENCLAW_RECIPIENT_DISABLED`、未绑定返回 `OPENCLAW_RECIPIENT_NOT_BOUND`，两种路径均未增加 Adapter 调用数。
- 映射模式优先于旧单接收人值；修改映射文件后的同一已加载 Gateway 仍投递到启动时快照。未配置映射时，旧单用户仍可投递，其他用户继续返回 `OPENCLAW_RECIPIENT_NOT_ALLOWED`。
- `GatewayService.health()` 和 deprecated warning 均不包含完整 target；启动/CLI 仅输出同一脱敏 warning 文本。源码检查未发现把映射内容写入 health 或日志的路径。
- 46 项回归同时覆盖 HMAC 规范签名、HTTP 认证/重放、幂等与并发、`result_unknown`、严格 OpenClaw 成功响应与 provider messageId；均无回归。

### 未覆盖范围、严重级别与结论

- 按本轮边界，未启动真实 OpenClaw、Gateway、Worker 或微信，不访问外网、DeepSeek 或业务数据库；因此不把本结论解释为真实发送或 Pilot 验证。
- **P1=0、P2=0、P3=0。允许提交并进入后续代码验收。**
- 本测试阶段新增的工作区变化仅为本报告第 14、15 节；实现、测试、文档和配置改动均为测试开始前已存在的待验证差异。

## 16. OpenClaw owner_changed 详细脱敏通知与 no-reply 插件：测试计划（2026-08-02）

本节先记录本次独立验证计划。测试仅使用现有自动化测试、离线假运行时、临时目录和临时数据库；不启动真实 OpenClaw/微信/Gateway/Worker，不访问外网、DeepSeek 或业务数据库。

- 服务端：核对真实 `leads` 字段来源，验证 owner_changed 快照在入队时脱敏、Worker 仅使用快照不重读可变线索数据；覆盖字段缺失、长度、换行/控制字符、手机号、微信号、凭证和固定消息顺序。
- Gateway：验证详细消息白名单与结构拒绝，包含标题、顺序、重复/额外字段、长度、全手机号和结构/控制字符注入；复核 Fake Adapter 恰好一次、HMAC、幂等、sent/messageId 与 `result_unknown`。
- 插件：核对 manifest、受控安装说明、官方 `before_agent_reply` 钩子与版本化入站顺序证据；以离线 Provider 验证微信渠道的“已收到”、绑定文本和普通文本均 `handled=true`、无回复、Provider 调用为零，其他渠道透传且不读取正文。
- 回归与范围：运行 Server/Gateway 构建和测试、`git diff --check`；检查无迁移、依赖、H5 或业务数据库文件变更，并在报告中记录结果、遗留范围和严重级别。

## 17. OpenClaw owner_changed 详细脱敏通知与 no-reply 插件：独立验证结果（2026-08-02，NO-GO）

### 基线与范围

- 开始前未提交实现差异位于 Server 通知快照/Worker/OpenClaw channel 及其测试、Gateway message policy/测试、仓库内 no-reply 插件和相关实现/运行文档。未见迁移、依赖清单、锁文件、`app/` 或 `server/data` 差异。
- 本阶段只新增本报告第 16、17 节；未恢复、覆盖或清理实现方已有改动。自动化测试创建的均为临时数据库/目录，未访问业务数据库。

### 已执行命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | 构建通过，140/140 测试通过；仅使用测试临时库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 构建通过，49/49 测试通过；未执行真实 CLI。|
| 离线最小复现：owner 快照和 Gateway policy | 发现 P1/P2，详见下文。|
| 本机已安装源码静态核验 | 确认为 OpenClaw `2026.7.1-2`、`@tencent-weixin/openclaw-weixin` `2.4.6`；未执行其二进制。|

### 已通过项

- `captureOwnerChanged()` 查询实际 `leads.company_name/contact_name/phone/source/demand_note/next_follow_at`，在入队时形成 `message_snapshot_json`；Worker 对 owner_changed 只解析此快照生成消息，不重新查询这些可变业务字段。现有回归还验证入队后更改公司/电话不会改变已存快照。
- 正常字段的固定标题、顺序、尾句、长度（客户 30、联系人 20、来源 20、需求 80）、控制字符/换行清理、手机号掩码和缺少跟进时间时“请尽快联系”均存在。Gateway 正常结构还校验固定标题、字段顺序、重复/额外字段、非法 detail URL、控制字符、结构注入和联系方式掩码；Fake Adapter 正常路径恰好调用一次。
- HMAC、重放、幂等、`sent/messageId`、`result_unknown` 和旧多接收人映射回归均随 Gateway 49 项测试通过。
- no-reply 插件只读取 `context.messageProvider`，仅精确匹配 `openclaw-weixin`，返回无 `reply` 的 `{handled:true}`；其他渠道返回 `undefined`。离线 Hook 矩阵对“已收到”、绑定文本和普通文字均无回复。插件 manifest 为本地原生插件，无新增依赖；仓库和文档只提供受控 `--link` 安装步骤，默认不安装，也未改动上游源码。
- 安装的微信插件 `process-message.ts` 显示 `recordInboundSession` 后调用 `setContextToken`，其后才 `dispatchReplyFromConfig`；安装的 OpenClaw host 在 dispatch 内先执行 `before_agent_reply`，`handled` 时返回 `NO_REPLY`，位于模型调用前。版本化夹具顺序与源码一致：`recordInboundSession → setContextToken → dispatch → before_agent_reply → model_call`。

### 失败项

#### P1：敏感微信标识和完整手机号仍可绕过出站保护

- 最小复现 1：调用 `ownerChangedMessageSnapshot()`，使可选需求文本包含“微信：<标识>”。实际生成的 body 仍包含该微信字段标记；原因是服务端 `ownerDetailForbidden` 只匹配“微信号”或 `wxid`，不匹配常见“微信：”。这会写入 outbox 快照并可发送至微信。
- 最小复现 2：对 Gateway `assertMessagePolicy()` 提交结构合法的 owner_changed body，但在“客户”“来源”或“需求”行放置完整 11 位手机号；实际均被接受。当前 Gateway 只为“联系方式”行校验掩码，未对其他字段拒绝完整手机号。
- 预期：任何微信号标签/标识和完整手机号均不得进入 outbox 快照或 Gateway 投递契约。
- 建议：服务端与 Gateway 统一采用更宽的微信字段/标识拒绝策略，并对每个可见字段扫描完整手机号；补齐服务端快照与 Gateway policy 的双重回归断言。修复前不得提交或进入验收。

#### P2：缺失联系人未按要求省略，反而中断负责人变更通知捕获

- 最小复现：调用 `ownerChangedMessageSnapshot()`，将 `contact_name` 设为空字符串、其他必需业务值合法。
- 实际：抛出 `OWNER_CHANGED_CONTACT_INVALID`。
- 预期：按本轮明确要求，缺少联系人、手机号或跟进时间时应省略可选字段（跟进时间降级为“请尽快联系”），不应因联系人缺失而生成失败。
- 建议：将联系人与其他展示字段按已批准的缺项策略处理，并补空联系人、空手机号、空跟进时间的 outbox/Worker/Gateway 断言。

### 结论与未覆盖范围

- **P1=1、P2=1、P3=0；不允许提交，不允许进入验收或真实 Pilot。** 自动化测试全绿不能覆盖上述可复现的敏感数据和降级语义缺口。
- 本轮未启动真实 OpenClaw、Gateway、Worker 或微信；未访问网络、DeepSeek 或业务数据库。因此 no-reply 结论为安装源码与离线 Hook 合约验证，不构成真实会话验证。

## 18. OpenClaw owner_changed 详细脱敏通知与 no-reply 插件：修复后独立复测（2026-08-02）

### P1/P2 复测闭环

- 原“微信：”标识复现已关闭：服务端快照和 Gateway policy 现共同拒绝/省略微信号、微信 ID、`wxid`、`wechat`、`weixin`、`vx`、`v信` 等带值标识；离线复测确认这些值不进入快照，Gateway 也拒绝结构合法但含该值的正文。
- 原“非联系方式字段完整手机号”复现已关闭：服务端对展示字段内的中国大陆手机号先掩码，Gateway 对客户、联系人、来源、需求和联系方式逐字段扫描未掩码号码。离线复测覆盖纯数字、`+86`、空格/连字符变体，均未保留完整手机号或被 Gateway 拒绝。
- 原“缺联系人”复现已关闭：`contact_name=null` 或空白时不再抛错；缺联系人、手机号、`next_follow_at` 时生成仅含合法来源、固定跟进降级和固定尾句的快照。合法来源“微信咨询”被保留，未被过度过滤。
- 独立结构矩阵覆盖控制字符、CR/LF 注入、字段超长、重复字段、乱序、额外字段和错误标题，Gateway 均拒绝；最小合法详情仍通过，Fake Adapter 仍恰好一次。

### 回归和 Hook 证据

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | 通过，140/140；仅使用测试临时库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，49/49；无真实 OpenClaw 调用。|
| 独立 no-reply 处理器 Proxy 测试 | 通过：三个微信文本均返回无 reply 的 handled 结果，事件正文 Proxy 零次读取，其他渠道透传；版本夹具顺序不变。|
| `git diff --check` | 通过。|

### 最终结论

- 第 17 节 P1/P2 为保留的首次失败历史，均已由本节独立复测关闭：**P1=0、P2=0、P3=0。允许提交并进入后续代码验收。**
- 未发现迁移、依赖、H5 或业务数据库文件变化；本测试阶段除本报告第 16 至 18 节外没有修改工作区文件。
- 未启动真实 OpenClaw、Gateway、Worker 或微信，未访问网络、DeepSeek 或业务数据库；本结论不构成真实 Pilot 放行。

## 19. Unicode 与受控插件安装增量复核：测试计划（2026-08-02）

- 服务端：以 Cc、Cf、Zl、Zp 代表字符验证 owner_changed 展示字段被规范化，且不会保留不可见/双向控制字符。
- Gateway：对同一四类 Unicode 字符的详情正文验证失败关闭；正常 LF 模板结构仍可通过。
- 文档与安装边界：检查仓库内插件 README 与运行手册不含 `--force`，并明确 `allowConversationAccess` 后，官方 runtime inspect 必须返回 `hookCount=1`、`before_agent_reply` 与零 diagnostics。
- 回归：运行受影响 Server/Gateway 构建和测试及 `git diff --check`；不启动 daemon 或真实渠道。

## 20. Unicode 与受控插件安装增量复核：最终补充（2026-08-02）

### 增量结果

- 独立 Unicode 矩阵覆盖 `Cc`、`Cf`、`Zl`、`Zp` 的代表字符。服务端 owner_changed 快照将四类字符规范化为空白并折叠，产物不保留该四类字符；Gateway 对同类输入正文全部失败关闭。合法的固定 LF 分行模板仍可通过。
- 插件 README 与运行手册中的两条实际 `openclaw plugins install --link ...` 命令均不含 `--force`；文本同时明确禁止该参数。两份文档都要求先启用 `allowConversationAccess`，再用官方 runtime inspect 验证 `hookCount=1`、`typedHooks` 含 `before_agent_reply` 且 diagnostics 为零。
- 主代理已在临时隔离 OpenClaw state/config 上完成上述受控安装流程的实测且未启动 daemon；本测试代理未重复该实况操作。本代理仅完成文档和离线契约复核。

### 命令与结论

| 命令/检查 | 结果 |
| --- | --- |
| Unicode 独立 Node/TS 断言 | 通过。|
| 安装文档命令结构化检查 | 通过。|
| `cd server && npm run build && npm test` | 通过，140/140。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，49/49。|
| `git diff --check` | 通过。|

- **P1=0、P2=0、P3=0；允许提交并进入后续代码验收。**
- 本节未引入业务代码改动；未启动 daemon、真实 OpenClaw/Gateway/Worker 或微信，未访问网络、DeepSeek 或业务数据库。第 17 节失败保持为历史记录，已由第 18、20 节复测关闭。

## 21. owner_changed astral emoji/body 上限：测试计划（2026-08-02）

- 验证 owner snapshot body schema 上限与 Gateway 实际可达上限对齐为 500 UTF-16 code units，单字段 code-point 限制不变。
- 用 80 个 astral emoji 需求字段验证服务端截断、快照解析和 Gateway 投递 policy 均接受；用 81 个验证 Gateway 拒绝。
- 回归执行 Server、Gateway 构建/测试及 `git diff --check`；不启动真实服务或渠道。

## 22. owner_changed astral emoji/body 上限：最终复测（2026-08-02）

### 边界验证结果

- `owner_changed` 快照 schema 的 `body` 上限已为 500 个 UTF-16 code units；Gateway 的 `body` policy 同为 500。客户、联系人、来源和需求四个单字段的既有 code-point 上限仍分别为 30、20、20、80，未放宽。
- 独立 TypeScript 断言以 80 个 astral emoji（`😀`）作为需求字段输入：服务端生成快照的需求行恰为 80 code points，整体正文不超过 500 UTF-16 code units；`parseNotificationSnapshot()` 可解析，Gateway `assertMessagePolicy()` 可接受。
- 同一结构将需求替换为 81 个 astral emoji 后，Gateway 以 `ILINK_MESSAGE_POLICY_REJECTED` 拒绝。该验证覆盖了服务端快照、快照解析与 Gateway 发送前 policy 的共同可达边界。

### 已执行命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| 独立 TypeScript astral 边界断言 | 通过：80 emoji 快照解析及 Gateway 接受；81 emoji Gateway 拒绝。|
| `cd server && npm run build && npm test` | 通过，141/141；仅使用测试临时库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，49/49；未执行真实 OpenClaw CLI 或网络调用。|
| `git diff --check` | 通过。|

### 最终结论

- **P1=0、P2=0、P3=0。** owner_changed 的 astral emoji 正常边界与超限拒绝均符合本轮要求，允许提交并进入后续代码验收。
- 本轮不构成真实 Pilot 放行：未启动 daemon、真实 OpenClaw/Gateway/Worker 或微信，未访问网络、DeepSeek 或业务数据库。
- 本测试阶段新增的工作区变化仅为本报告第 21、22 节；其余未提交实现和文档差异均为测试开始前已存在的基线差异。

## 23. OpenClaw detail URL 与 next_follow_at 格式：测试计划（2026-08-02）

- 验证 OpenClaw Channel 将 owner_changed 的相对快照路径转换为固定、无 token 的 H5 URL；Mock 保持使用自己的相对 `detailPath` 路径。
- 验证真实 API 写入 `YYYY-MM-DD` 的 `next_follow_at` 后，负责人变更 outbox 正文输出 `YYYY-MM-DD前`，不得虚构 `00:00`；带秒 datetime 输出到分钟。
- 验证 Gateway 仅接受日期前缀或精确到分钟的跟进格式，并拒绝秒、非法时分及非日历日期等绕过输入。
- 回归运行 Server、Gateway 构建和测试，以及 `git diff --check`；全程不启动 daemon、真实 Gateway/Worker 或微信。

## 24. OpenClaw detail URL 与 next_follow_at 格式：最终独立复核（2026-08-02）

### 通过项

- OpenClaw Channel 的离线 `fetch` 截获测试实际调用 `send()`，输入 owner_changed 相对路径 `/pages/leads/detail`，断言 Gateway 请求中的 `detailUrl` 为固定 `https://xs.tomatopia.top/`。该 URL 无 token；Worker 的 Mock 分支仍单独将原始快照 `detailPath` 传给 `MockNotificationChannel`，未被此映射改写。
- API 日期输入覆盖真实 `PATCH /api/leads/:id` 写入 `next_follow_at='2026-08-04'`，再执行负责人变更并读取 outbox。断言正文为 `跟进要求：2026-08-04前`，且不含虚构的 `00:00`。datetime 输入 `2026-08-02 09:30:45` 的快照断言输出为 `2026-08-02 09:30前`，秒被安全省略。
- Gateway 现有 policy 测试覆盖并拒绝带秒（`2026-08-02 09:30:00前`）和非法时分（`2026-08-02 29:30前`）；两种正常形态 `YYYY-MM-DD前` 与 `YYYY-MM-DD HH:mm前` 均有接受断言。

### 失败项

#### P2：Gateway 对不存在的日历日期未 fail-closed

- 最小复现（离线、无真实网络）：在 `poc/ilink-gateway` 运行 `npx tsx -e`，向 `assertMessagePolicy()` 提交合法 owner_changed 固定结构，仅分别使用 `跟进要求：2026-99-99前` 和 `跟进要求：2026-02-30 09:30前`。
- 预期：Gateway 只允许业务系统可能生成的有效日历日期或精确到分钟的有效 datetime，以上两项均应抛出 `ILINK_MESSAGE_POLICY_REJECTED`。
- 实际：两项都被接受；当前正则只约束位数和时分范围，未验证月份、日期以及月份天数。
- 影响：尽管 Server 的 `safeFollowAt()` 会拒绝这些值，Gateway 作为隔离边界仍可被已签名但结构异常的请求绕过“仅系统生成结构”约束，未满足 fail-closed 要求。
- 建议修复：Gateway 对日期/分钟 datetime 使用不归一化的日历校验（解析后与原年/月/日/时/分逐项一致），并增加四组拒绝断言：月 00/13、日 00/32、非闰年 2 月 29、2 月 30；修复后重跑本节命令。

### 命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| Gateway 日期最小复现 | 正常日期/分钟形态通过；秒和非法时分拒绝；`2026-99-99前`、`2026-02-30 09:30前` 被错误接受。|
| `cd server && npm run build && npm test` | 通过，143/143；测试只使用临时数据库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，49/49；未执行真实 OpenClaw CLI 或网络调用。|
| `git diff --check` | 通过。|

### 结论

- **P1=0、P2=1、P3=0；不允许以“Gateway 严格只允许系统生成的两种跟进格式”为由进入无条件验收或真实 Pilot。** 需先关闭本节 P2 并独立复测。
- 本轮仅新增本报告第 23、24 节；未修改业务实现。未启动 daemon、真实 OpenClaw/Gateway/Worker 或微信，未访问网络、DeepSeek 或业务数据库。

## 25. Gateway 日历 fail-closed 与 no-reply fake pipeline：测试计划（2026-08-02）

- 直接验证 Gateway 拒绝不存在月份、日期、非闰年 2 月 29，接受闰年 2 月 29；确认 UTC 组件回检未引入时区归一化绕过。
- 验证 no-reply 的非真空 fake pipeline：Hook 前会话/target 已保存，微信入站被 `handled` 后不进入 provider/reply，Hook 不读取入站正文；其他渠道则透传到 provider。
- 运行 Server、Gateway 构建和全部离线测试以及 `git diff --check`；不进行任何真实 OpenClaw/微信操作。

## 26. Gateway 日历 fail-closed 与 no-reply fake pipeline：最终独立复验（2026-08-02）

### P2 闭环与 no-reply 验证

- 第 24 节 P2 已关闭：Gateway 以 UTC 年/月/日/时/分组件逐项回检日期，避免 `Date` 溢出归一化和本机时区造成放行。独立断言确认 `2026-99-99前`、`2026-02-30 09:30前`、`2027-02-29前` 和带秒 datetime 均拒绝；`2028-02-29前`、`2028-02-29 09:30前` 均接受。
- Gateway 回归测试同时覆盖上述非法月份/日期、非闰年 2 月 29 拒绝和闰年 2 月 29 接受。正常的日期和精确到分钟 datetime 形态维持允许。
- no-reply 测试已改为非真空 fake pipeline：在调用 Hook 前先保存 session/target；微信事件回调接收正文读取即抛错的 Proxy，仍返回 `{ handled: true }`，证明插件不读取入站正文；此时 provider/reply 计数保持 0。Telegram 事件保留同样已保存的 session/target、Hook 透传且 provider/reply 计数递增。版本化边界夹具仍为 `recordInboundSession → setContextToken → dispatch → before_agent_reply → model_call`。

### 命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| 独立 TypeScript 日期 + fake pipeline 断言 | 通过：所有不存在日期拒绝，闰年日期接受；微信不读取正文且不触发 provider/reply，Telegram 透传。|
| `cd server && npm run build && npm test` | 通过，143/143；仅使用测试临时数据库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，49/49；仅 Fake Adapter/离线 CLI fixtures，无真实 OpenClaw CLI 或网络调用。|
| `git diff --check` | 通过。|

### 最终结论

- **P1=0、P2=0、P3=0。** 第 24 节 P2 已被本节独立复验关闭，允许提交并进入后续代码验收。
- 本测试阶段新增的工作区内容仅为本报告第 25、26 节；其余差异为本轮测试开始前已有的实现、文档和插件文件。未启动 daemon、真实 OpenClaw/Gateway/Worker 或微信，未访问网络、DeepSeek 或业务数据库；此结论不构成真实 Pilot 执行。

## 27. OpenClaw Worker/Gateway 超时协调：独立复核（2026-08-02）

### 测试计划与基线

- 基线提交：`95425137f41866489629fc97ef5eab8b24256010`；开始前工作区已有 13 个本轮实现/测试/示例/文档修改，未恢复、覆盖或暂存。
- 复核 Gateway Adapter/CLI 的完整发送窗口、Worker HTTP 等待窗口、AbortSignal 结果映射、Fake Gateway 延迟成功及真正超时；并检查两个独立 PM2 进程的配置能否被实际协调。
- 全程未启动真实 OpenClaw、Gateway、Worker、DeepSeek 或 AI Scheduler，未访问生产数据库或真实微信。

### 通过项

- Gateway `ILINK_REQUEST_TIMEOUT_MS` 默认已由 10000ms 调整为 30000ms，并同时用于 `GatewayService` 的 Adapter Abort 和 `OfficialRuntime` 的 `openclaw message send` 子进程限制。
- 业务端默认 `OPENCLAW_GATEWAY_SEND_TIMEOUT_MS=30000`、`OPENCLAW_GATEWAY_TIMEOUT_MS=40000`；`resolveNotificationConfig()` 要求 Worker 值严格大于声明的发送窗口加 5000ms。非法整数、范围外值和 30000/35000 边界均由测试拒绝。
- 离线 Fake Gateway 在 10050ms 后返回 `sent` 时，Worker 仅调用一次，`notification_logs` 写入 `status=sent`、`attempt_count=1` 和原 `provider_message_id`；这覆盖旧 10 秒上限之后的新窗口内成功。
- 真正超过 Worker 等待窗口的 Fake Gateway 测试写入 `status=failed`、`last_error_code=OPENCLAW_SEND_RESULT_UNKNOWN`、`retry_allowed=0`，且调用次数为 1；明确失败、网络/非法响应、幂等、owner 详细模板、多人映射、no-reply、白名单和成功响应解析均由现有回归覆盖。

### 失败项

#### P2：两个独立进程没有可验证的实际超时契约，仍可配置错配并重现 Worker 先超时

- 预期：Worker 的 40000ms HTTP 等待必须针对 Gateway 实际使用的完整 30000ms Adapter/CLI 窗口；若二者不匹配，任一侧启动或调用应 fail-closed。
- 实际：Server 仅校验其本地 `OPENCLAW_GATEWAY_SEND_TIMEOUT_MS` 与 `OPENCLAW_GATEWAY_TIMEOUT_MS`；Gateway 仅独立接受范围为 1000–120000ms 的 `ILINK_REQUEST_TIMEOUT_MS`。两进程之间没有共享受控配置、Gateway health/协议字段或启动握手来证明两项相等。`deploy/ecosystem.openclaw-gateway.config.cjs` 只有注释说明“must equal”，不能阻止 Gateway 实际设为 60000ms、Server 仍声明 30000/40000ms 的错配。
- 配置文档也未完全同步：`deploy/.env.example` 仍保留旧的 `OPENCLAW_GATEWAY_TIMEOUT_MS=10000`，没有 `OPENCLAW_GATEWAY_SEND_TIMEOUT_MS`。
- 影响：错配时 Gateway 仍可在 Worker 40 秒后继续执行，重现本次修复目标中的 `result_unknown/failed` 假阴性。
- 建议：建立跨进程可验证契约，例如 Gateway `/health` 明确、受认证地声明实际完整发送窗口，Worker 在启动和每次 OpenClaw 投递前比对声明值及缓冲关系；或让两个 PM2 进程从同一受控超时配置载体读取且在启动脚本中拒绝不相等。同步 `deploy/.env.example`，并补充错配拒绝的集成测试。

### 命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | 通过，145/145；仅临时测试数据库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，50/50；Fake Adapter/CLI fixture，无真实 OpenClaw 或网络调用。|
| `git diff --check` | 通过。|
| `server/data` SHA-256 前后比较 | 一致；`app.db=8b8bc326…061d5f2`，未改动。|
| PM2/示例与源码静态交叉核对 | 失败：独立进程无实际超时匹配校验，且 `deploy/.env.example` 仍为旧 10 秒示例。|

### 结论

- **P1=0、P2=1、P3=0；不允许提交或申请真实单条发送授权。** 需先关闭跨进程超时错配门禁并独立复测。
- 本测试阶段仅新增本报告第 27 节；未修改业务实现、迁移、Schema、映射或消息策略。

### 修复后独立复测

- 第 27 节的 P2 已关闭。业务端把 `gatewaySendTimeoutMs=30000` 与 `workerTimeoutMs=40000` 置入每个 Gateway 请求 body；既有 HMAC 对该完整 body 的 SHA-256 签名，因此两个值不能在签名后被替换。Gateway 的严格 schema 接收这两个整数，并在授权消费、幂等 acquire、接收人解析和 Adapter 调用之前，将它们与本实例的 `ILINK_REQUEST_TIMEOUT_MS` 及 5000ms 缓冲比较。
- Gateway 以 60000ms 启动、收到已签名的 30000/40000 合约时，独立 Fake Adapter 测试返回 `permanent_failure / ILINK_REQUEST_INVALID`，Adapter 调用计数为 0。默认 30000ms Gateway 与 30000/40000 请求仍通过并只调用 Adapter 一次。
- Server 的延迟 Fake Gateway 成功测试在 10050ms（旧 10 秒上限之后）返回 `sent`，最终记录为 `sent` 并保存 `provider_message_id`；真正超过 Worker 窗口的测试仍为 `failed / OPENCLAW_SEND_RESULT_UNKNOWN / retry_allowed=0`，调用次数为 1，不会自动重试。明确失败、网络/非法响应和幂等回归均通过。
- 根与部署 `.env.example`、Gateway 示例、当前 PM2 示例以及 phase3/phase4 PM2 示例均统一为 Gateway 30000ms、Worker 40000ms，未保留本轮 OpenClaw 10 秒默认值。

| 命令/检查 | 修复后结果 |
| --- | --- |
| `cd server && npm run build && npm test` | 通过，145/145；仅临时数据库。|
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，51/51；含 60 秒 Gateway 错配前拒绝，未启动真实 OpenClaw。|
| `git diff --check` | 通过。|
| `server/data` SHA-256 前后比较 | 一致；`app.db=8b8bc326…061d5f2`。|

**修复后结论：P1=0、P2=0、P3=0，允许提交；本离线结论不构成真实微信发送授权。** 本轮未修改业务实现、迁移或数据库，未启动真实 OpenClaw/微信、DeepSeek、AI Scheduler 或生产服务。

## 28. 当前版本离线收尾独立验证（2026-08-02）

### 基线、计划与隔离

- 测试开始基线为 `8db1f278adaa539028cea22a7565342f6d8fafc9`；开始时已有本次收尾实施改动，范围为 H5 锁文件、部署模板、Gateway 离线映射检查、迁移测试和交付文档。未恢复、覆盖或暂存这些实施改动。
- 计划：在两个全新临时副本验证 H5 的普通安装与构建；完整回归 Server/Gateway；独立核验当前全部迁移 `001`–`007` 的 checksum、空库/重复执行、006 升级、冲突/失败回滚、完整性和默认规则；静态核验部署与同事绑定流程；核验离线映射检查不泄露 target；最后比较 `server/data`。
- 未启动真实 OpenClaw、Gateway、Worker、AI Scheduler 或 DeepSeek；未调用微信、未访问生产数据库、未产生小程序构建产物。临时 SQLite 仅位于 `/tmp`，并在测试结束时删除。
- `server/data` 目录聚合 SHA-256：测试前后均为 `ec00bd8eace280958d82e3cd012dc020b194767ad8d7c55137aa99c74b4e6a05`。

### 执行结果

| 范围 | 独立结果 |
| --- | --- |
| H5 可复现安装 | 两个全新临时副本均执行 `npm ci && npm run build:h5` 成功；根目录 `app` 再次执行同一命令成功。`app/package.json` 没有变更，未使用 `--force`、`--legacy-peer-deps`，也未构建小程序。|
| Server 回归 | `cd server && npm ci && npm run build && npm test` 通过，`146/146`。|
| Gateway 回归 | `cd poc/ilink-gateway && npm ci && npm run build && npm test` 通过，`52/52`。|
| 当前迁移 | 独立临时 DB 顺序应用 `001`–`007`、再执行一次均通过；版本和 checksum 与 `MIGRATIONS` 完全相同，`integrity_check=ok`、`foreign_key_check=[]`、启用规则数为 `0`。Server 迁移测试另覆盖旧 006 DB 升级后通知历史保持、checksum 冲突阻断和故意失败迁移事务回滚。|
| 迁移 checksum | `001 c10d4871…0e57a0`、`002 db94974c…12b0d9`、`003 e774d920…8f51704`、`004 61ab37ae…af47f75`、`005 8636bf27…1a6346`、`006 b6b27bc9…6603026a`、`007 c09175e8…1f5242da`。|
| 映射检查 | 使用临时精确 `0600` 的虚构 `@im.wechat` 映射运行 CLI；仅输出 `SAFE` 与 recipients/enabled/disabled 三项聚合数，不输出 target、不读取 Secret，未连接 OpenClaw/微信。|
| 部署静态检查 | `bash -n deploy/deploy.sh`、`bash -n deploy/setup.sh` 及四份 PM2 CJS `node --check` 均通过。模板只使用仓库外运行目录/占位符；Gateway 无 `DB_PATH`/DeepSeek，默认通知与 AI 开关为关闭；部署、停止/回滚、日志轮转及人工绑定清单均已覆盖。|
| 差异检查 | `git diff --check` 通过；本测试阶段只新增本报告本节。|

### 依赖审计与残余风险

- `server` 与 `poc/ilink-gateway` 的 `npm audit --omit=dev` 均为 `0` vulnerabilities。
- `app` 的普通 `npm audit` 报告 1 moderate（`@dcloudio/vite-plugin-uni`）和 1 high（直接 devDependency `vite@^5.2.8`）；`npm audit --omit=dev` 仍报告 Vite 相关 1 high。现有 H5 发布为静态产物、不会启动 Vite 开发服务器，且本轮未获准升级直接依赖，因此没有执行 `npm audit fix` 或依赖升级。
- 该项是 **P2：需在后续获得直接依赖升级授权后处理**。在静态 H5 发布及开发服务器仅本机监听的当前边界下不影响本轮构建可复现性，但不满足“无未解决 P1/P2/P3”的无条件生产放行标准。

### 结论

- **P1=0，P2=1，P3=0；允许进入验收进行范围内文档与配置收口，但不建议无条件生产部署。**
- 生产部署仍需用户集中提供生产路径、备份/恢复授权、维护窗口和回滚负责人；任何同事绑定、真实微信发送或生产进程启动仍需单独人工授权。

### 验收部署收口增量复验（2026-08-02）

- PM2：四份模板均通过 `node --check`；未设置或设为相对路径的 `XIANSUO_SERVER_DIR` / `XIANSUO_ILINK_GATEWAY_DIR` 均会在加载时拒绝，绝对临时路径才可得到对应 cwd。`deploy/.env.example` 的 `NODE_ENV=production`。
- 脚本：`bash -n deploy/deploy.sh`、`bash -n deploy/setup.sh` 通过。部署包包含 Gateway 源码与锁文件、在服务器端构建并 `npm prune --omit=dev`，但脚本只 `startOrReload` API，明确不自动启动 Worker、Gateway 或 OpenClaw。
- 生产裁剪 CLI：在全新 Gateway 临时副本执行 `npm ci`、build、`npm prune --omit=dev` 后，虚构精确 `0600` 映射的 `gateway:recipient-map-check` 仍成功，只输出聚合计数；不含 target、未连接网络/微信。
- Nginx：以虚构安全域名离线渲染模板后，所有域名和证书占位符均被替换为对应 Let's Encrypt 路径；未调用 `nginx reload` 或读取实际配置。
- OpenClaw：启动说明使用官方前台 `gateway run --bind loopback` 和只读 status，明确禁止公网/lan/tailnet/custom 绑定及强制启动；日志与回滚文档保留关闭渠道、停止顺序和仓库外敏感状态边界。
- Vite audit 复判：`vite@5.2.8` 的 audit 告警仍存在，但实际 H5 为 `type="module"` 静态制品，`vite.config.ts` 把开发服务限制为 `127.0.0.1`、关闭 CORS，生产不会运行 Vite。该告警保留为后续 uni-app/Vite 兼容升级门禁，不构成当前静态 H5 运行的未解决 P2。
- 增量复验后 `git diff --check` 通过，`server/data` 聚合 SHA-256 仍为 `ec00bd8eace280958d82e3cd012dc020b194767ad8d7c55137aa99c74b4e6a05`。

**最终测试结论：P1=0、P2=0、P3=0；允许进入本地提交与验收收口。** 正式部署仍需生产路径/备份/维护窗口/回滚负责人以及单独的进程或真实消息授权。

## 29. 单账号 OpenClaw 发布冻结：独立验证计划（2026-08-02）

### 测试前基线与隔离

- 分支：`release/single-account-openclaw-v1`；HEAD：`75f29bc89078bed3ea0095a0802940c653eb16d0`。开始时已有 9 个未提交实现/交付差异：`docs/00-项目说明/README.md`、`docs/02-开发实现/CHANGELOG.md`、`docs/04-验收交付/ACCEPTANCE_REPORT.md`、`docs/04-验收交付/DEPLOYMENT_NOTES.md`、`docs/04-验收交付/OPENCLAW_INTERNAL_NOTIFICATION_RUNBOOK.md`、`poc/ilink-gateway/.env.example`、`poc/ilink-gateway/src/cli/recipient-map-check.ts`、`poc/ilink-gateway/src/config.ts`、`poc/ilink-gateway/test/gateway.test.ts`。这些均视为测试前已有改动，绝不恢复、覆盖、清理或归因给测试阶段。
- 测试前 `git diff --check` 通过；三套 `package.json` 与锁文件均无未提交差异。`server/data` 的确定性聚合 SHA-256 为 `ec00bd8eace280958d82e3cd012dc020b194767ad8d7c55137aa99c74b4e6a05`（按路径排序的逐文件 SHA-256 清单再哈希）；逐文件清单已在测试记录中保留。
- 全程只使用现有离线依赖缓存、Fake Adapter、伪造 HTTP 响应和系统临时目录；不得启动真实 OpenClaw、Gateway、Worker 或 DeepSeek，不得发送网络请求，不得连接或写入 `server/data`/生产数据库，也不构建微信小程序。

### 计划与验收矩阵

| 范围 | 计划 |
| --- | --- |
| 离线回归 | 分别在 `server`、`poc/ilink-gateway`、`app` 执行 `npm ci --offline`，再运行指定 build/test；执行 `git diff --check`。|
| 数据库迁移 | 以现有 `server/test/migrations.test.ts`、`server/test/openclaw-synthetic-pilot.test.ts` 和全量后端测试核验 `001`–`007` 的空库、旧版升级、重复执行、checksum 冲突、故意失败回滚、`integrity_check`、`foreign_key_check`、历史通知数据和默认规则关闭。|
| 单账号门禁 | 以 Gateway 离线测试核验 live 模式恰好一个 enabled 才能构造；零/多个 enabled 的 CLI 非零并只输出脱敏 `UNSAFE`；一个 enabled 输出聚合 `SAFE`；`live=false` 保留多映射兼容；旧单用户配置可用；未绑定/禁用用户不回退且 Adapter 零调用。|
| 通知与安全回归 | 由全量 Server/Gateway 测试核验 `owner_changed` 详情、手机号脱敏、入站静默、跨进程超时协调、`providerMessageId` 解析、幂等与异常/未知结果处理。|
| 收尾核对 | 复核依赖/锁文件未变化，测试后重新记录 Git 状态、差异和 `server/data` 聚合 SHA-256；只追加本报告的最终结果。|

### 已执行命令及结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npm ci --offline && npm run build && npm test` | 通过；`npm ci` 从离线缓存恢复 179 包，build 通过，Node 测试 **146/146** 通过。测试仅创建并清理 `/tmp/xiansuo-*` 临时数据库。|
| `cd poc/ilink-gateway && npm ci --offline && npm run build && npm test` | 通过；`npm ci` 从离线缓存恢复 7 包，build 通过，Node 测试 **53/53** 通过，全部为 Fake Adapter/离线 CLI fixture。|
| `cd app && npm ci --offline && npm run build:h5` | 通过；`npm ci` 从离线缓存恢复 465 包，H5 构建完成。仅有未设置 uni Appid 的统计提示；**未执行**任何微信小程序构建。|
| `git diff --check`（测试前、测试后） | 两次均通过。|
| 包与锁文件差异核对 | `server`、`poc/ilink-gateway`、`app` 的 `package.json`/lockfile 均没有未提交差异；因此不需要另行进行“依赖发生变化”的生产依赖审计。|
| `server/data` SHA-256 前后比较 | 通过；聚合值均为 `ec00bd8eace280958d82e3cd012dc020b194767ad8d7c55137aa99c74b4e6a05`，所有 8 个逐文件 SHA-256 也完全一致。|

### 通过项与可复现证据

| 验收项 | 结果 | 证据路径 |
| --- | --- | --- |
| 迁移 `001`–`007` 空库、外键、重复启动 | 通过：全版本顺序应用、第二次 `skipped`；`PRAGMA foreign_keys=1`，非法外键写入拒绝。 | `server/test/migrations.test.ts`：`空库创建完整版本化 schema，并强制外键`、`旧结构可迁移…并可重复执行`；后端全量 146/146。|
| 旧库/历史数据升级与规则默认关闭 | 通过：遗留 users/leads/follow_ups 记录、主键和关系保留；006 升级到当前版本后历史 notification log 保留，启用规则数为 0。 | `server/test/migrations.test.ts`：`旧结构可迁移…`、`006 旧版本升级…历史且所有规则关闭`。|
| checksum 冲突、失败回滚、完整性 | 通过：已记录 checksum 被篡改即拒绝；故意失败 migration 未写入完成记录；`integrity_check=ok`、`foreign_key_check=[]`。 | `server/test/migrations.test.ts`：`迁移校验和冲突或迁移失败…`；`server/test/openclaw-synthetic-pilot.test.ts`：`synthetic 入队迁移001-007…`。|
| live Gateway 单账号映射 | 通过：仅恰好一个 `enabled=true` 的映射可构造 live Gateway 且离线检查输出 `{conclusion:'SAFE', recipients, enabled, disabled}`。零个或多个启用项均被 config 和 CLI 拒绝，CLI 返回非零并仅输出 `{conclusion:'UNSAFE', code:'OPENCLAW_RECIPIENT_MAP_CHECK_FAILED'}`，不泄露 target 或 key。 | `poc/ilink-gateway/test/gateway.test.ts`：`single-account release gate requires exactly one enabled map entry without exposing map identifiers`。|
| 兼容与不回退 | 通过：`live=false` 仍保留多人静态映射解析；映射优先旧单用户配置；旧单用户模式可用；未绑定/禁用用户分别在 Adapter 前返回 `OPENCLAW_RECIPIENT_NOT_BOUND` / `OPENCLAW_RECIPIENT_DISABLED`，无发送回退。 | `poc/ilink-gateway/test/gateway.test.ts`：`recipient map keeps live=false…`、`recipient map file…`、`idempotency…`。|
| owner_changed、脱敏与入站静默 | 通过：固定详情结构、可选字段降级、完整手机号/微信标识拒绝或掩码、astral 边界与安全 detail URL 均回归；`openclaw-weixin` 入站 hook 在读取正文或调用 provider/reply 前返回 handled，其他渠道透传。 | `server/test/openclaw-notifications.test.ts` 的 owner_changed/channel 用例；`poc/ilink-gateway/test/gateway.test.ts`：`owner_changed policy…`、`OpenClaw WeChat no-reply hook…`。|
| 超时协调、异常与幂等 | 通过：Worker `30s send / 40s wait` 与 Gateway 实际 30s 契约相符；Gateway 60s 错配在 Adapter 前拒绝；超时只形成一次 `result_unknown`，无自动二发。并发/终态请求不会二次调用 Adapter。 | `server/test/openclaw-synthetic-pilot.test.ts`：两条 Worker timeout 用例；`poc/ilink-gateway/test/gateway.test.ts`：`Gateway rejects a Worker…`、`concurrent and terminal idempotency…`。|
| `providerMessageId` 解析与脱敏回执 | 通过：`ret=0` 即为 sent；无 provider id 生成稳定本地 SHA-256 回执，有 provider id 仅保留 `ilink-provider:<hash>`，重复请求返回原持久化回执。 | `poc/ilink-gateway/test/gateway.test.ts`：`ret=0 means sent…`、`deduplicated delivery must return…`。|

### 失败项、未覆盖范围与建议

- **失败项：无。P1=0、P2=0、P3=0。** 因此没有需要交付实现代理的最小复现。
- 未覆盖且不应误判为通过：真实 OpenClaw/Gateway/Worker/DeepSeek 生命周期、微信登录/扫码/发送、生产 DB 迁移、副本恢复演练、生产进程和网络路径；均被本次授权明确禁止。离线通过不构成真实发送或部署授权。
- 仅出现 npm 安装期的 deprecated/`allow-scripts` 提示与 H5 未配置 Appid 的统计提示；没有构建或测试失败，也不改变锁文件或业务功能结论。

### 测试阶段文件变化与最终门禁

- 测试后 Git 状态相对开始时仅新增/修改本报告 `docs/03-测试验证/TEST_REPORT.md` 的第 29 节；开始时的 9 个实现/文档差异仍在，且未被修改、恢复、暂存或清理。`node_modules` 与 H5 构建产物未形成新的受跟踪工作区差异。
- 复现证据为本报告表中列出的测试文件及以上完整命令输出；任何重新验证均应继续使用离线缓存和临时目录，并在完成后比较 `server/data` 聚合哈希。
- **结论：允许进入验收阶段（离线发布冻结范围）。** 条件是验收阶段不得扩大为生产 DB 操作、真实 OpenClaw/Gateway/Worker/DeepSeek 启动或真实消息发送；这些操作仍须分别获得用户授权、生产副本备份/恢复门禁和后续实况验证。
