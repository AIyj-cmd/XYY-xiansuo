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

## 30. Hermes Weixin v2026.8.3 纯离线 PoC 独立验证（2026-08-08）


> 验证日期：2026-08-08
>
> 结论：**离线 PoC 验证通过；不允许据此无条件进入真实 Pilot、真实发送或生产上线验收。**

### 测试环境与基线

- 工作区：`/home/yj/xiansuo`；分支：`poc/hermes-weixin-multi-user`。
- 已阅读根目录 `AGENTS.md`、现有设计/实施记录和当前差异。设计文档内的历史 No-Go 与后续授权说明仅作为待核验上下文，本报告以实际 PoC 与测试结果为准。
- 测试前 Git 基线：`git status --short` 仅有 `?? poc/hermes-weixin-offline/`；`git diff --name-only` 为空。该未跟踪目录属于测试前已有实现，未被恢复、清理或归因给测试阶段。
- 测试前 `server/data/` 逐文件 SHA-256 已记录；`app.db` 为 `8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2`。测试后逐文件哈希完全一致。
- 测试对象是本地 `/tmp/hermes-agent-v2026.8.3`：remote 为 `https://github.com/NousResearch/hermes-agent.git`，`HEAD=3c27eb6234bf91b8ceee9e9071591b31e9b148cb`，精确 tag `v2026.8.3`，`pyproject.toml` 为 `hermes-agent 0.20.0`，`LICENSE` 为 MIT。

### 测试计划与范围

1. 固定上游版本、许可证与公开 `hermes send` 的 Weixin 路由。
2. 离线隔离：随机 `/tmp` 的 `HERMES_HOME`/`HOME`/XDG、禁止 DNS/socket、无默认 `~/.hermes`、无 `server/data` 写入和临时状态清理。
3. 两个虚构 peer 的 `MessageEvent`/session、account+peer `context_token` 落盘和“重启”恢复。
4. `disabled`、`pairing`、`allowlist` 的真实 intake 和 Gateway 授权分支。
5. fake 出站 payload、失败重试、跨调用 `client_id`、真实 Agent/Provider/模型工具零构造。
6. 仓库后端构建/测试及前端 H5 构建；不构建小程序。

未覆盖：真实微信登录/扫码/轮询/网络、真实 iLink 投递与用户端回执、主动推送授权、真实 context token 的有效期、生产数据库和真实服务生命周期。本报告不构成真实外发授权。

### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `git status --short`、`git diff --name-only`（测试前） | 记录到仅有未跟踪 PoC 目录。 |
| 上游 `git remote -v`、`rev-parse HEAD`、精确 tag、`pyproject.toml`、`LICENSE` | 通过，固定到声明的官方 remote/tag/commit/version/MIT。 |
| `./poc/hermes-weixin-offline/run-offline-poc.sh` | 最终代码连续执行 **2 次**，均为 **9/9** 通过；总计测试期间执行 5 次，其中前 1 次发现并修正测试桩缺陷，不计作通过证据。 |
| `cd server && npm run build` | 通过。 |
| `cd server && npm test` | 通过，**146/146**。 |
| `cd app && npm run build:h5` | 通过；仅有未配置 uni Appid 的统计提示。 |
| `git diff --check` | 通过（报告完成后复查）。 |
| `server/data` 前后 SHA-256、`/tmp/xiansuo-hermes-weixin-offline-*`、相关进程 | 数据哈希完全一致；无 PoC 临时目录；无 Hermes/OpenClaw/Worker/AI 服务进程（扫描命中仅为当前 shell、`rg` 与沙箱包装进程）。 |

本次 PoC 未修改 package/lockfile，因此不触发“依赖发生变化”的生产依赖审计。

### 通过项与证据

| 验收项 | 结果与证据 |
| --- | --- |
| 供应链固定 | PoC 的 provenance 用例同时断言目录名、Git HEAD/tag、包名/版本和 MIT；上游 remote 另经命令核验。 |
| 默认主目录与网络隔离 | 在导入 Hermes 前设置随机 `/tmp` 状态目录；每个测试替换 DNS 和 socket connect/send 入口为失败桩。两次完整运行均未触发网络断言。 |
| 数据隔离与清理 | 全程仅写 `/tmp/xiansuo-hermes-weixin-offline-*`，最终搜索为空；`server/data` 八个文件的逐文件 SHA-256 均不变。 |
| 双 peer/session/token | `peer-a`/`peer-b` 的 `MessageEvent.source` 和 session key 各不相同；token 按 account+peer 独立保存，再实例化后可正确恢复。 |
| DM 策略与 Gateway | `disabled` 在 token 写入/handler 前丢弃；`pairing` 可进入 handler；`allowlist` 只有已列 peer 可进入 handler。两类入站随后都验证：Gateway 未授权早退、不进入 session/Agent；授权时会调用 `_handle_message_with_agent` 记录桩一次。 |
| 零 Agent/Provider/模型工具 | Gateway “进入 Agent 链”测试使用 `AsyncMock` 记录桩，未构造真实 AIAgent/Provider/模型工具；public send 测试只使用显式 fake transport。`tools.send_message_tool` 是 CLI 共用传输模块，不是本次调用的模型工具。 |
| 公开发送入口 | 调用公开 `hermes_cli.send_cmd.cmd_send()` handler，以 `weixin:wxid_targetpeer` 和 fake transport 获得退出码 0、准确 target 和 payload；未启动 CLI 子进程、未发网络。 |
| 直接发送契约 | `send_weixin_direct` 的 `_api_post` 被 fake；断言仅目标 peer、保存的 context token、bot message type 和文本 `item_list`。 |

### 失败项、风险与最小复现

#### P1：默认重试会对 timeout、HTTP 4xx/5xx 与坏 JSON 均执行 1+4 次，且跨调用没有业务幂等

- 预期：真实外发前必须由业务层明确失败分类和跨调用幂等，不能把不确定或明确 4xx 结果默认重复投递。
- 实际：固定 Hermes v2026.8.3 的 `WeixinAdapter.send()` 在 timeout、模拟 HTTP 400、HTTP 503、坏 JSON 四种失败中均调用 `_send_message` 5 次；同一次逻辑发送复用一个 `client_id`，但两次相同逻辑 `send()` 生成不同 `hermes-weixin-*` client ID。
- 最小复现：运行 `./poc/hermes-weixin-offline/run-offline-poc.sh`，观察 `test_default_transport_failures_are_retried_and_are_a_no_go_finding` 和 `test_repeated_logical_send_generates_new_client_ids_and_has_no_cross_call_idempotency`。证据：`poc/hermes-weixin-offline/test_offline_poc.py`。
- 影响：在真实未知送达/重复任务环境中存在重复消息风险，HTTP 4xx 的重试也可能放大无效请求。
- 建议：不得直接把 Hermes 出站用于业务通知；应在获批准的独立 Gateway/业务 outbox 中实现持久化业务幂等键、严格状态分类、未知结果人工确认和重复投递门禁，再进行专门的实况验证。

#### P3：离线断言不能证明真实协议能力与用户端送达

- 实际：所有 iLink 调用均为 fake，socket/DNS 被禁；CLI handler 也未 fork 真实子进程。
- 影响：不能据此宣称扫码/会话恢复、主动发送、回执、限流、上下文有效期或用户端送达已通过。
- 建议：仅在用户另行授权、使用独立账号/目录/网络隔离与明确停止条件后，设计单独实况计划。

P2：无。

### 测试阶段文件变化

- 测试前已有未跟踪目录 `poc/hermes-weixin-offline/`；测试阶段仅修订其中的测试辅助文件 `test_offline_poc.py` 与说明 `README.md`，补足已授权 Gateway 对照分支、公开 `hermes send` handler fake transport 覆盖，并移除测试自身的未关闭 event loop 警告。
- 本阶段修改本报告 `docs/03-测试验证/TEST_REPORT.md`；未修改 `app/src`、`server/src`、`scripts` 或 `deploy`。
- 最终 Git 状态应包含本报告修改与既有未跟踪 PoC 目录；构建产物未新增 Git 条目，`server/data` 未变化。

### 放行结论

- **离线 PoC：PASS。** 固定来源、离线性、文件隔离、双 peer/token 分离、策略实际分支、fake payload、公开 CLI handler 路由与临时清理均已通过。
- **真实 Pilot/生产/真实发送：FAIL（P1）。** 默认 1+4 重试和跨调用无幂等未解决前，不允许进入无条件验收。
- **带条件进入后续验收：允许，但仅限离线 PoC 文档/代码收口。** 条件是不得启动真实 Hermes/OpenClaw/Worker、不得访问网络或 `server/data`、不得发送消息；若要进入真实外发验收，必须先关闭 P1 并获得新的明确授权。

### 验收阶段最终复验补充（2026-08-08）

- 验收阶段再次连续执行 2 轮 `./poc/hermes-weixin-offline/run-offline-poc.sh`，两轮均为 **9/9** 通过；全程未触发网络失败桩。
- `cd server && npm run build && npm test` 通过，后端 **146/146**；`cd app && npm run build:h5` 通过，仅有未配置 uni Appid 的统计提示。
- 验收前后 `server/data/app.db`、`app.db-shm`、`app.db-wal` 的 SHA-256 分别保持 `8b8bc326…`、`42a2baf3…`、`194c0753…`；最终 8 个文件清单聚合 SHA-256 为 `7cfa8026040a7f5b5915322fbfed619a745d76e5970724bb6519035b94c6cf10`。
- 最终未发现 `/tmp/xiansuo-hermes-weixin-offline-*`；进程检查未发现 Hermes、OpenClaw、notification-worker、DeepSeek 或 AI Scheduler 服务实例。
- 本节保留 `HEAD` 原有 **630 行**测试历史，并只在其后追加 Hermes 专项结果；未覆盖、删除或改写既有 1–29 节。

## 30. Hermes transport-only overlay 与 Gateway adapter 独立复验（2026-08-08）

### 测试环境、基线与计划

- 工作目录：`/home/yj/xiansuo`；分支：`feature/hermes-weixin-transport-only-fork`。开始前已读取根 `AGENTS.md`、当前 Hermes overlay README、Direct iLink 设计审计、开发变更日志及本报告既有记录。
- 开始基线 `git status --short`：已修改 `poc/ilink-gateway/src/{cli/common.ts,config.ts,gateway-service.ts,server.ts,types.ts}` 与 `test/gateway.test.ts`；已未跟踪 `poc/hermes-weixin-transport/`、`src/adapters/{factory.ts,hermes-adapter.ts}`。这些均为测试前已有改动，未恢复、覆盖、暂存或提交。
- 计划：先检查上游 gate、文件权限/路径、入站过滤与状态最小化；再做并发/单次投递/子进程与 HTTP 边界验证；最后执行 overlay 两轮、旧 offline 9/9、Gateway、Server、H5、diff 和 `server/data` 哈希回归。全程未启动真实 Hermes/OpenClaw/Gateway/Worker 进程、未登录、未扫码、未调用真实网络或微信。
- `server/data` 所有普通文件在前后逐文件 SHA-256 一致；`git diff --check` 通过。依赖及 lockfile 不在本轮差异中，故不触发生产依赖审计。

### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `poc/hermes-weixin-transport/run-tests.sh` 连续两轮 | 第一轮 10/10；第二轮 9/10，`test_10_concurrent_captures_leave_a_valid_locked_atomic_state` 失败。 |
| overlay 10 轮压力重跑 | **3/10 失败**，均为 12 个 concurrent capture 中至少一个 `StateError: 状态目录或文件不安全`。 |
| `./poc/hermes-weixin-offline/run-offline-poc.sh` | 9/9 通过；DNS/socket 均为失败桩。先前以系统 Python 直接运行因缺少 `dotenv` 无法导入，已改按此脚本的固定 `.venv` 复验，不将阻塞记为通过。 |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，56/56；均为 fake adapter/受控子进程结果或 loopback HTTP。 |
| `cd server && npm run build && npm test` | 通过，146/146。 |
| `cd app && npm run build:h5` | 通过；仅有未配置 Appid 的常规提示。 |
| `ps`、上游 Git/受控文件检查 | 未发现真实 Hermes/OpenClaw/iLink/微信/Worker 进程；固定 source 的 remote/tag/commit/tree/clean、MIT、版本与 manifest 哈希现状均通过。 |

### 通过项与未覆盖范围

- `ILINK_POC_TRANSPORT` 默认仍为 `openclaw`；Hermes 需同时显式选择 transport 与 enable flag，factory 不回退到其他 adapter。Gateway HTTP schema 不接收 peer、token 或自由消息字段；peer 只来自仓库外 `0600` Hermes 映射。
- overlay 的 gate 在 overlay CLI 读取配置、状态或导入 `gateway.platforms.weixin` 前核验 remote/tag/commit/tree/dirty、版本、MIT 和 manifest 文件哈希；send 只构造一次文本 payload，client ID 对 account/peer/idempotencyKey 确定，timeout/断线/5xx/bad JSON 映射未知，4xx 映射明确失败，无 token 不调用 transport。
- Gateway fake-runner 覆盖了非法 stdout、exit、timeout、spawn 错误与 retryable 归一为 `result_unknown`，并覆盖同一 service 的并发、重启后 receipt 与历史 retryable 烧毁；无 retry/tokenless/chunk/fallback 的正向设计证据存在。
- 未覆盖：真实 session、provider 回执、实际限流/断线与用户端送达；这些均未执行，不能据此宣称实况能力通过。gate 的 skip-worktree/TOCTOU 对抗、全祖先目录链接和强制 kill/reap 也没有现有自动化覆盖。

### 失败项、复现与建议

#### P1-1：首次并发 capture 的 lock 创建竞态使合法 token 更新失败

- 预期：任意 0/1/10 allowlist peer 的并发 capture 必须经锁与原子 replace 保持有效状态，合法请求不得因另一个合法请求首次初始化 lock 而失败。
- 实际：`TokenState._ensure()` 先检查 `lexists(lock_path)`、后以 `O_EXCL` 创建；竞争者可在两步之间创建同一 lock，另一个竞争者将 `FileExistsError` 包装为 `StateError`。10 轮中 3 轮失败；第一轮/第二轮两次顺序运行也已出现 10/10 与 9/10 的不稳定差异。
- 最小复现：`for 10 次 poc/hermes-weixin-transport/run-tests.sh`；失败日志 `/tmp/hermes-overlay-run-{3,5,7}.log`，断言位置 `poc/hermes-weixin-transport/test/test_transport.py:172`。
- 建议：将 lock 的“存在或安全创建”处理为单一可重试原子步骤；遇到 `FileExistsError` 重新严格验证并打开该文件，而不是拒绝合法 capture。补足多进程、冷启动、多 peer 和重启压力测试。

#### P1-2：状态文件泄露原始 account/peer，违反状态最小化与身份隔离门禁

- 预期：状态不得保存正文、media、messageId、原始 peer 或原始 account；只应保存不可逆的 HMAC reference 与必要 token 保护材料。
- 实际：`state.py` 写入 JSON 顶层 `account_id`，并以原始 peer 为 `tokens` 的键，同时以明文 `token` 保存 context token；HMAC `ref`/`refs_mac` 不能消除这些原文副本。
- 证据：`poc/hermes-weixin-transport/src/hermes_weixin_transport/state.py:70,74,85,127,142`；现有测试只断言正文/media/messageId 未写入，未断言 account/peer 不落盘。
- 建议：以 HMAC(account/peer) 作为状态索引与绑定 reference，删除任何原始 account/peer 字段；迁移/清除既有状态并新增序列化、重启、篡改和跨账户隔离断言。

#### P1-3：Gateway secret 未执行 owner、hardlink、realpath 与仓库外校验

- 预期：身份/认证 key 与 Hermes 配置、状态、映射一样，必须当前 UID 拥有、精确 `0600`、单硬链接、无 symlink/祖先链接且在仓库外。
- 实际：`readSecretFile()` 仅检查 final component 的普通文件和 `0600`，不检查 `uid`、`nlink`、`realpath` 或仓库边界；这发生在 Hermes 分支前。
- 证据：`poc/ilink-gateway/src/config.ts:126-132`；现有 `Gateway Secret must be an exact 0600 regular file` 未覆盖 owner/hardlink/repository 外约束。
- 建议：复用并收紧 `requirePrivateExternalFile()`，且在读内容前完成祖先路径与仓库外检查；增加 owner、hardlink、final/ancestor symlink、仓库内路径矩阵。

#### P2-1：overlay 直连 CLI 的配置/状态路径不强制仓库外，且只检查最终组件链接

- 预期：直接 CLI 和 Gateway adapter 都必须拒绝仓库内、经任意祖先 symlink 的 config/state/identity 路径。
- 实际：`load_config()` 只对 final config file 调用 `require_private_file()`，而 `ensure_state_directory()/require_state_directory()` 只 `lstat` 目标或直接父目录；未比较所有路径祖先的 realpath，也未检查 repository root 边界。
- 证据：`config.py:39`、`security.py:37-77`。Gateway 的 Hermes config/map path 已有部分外部校验，但 direct overlay CLI 可绕过这些检查。
- 建议：统一接受绝对路径、逐段无链接 realpath、当前 UID、`0600/0700`、单硬链接与仓库外限制；测试应覆盖 config/state/identity/map 的 final 与祖先 symlink/hardlink/owner/mode 矩阵。

#### P2-2：子进程 timeout/非法输出只发 SIGTERM 后立即返回，未保证终止并 reap

- 预期：timeout、abort、超量 stdout/stderr 时应先烧毁 key，并等待子进程退出；忽略 SIGTERM 的子进程必须被强杀和 reap，避免返回后继续执行。
- 实际：`hermesCommandRunner.terminate()` 调用 `child.kill('SIGTERM')` 后立刻 `finish()`，没有 close 等待或 SIGKILL 后备；当前单元测试仅注入 runner result，未覆盖真实忽略 SIGTERM 的安全子进程。
- 证据：`poc/ilink-gateway/src/adapters/hermes-adapter.ts:18-39`。
- 建议：增加受控测试子进程，断言 timeout/aborted/oversize 后 key 为未知、adapter 单调用、子进程已退出且无存活后代；实施 TERM 宽限、KILL 和 close/reap。

### 测试阶段文件变化与放行结论

- 测试产生的 `poc/hermes-weixin-offline/__pycache__/` 已删除；`/tmp/hermes-overlay-run-*.log` 与前后哈希清单为测试临时证据，不在仓库。除本报告外，未修改仓库文件；未修改 `app/src`、`server/src`、`scripts` 或 `deploy`。
- 结束前 Git 状态与开始基线相同，待本报告写入后仅新增 `docs/03-测试验证/TEST_REPORT.md` 修改；其他差异均为测试前已有改动。
- 严重级别：**P1=3，P2=2，P3=0**。**验收：FAIL / 不允许进入验收阶段；真实 Pilot：FAIL / 严禁启动。** 至少修复三项 P1，并补足 P2 的路径与子进程对抗测试后，重跑 overlay（连续多轮）、old offline 9/9、Gateway、Server、H5、diff 与 `server/data` 哈希，才可重新进行独立评估。

## 31. Hermes transport 修复后的独立复测（2026-08-08）

### 新基线与测试计划

- 本节开始前重新记录 `git status --short` 与 `git diff --name-only`。开始时已有第 30 节报告、Gateway 改动、overlay 与 adapter 未跟踪文件；均保留且未恢复。测试后仅本报告新增追加内容，`server/data` 全部普通文件 SHA-256 与开始前一致，`git diff --check` 通过。
- 计划按修复项独立覆盖：20 轮冷启动并发、schema 2 磁盘最小化与篡改矩阵、Gateway/overlay 路径权限矩阵、受控子进程 SIGTERM/SIGKILL/reap、单次投递映射及全量回归。没有登录、扫码、真实网络、微信投递或常驻 Gateway/Worker/Hermes 进程。

### 已执行命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `poc/hermes-weixin-transport/run-tests.sh` 压力循环 20 次 | **20/20 通过**；每次内置 10 个 12-thread 冷启动 capture 回合，共 **200** 回合。 |
| overlay 单轮 | 12/12 通过。 |
| 独立 schema 2 篡改脚本 | 通过：磁盘只含 `schema/entries/entries_mac`，不含测试 account/peer/context token；ciphertext、错 HMAC key、nonce（重算外层 MAC 后）、entry tag（重算外层 MAC 后）和畸形 schema 均 `StateError` 失败关闭。 |
| Gateway Hermes config/map/state 路径矩阵 | 通过：overlay config 的 symlink/hardlink、map 的 symlink/hardlink、overlay state symlink 均被拒绝；Gateway secret 回归同时覆盖 0600、symlink、hardlink、祖先 symlink 与仓库内路径。 |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，57/57；新增真实安全子进程忽略 SIGTERM 的 timeout 与超量 stdout 两分支，均 SIGKILL 且在 runner 返回前 `/proc/<pid>` 已消失。 |
| `./poc/hermes-weixin-offline/run-offline-poc.sh` | 通过，9/9；仍全部 fake transport/DNS/socket 失败桩。 |
| `cd server && npm run build && npm test` | 通过，146/146。 |
| `cd app && npm run build:h5` | 通过；仅未配置 Appid 提示。 |

### 原 P1/P2 关闭复核

- **原 P1-1（cold-start lock race）：关闭。** `open_private_lock()` 对 `O_EXCL` 的 `FileExistsError` 改为安全 reopen/retry，并叠加进程内锁；20 次完整压力运行无失败。
- **原 P1-2（原始 account/peer/token 落盘）：关闭。** schema 2 使用 HMAC(account,peer) reference、随机 256-bit nonce 的派生 HMAC-SHA256 流加密和 Encrypt-then-MAC；外层 `entries_mac` 覆盖整个集合。独立序列化与篡改矩阵均通过，legacy schema 1 仅在通过原 HMAC 校验后原子迁移为 schema 2。
- **加密实现评估：满足本轮“磁盘不保存原始标识/token、篡改/错 key 失败关闭”的安全边界，无新增 P1/P2。** 该构造采用由根 key 域分离的 HMAC-SHA256 keystream、随机 32-byte nonce、entry MAC（含 reference/nonce/ciphertext）和集合 MAC；在 HMAC 作为 PRF、nonce 不复用的标准假设下，提供机密性和完整性。它仍是自定义组合而非已封装 AEAD，列为 P3 维护风险：后续如可在已批准依赖内使用成熟 AEAD，应做版本化迁移；不得削弱当前 nonce、域分离、entry MAC 或外层 MAC。
- **原 P1-3（Gateway secret 文件约束）：关闭。** `readSecretFile()` 复用外部私有文件校验，覆盖 owner、0600、单硬链接、realpath/祖先 symlink 与仓库外要求。
- **原 P2-1（overlay direct CLI 路径）：关闭。** overlay config/state 经 `normalized_external_path()` 要求绝对、仓库外、所有祖先非链接；独立路径矩阵通过。
- **原 P2-2（子进程终止/reap）：关闭。** runner 在终止后等待 `close`，250ms 后 SIGKILL；受控忽略 SIGTERM 子进程在 timeout/oversize 两种分支均被 reaped。非法输出/timeout 仍由 adapter 映射 `result_unknown`，Gateway 的同 key、重启与历史 retryable 单次投递回归通过。

### 新发现的未关闭项

#### P2-1：Hermes Gateway 的 `ILINK_POC_STATE_DIR` 仍可指向仓库内

- 预期：本轮要求的所有状态路径均必须在仓库外，并同时满足 owner、0700、无链接与文件安全条件。
- 实际：仅加载 Hermes Gateway config 时，将 `ILINK_POC_STATE_DIR=/home/yj/xiansuo/poc`，其余 secret/source/overlay config/state/map 均使用安全仓库外临时路径，`loadConfig()` 输出 `{"accepted":true}`。`loadHermesConfig()` 只对 `ILINK_HERMES_STATE_DIR` 使用 `requireSafeDirectory(..., outsideRepository=true)`；通用 `stateDir` 仍来自直接 `resolve()`。
- 影响：可将 Gateway SQLite 幂等/nonce/投递账本放入工作树，使敏感操作元数据有误提交、覆盖或被仓库工具处理的风险；违反明确的仓库外状态门禁。
- 建议：在 `loadConfig()` 中针对 Hermes（最好所有 Gateway transport）将 `ILINK_POC_STATE_DIR` 纳入同一仓库外、绝对路径、所有祖先非链接、0700/current UID 检查；补仓库内、祖先 symlink、owner/mode 矩阵测试。

### 测试阶段文件变化与结论

- 本轮运行产生的 offline `__pycache__` 已删除；压力日志、路径矩阵和哈希清单位于 `/tmp`，不在仓库。未修改业务源码、`app/src`、`server/src`、`scripts` 或 `deploy`。
- 严重级别：**P1=0，P2=1，P3=1**。原报告第 30 节 P1=3/P2=2 是历史失败记录；本节明确关闭其中五项并记录新的未关闭 P2。
- **总体：FAIL，暂不允许进入最终验收或真实 Pilot。** 修复新的 P2-1、补对应回归，并重跑 overlay 压力、Gateway/Server/H5、diff 与 `server/data` 哈希后，才可重新评估。所有真实外部渠道在此之前继续保持关闭。

## 32. Hermes Gateway ledger 外部状态路径最终独立复测（2026-08-08）

### 范围、基线与结果

- 开始前重新记录 Git 基线；此前 Gateway/overlay/报告改动均为既有内容，未恢复或覆盖。本节只追加本报告。`server/data` 普通文件 SHA-256 前后一致，`git diff --check` 通过；未启动真实 Hermes/OpenClaw/Gateway/Worker，未登录、扫码、联网或发送。
- 独立最小配置加载矩阵（不启动 server）：Hermes mode 的 `ILINK_POC_STATE_DIR` 指向仓库内 `/home/yj/xiansuo/poc`、经祖先 symlink 的路径、已存在 `0755` 目录均返回 `{\"ok\":false}`；仓库外新目录返回 `{\"ok\":true}` 且实测创建权限为 `0700`。
- OpenClaw 兼容性复核：同一仓库内 `ILINK_POC_STATE_DIR` 在明确 `ILINK_POC_TRANSPORT=openclaw` 的旧兼容配置中仍可加载 `{\"ok\":true}`，证明修复仅收紧 Hermes 模式，未改变既有 OpenClaw 解析契约。
- `poc/hermes-weixin-transport/run-tests.sh`：通过，12/12。`cd poc/ilink-gateway && npm run build && npm test`：通过，58/58，包含外部 Gateway ledger、非法路径、SIGKILL/reap、单次投递、重启与未知结果门禁。

### 结论

- 第 31 节的 **P2-1 已关闭**：Hermes `loadHermesConfig()` 在创建/使用 Gateway ledger 前强制 `ILINK_POC_STATE_DIR` 为当前用户拥有、精确 `0700`、无 final/ancestor symlink、仓库外的目录；回归测试确认 SQLite ledger 落在该外部目录。
- 当前严重级别：**P1=0，P2=0，P3=1**。P3 仅为第 31 节已记录的自定义 HMAC 流加密组合维护风险，不构成当前离线边界失败；不得在后续修改中削弱 nonce、域分离或双层 MAC。
- **最终离线代码验证：PASS，允许进入后续验收阶段。** 本结论不等同于真实 Pilot/真实微信送达已通过；真实登录、网络、外发仍未执行，必须另获明确授权并单独验收。

## 33. Hermes 成功响应分类修复独立验证（2026-08-08，已完成）

### 测试环境、基线与预先测试计划

- 任务边界：只验证本次“实际送达但旧 overlay 误报 permanent”修复；严格禁止真实登录、扫码、网络调用、微信发送、常驻 Worker/Gateway/Hermes 进程启动。允许差异仅为 overlay transport/README/tests+fixture 与 Gateway adapter/tests。
- 开始 Git 基线：`M poc/hermes-weixin-transport/{README.md,src/hermes_weixin_transport/transport.py,test/test_transport.py}`、`M poc/ilink-gateway/{src/adapters/hermes-adapter.ts,test/gateway.test.ts}`、`?? poc/hermes-weixin-transport/test/fixtures/`。`git diff --name-only` 与此相同；这些是测试开始前已有实现改动，未恢复、覆盖或清理。开始时相关文件 SHA-1 已记录：transport `883fed6…`、overlay tests `9738ec9…`、README `e60de3e…`、adapter `05b3822…`、Gateway tests `fa32144…`、fixture `2610aba…`。
- 预先计划：
  1. 静态核对允许路径、分类表、固定 `responseShape` 枚举和敏感值泄露面；执行恶意 canary 扫描。
  2. 离线执行 overlay 至少两轮，并以受控 fake `post_once` 覆盖 `{}`、`ret=0`、可选 `errcode=0`、所有数值非零、bool/string/null、冲突、未知对象和非对象；逐项断言 `type(value) is int` 的语义、一次调用、无重试/无 fallback。
  3. 验证 stdout 严格四字段、status/code/shape/exit-code 合法组合，确认旧三字段退化为 unknown；运行 Gateway receipt/idempotency/history-result_unknown 防回归用例及 Gateway build/test。
  4. 执行 Server build/test、H5 build；前后检查 diff、哈希、进程和网络监听。未发生依赖/lockfile 差异时不运行生产依赖审计。

### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `poc/hermes-weixin-transport/run-tests.sh` 连续两轮 | 通过；每轮 **13/13**，共 **26/26**。全部为本地 `unittest`、临时状态目录和 fake `post_once`。 |
| 受控 `PYTHONPATH=... python3 -c ...` 分类对抗矩阵 | 通过，**21** 例：分别覆盖 `ret` 与 `errcode` 的 bool、string、null、float、list、object，双向 0/非 0 冲突、未知对象、非对象及敏感 canary；无 canary 出现在结果中。 |
| 静态分类/契约/恶意 canary 扫描 | 通过。transport 仅输出 `status`、`code`、固定 `responseShape`、调用方提供的幂等键；Gateway 对 stdout 强制恰好四字段、固定 status/code/shape 组合及 sent=exit 0、非 sent=exit 1。canary 仅存在于测试 fixture/test case，不存在业务输出实现。 |
| `cd poc/ilink-gateway && npm run build && npm test` | 通过，**59/59**；包含旧三字段 stdout 拒绝为 unknown、非法 shape/组合/exit code 拒绝、receipt、并发幂等、重启后去重和 `result_unknown` 烧毁回归。 |
| `cd server && npm run build && npm test` | 通过，**146/146**。 |
| `cd app && npm run build:h5` | 通过；仅有既有的未配置 Appid 与可选更新提示。未构建微信小程序。 |
| `git diff --check`、最终状态/范围复核 | 通过。测试完成后，除本报告外的差异仍严格是开始时记录的五个允许文件与 fixture；无 lockfile/package 变动，因此不触发生产依赖审计。 |
| `server/data` SHA-256、进程与监听检查 | 通过。`app.db`、`app.db-shm`、`app.db-wal` 哈希分别仍为 `8b8bc326…`、`42a2baf3…`、`194c0753…`，与既有独立复测记录一致；没有 Hermes/OpenClaw/iLink/Worker/Weixin 相关进程（扫描命中仅为当前检查命令和 sandbox）。监听端口均为本轮测试前已有的无关本地服务，测试未启动监听者。 |

### 通过项与证据

- **已审计成功形态：通过。** 精确 `{}` 被映射为 `sent/ILINK_SENT/empty_object`；真正整数 `ret=0`（可带真正整数 `errcode=0`）为 `sent`。空对象来自固定官方插件成功 fixture；上一 Pilot 的原始响应未保存，本测试不把其结构反推为 `{}`。
- **显式拒绝与未知边界：通过。** 任一不冲突的真正整数非零 `ret`/`errcode` 为 `permanent_failure`；同时的 0 与非 0 为 `result_unknown/conflicting_codes`；单独 `errcode=0`、未知非空对象与非对象均未知。`_is_real_int()` 显式排除 Python `bool`，对 bool/string/null/其他非 int 均失败关闭。
- **最小且无泄露的响应契约：通过。** `responseShape` 是 adapter 允许表中的固定原子枚举；未知字段、上游字段名/值、正文、token、peer 不会进入 stdout。fixture 的 `raw-provider-body-token-peer` 和额外对抗 canary 均未回显。
- **一次投递与无降级：通过。** 每个 fake provider case 都断言调用次数为 1；transport 中无 retry/fallback/chunk/typing/media 分支，Gateway `HermesAdapter.attemptPolicy` 为 `single_attempt`，任一 unknown 均不转为 retryable。
- **Gateway 严格消费与账本回归：通过。** 旧三字段、额外字段、未知 shape、status/code/shape 不匹配和 exit-code 不匹配均归一为 unknown；sent receipt 保持本地脱敏稳定值；同键并发、重启、历史 unknown 均不会再调用 adapter。

### 未覆盖范围

- 按本轮明确禁止项，未做真实登录、扫码、网络请求、iLink 调用、微信投递或用户端回执确认；因此本报告只证明离线分类与防重语义，不把它表述为新的实况送达证据。
- 未启动常驻 Gateway/Worker/Hermes；所有涉及的 provider/runner 都是 fake 或受控子进程。

### 失败项、复现与建议

本轮响应分类范围内无失败项，无待修复 P1/P2/P3（不覆盖第 31 节已记录的历史 P3 维护风险）。若后续另行获批进行新实测，应只验证这一条已审计的 `{}` 成功形态和零重试/单回执，并把实际送达作为独立人工事实记录；不得依据 `result_unknown` 自动重发。

### 测试阶段文件变化与放行结论

- 测试阶段仅追加本报告；未修改 `app/src`、`server/src`、`scripts`、`deploy` 或本次允许范围内的业务实现。overlay 的 `__pycache__` 为 Python 测试运行时产生/复用的忽略缓存，未成为 Git 变化；未清理测试前已有的任何工作区内容。
- 最终 Git 差异相对本节开始基线仅新增 `docs/03-测试验证/TEST_REPORT.md`；其余五个修改文件及 fixture 均为测试开始前已有的待验收实现。
- **结论：PASS（本轮响应分类范围：P1=0，P2=0，P3=0）。允许进入验收阶段（仅离线实现验收）。** 本放行不授权真实发送；任何新的真实 Pilot 仍须由用户单独、明确授权。

## 34. Hermes 1–10 用户网站绑定与路由最终独立测试（2026-08-08）

初测日期：2026-08-08；最终复测：2026-08-08
最终结论：**PASS，允许进入验收阶段。** 初测 P1、容量 P1 与 replay P3 均已修复并独立复测；未进行真实微信登录、扫码或生产发送。

### 修复复测（最终结论）

本节是对初测结论的独立复验，后文保留初测失败证据以追溯修复缘由。

#### 已修复并验证通过

- **Server → Gateway HMAC 与代次契约**：Server 现在发送现有 Gateway 的 `x-ilink-gateway-*` 头、完整 `deliveryId`、30/40 秒定时器和 `recipientBindingGeneration`。隔离 HTTP 链路实测返回 `sent`，Gateway adapter 收到且仅收到 `recipientExternalId=hermes:2:3`、`recipientUserId=2`、`recipientBindingGeneration=3`。
- **Gateway → overlay 代次隔离**：Gateway 不再读取 raw peer map；只向 `send-bound` 传递 userId、generation、受控正文和幂等键。独立 overlay 测试证明 `(userId=2,generation=1)` 对已绑定 generation 2 零上游调用且返回永久 stale；精确 generation 2 才可一次发送。
- **capture-only daemon**：新增 daemon mock `getUpdates` 复测。真实 `InternalClient` HMAC canonical 请求仅向 prepare 提交 `code+peerFingerprint`，Server 响应定位 `userId`；DM 的 `item_list` 精确 `绑定 <32 hex>` 完成绑定，群聊在文本提取前被拒绝，测试桩没有 reply/typing/media/Agent/AI 接口。
- **P3 replay cache**：内部 HMAC replay cache 已设 10,000 上限；最小复现 `size=9999` 接受合法新 nonce，`size=10000` 失败关闭。

#### 复测执行结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS：151/151。 |
| `cd poc/ilink-gateway && npm run build && npm test` | PASS：59/59；含 OpenClaw/Mock、Gateway 并发/重启与 unknown 不重试回归。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | PASS：16/16；其中新增独立 daemon HMAC、`item_list`、群聊拒绝和精确代次 send-bound 测试。 |
| `cd app && npm run build:h5` | PASS；仅验证 H5，未构建微信小程序。 |
| 隔离 Server→Gateway HTTP | PASS：HMAC、header、schema、`recipientUserId + generation` 均被真实 Gateway 接受并准确传给 adapter。 |
| 隔离 Fastify prepare | PASS：调用方不提供 userId，绑定码由 Server 定位并返回 `{userId:1,generation:1}`。 |
| 1/2/10/11 容量 | PASS：第 1、2、10 人可绑定；第 11 人 prepare 失败关闭；边界并发仅一项 reservation 成功。 |

#### 容量 P1 修复复测

##### 历史 P1-4（已修复）：没有全局 10 人活跃绑定上限

初测最小复现：隔离 SQLite 应用 001–008，为 11 位不同用户逐一生成绑定码并 commit，结果为 `{"active":11}`。

最终复测：第 1、2、10 位用户可绑定；第 11 位用户 `prepare` 被拒绝，challenge 保持、`prepared_generation` 仍为 `NULL`。9 个 active 时两个并发 prepare 只允许一个预留；同一 active 用户重绑不额外占槽。commit 异常后 vault 条目为 `prepared`，但 `send-bound` 的精确 `(userId,generation)` 查询返回空，故不可发送。

实现验证：`BEGIN IMMEDIATE` 下的 active + prepared reservation 计数限制为 10；008 已增加 `prepared_generation/prepared_code_hash/prepared_at` 及索引。无需进一步容量修复。

#### 迁移 008 最终复测

- fresh 库：`001`–`008` 一次应用，包含 prepared 三列。
- 007→008：先应用 `001`–`007`，再应用当前集；成功升级为 `001`–`008`。
- 重复执行：`schema_migrations` 数量不变；008 checksum 一致。
- checksum：故意替换已执行 008 的 checksum 被拒绝。
- 回滚前提：以 008 版本的失败探针验证，事务回滚后没有探针表、也没有 008 ledger 记录。
- 009 没有进入 `MIGRATIONS`；容量字段合并进未发布的 008。001–007 checksum 与 `HEAD` 一致。

### 测试环境与基线

- 工作目录：`/home/yj/xiansuo`；Node `v24.18.0`；Python `python3`。
- 测试前 `git status --short` 已有 19 个已修改文件及 4 个新增 Hermes 相关文件；它们均为实施前已有工作区改动，未恢复、覆盖或清理。
- 测试前 `git diff --name-only` 与测试后结果一致（本报告除外）。
- `server/data` 的全部文件 SHA-256 在测试前后相同；测试只使用 `/tmp` 下的隔离数据库和临时配置，均已删除。
- `server/src/db.ts` 的 diff 仅新增迁移 `008`；`001`–`007` 的版本号和 checksum 与 `HEAD` 一致。`git diff --check` 通过。
- `package.json` / lockfile 没有差异，因此未运行生产依赖审计（不适用）。

### 测试范围与计划

1. 验证迁移 008、绑定码强度/TTL/单次使用、HMAC、重放、认证与数据最小化。
2. 验证 1、2、10 与第 11 人边界，负责人变更绑定代次、Worker 取消及渠道隔离。
3. 验证 Server → Gateway → Hermes overlay 的 `recipientUserId + generation` 契约、并发/重启幂等和 `result_unknown` 不重试。
4. 验证 capture-only 是否具备可运行长轮询 daemon，及 Agent/AI/reply/typing/media 禁止边界。
5. 回归 Server、OpenClaw/Mock、Gateway、overlay 与 H5。

未覆盖：未登录、未扫码、未向微信联网或发送真实消息；这不在本次授权范围，且应在后续验收批准后单独进行受控 Pilot。

### 已执行命令及结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS：TypeScript 构建通过，149/149 通过。含 OpenClaw/Mock 既有回归、迁移及新增 Hermes 服务层测试。 |
| `cd poc/ilink-gateway && npm run build && npm test` | PASS：构建通过，59/59 通过。含并发、重启、unknown 烧毁、Hermes adapter 子进程及 OpenClaw 回归。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | PASS：13/13 通过。覆盖单次 capture/send、脱敏状态、超时/5xx `result_unknown`。 |
| `cd app && npm run build:h5` | PASS：H5 构建通过；未构建微信小程序。 |
| Gateway HTTP 最小复现 | **FAIL**：Server 使用的 `x-hermes-gateway-*` 头收到 401 `ILINK_SIGNATURE_INVALID`；改为 Gateway 所需的 `x-ilink-gateway-*` 头后，带 `generation: 1` 的请求仍收到 400 `ILINK_REQUEST_INVALID`。 |
| Gateway Hermes 映射最小复现 | PASS：10 个接收人可加载；第 11 人按 1–10 限制拒绝。 |
| 隔离 Fastify API 绑定流程 | PASS：普通用户生成 32 位 hex 绑定码；`prepare`/`commit` 成功；同一 HMAC nonce 重放返回 401；公开响应仅含 `status/generation/expires_at`，不含 peer/token/fingerprint。 |
| 静态调用链核对 | **FAIL**：overlay CLI 仅接受 `capture`、`send`；没有 daemon/poll 命令或实现，且 `MultiUserVault/capture_inbound` 没有被 CLI 或 Gateway 调用。 |

### 通过项

- 迁移 008 在隔离库中可应用；表中只保存 `peer_fingerprint`、状态、代次和绑定码哈希，不含 peer、context token 或 cursor。
- 绑定码是 `randomBytes(16)` 生成的 128-bit/32 位 hex 值，TTL 为 10 分钟；提交后清除哈希与过期时间。服务层测试验证重绑代次递增、旧任务取消。
- 内部绑定端点要求独立 HMAC、13 位时间戳、16–128 位 nonce，并在 60 秒窗口内拒绝重放；实测重放为 401。
- Hermes `owner_changed` 在 Server 出队前校验绑定状态与精确代次；重绑会取消旧代次任务，`result_unknown` 映射为不可自动重试。
- Gateway 的 Hermes 配置对仓库外 0600/0700 文件、1–10 唯一 peer 映射、同键并发/重启和 unknown 不二次调用有测试覆盖。
- overlay 源码中未发现 Agent、AI/model、provider tool、自动 reply、typing 或 media 路径；capture 原语对非目标 DM/群聊/无 token 输入返回 ignored，发送路径是纯文本单次调用。
- 业务数据库、Server 公开绑定响应和访问日志结构均未包含原始 peer、context token、cursor 或绑定码哈希；该项为静态与隔离 API 验证，非真实微信运行验证。

### 失败项、复现步骤与建议

#### 历史 P1-1（已修复）：Server 与现有 Gateway 的 HMAC 头及代次 schema 不兼容

证据：

- [server/src/services/hermes-notification-channel.ts](/home/yj/xiansuo/server/src/services/hermes-notification-channel.ts:18) 始终向 Gateway 发送 `generation`。
- [poc/ilink-gateway/src/types.ts](/home/yj/xiansuo/poc/ilink-gateway/src/types.ts:11) 的严格 `deliveryRequestSchema` 未声明 `generation`。
- Server 发送 `x-hermes-gateway-timestamp/nonce/signature`，而 [poc/ilink-gateway/src/auth.ts](/home/yj/xiansuo/poc/ilink-gateway/src/auth.ts:4) 仅接受 `x-ilink-gateway-timestamp/nonce/signature`。
- 最小复现输出：`withoutGeneration: true`，`withGeneration: false`，错误为 `Unrecognized key: "generation"`。
- 实际隔离 HTTP Gateway 复现：以 Server 的 HMAC canonical 值和 `x-hermes-gateway-*` 发送，返回 `401 ILINK_SIGNATURE_INVALID`；仅替换为 `x-ilink-gateway-*` 后返回 `400 ILINK_REQUEST_INVALID`，adapter 未被调用。

复现：启动隔离 Gateway，使用与 Server 相同的 `POST /deliveries` 正文、HMAC canonical 和 `x-hermes-gateway-*` 头；再只替换为 `x-ilink-gateway-*` 头。前者为 401，后者因 generation 为 400。

预期：Gateway HMAC 验证后接收并将 `recipientUserId + generation` 原样作为 Hermes 路由约束。

实际：请求先在 HTTP 认证层被拒绝；即便只修正头名称，仍在 schema 层被拒绝。Server 只能把这些无 `data` 的响应归为 `result_unknown`，Worker 随即终结且不重试。真实负责人变更通知不能送达。

建议：统一 Server/Gateway 的受版本控制 HMAC header 名称与 canonical contract；然后在 Gateway 请求 schema、服务路由、幂等指纹、recipient resolver 和 adapter request 中显式加入并强制校验 generation。代次必须参与路由与幂等冲突判断，而非仅由 Server 出队前校验。

#### 历史 P1-2（已修复）：capture-only 未实现可运行长轮询 daemon

证据：

- [poc/hermes-weixin-transport/src/hermes_weixin_transport/cli.py](/home/yj/xiansuo/poc/hermes-weixin-transport/src/hermes_weixin_transport/cli.py:55) 仅提供 `capture` 和 `send`。
- [poc/hermes-weixin-transport/src/hermes_weixin_transport/multi_user.py](/home/yj/xiansuo/poc/hermes-weixin-transport/src/hermes_weixin_transport/multi_user.py:87) 只有注入式 `capture_inbound` 原语；仓库没有调用它的 poll/daemon。
- CLI 的 `capture` 使用旧 `TokenState` 静态 allowlist，不调用 `MultiUserVault`，也不向 Server 的 prepare/commit/refresh 内部端点发起 HMAC 请求。

复现：搜索 `daemon`、`poll`、`MultiUserVault`、`capture_inbound`；或运行 `python -m hermes_weixin_transport --help`，命令集只有 `capture|send`。

预期：在明确启用后，有一个受控、可启动、可停止的 capture-only 长轮询进程，将 allowlist DM 的绑定命令经 HMAC prepare/commit/refresh 写入外部 vault；不回复任何消息。

实际：人工把一份入站 JSON 喂给一次性 CLI 只能写旧单配置状态，不能完成当前 Server 多用户绑定闭环。

建议：实现并测试独立 capture daemon（包括启动/停止、网络/异常恢复、cursor、限流、进程权限）；它必须使用 `MultiUserVault`，并以 HMAC 调用 Server 内部绑定协议。完成前不要开启 `HERMES_BINDING_ENABLED`。

#### 历史 P1-3（已修复）：Gateway 未使用 binding generation 做 recipient/vault 隔离

证据：

- [poc/ilink-gateway/src/gateway-service.ts](/home/yj/xiansuo/poc/ilink-gateway/src/gateway-service.ts:24) 仅以 `recipientUserId` 从静态 peer map 取目标。
- [poc/ilink-gateway/src/adapters/hermes-adapter.ts](/home/yj/xiansuo/poc/ilink-gateway/src/adapters/hermes-adapter.ts:54) 只把 peer、text、idempotencyKey 传给 overlay。

预期：Gateway/overlay 以 `(recipientUserId, generation)` 查询同一外部绑定 vault，并拒绝过期或不匹配的代次。

实际：即使修复 P1-1 的 schema，Gateway 仍没有把 generation 交给 overlay，也不会依据代次解析 token/cursor；重绑与 Worker 检查之间的竞态无法在下游关闭。

建议：用只含 userId + generation 的受控 overlay 请求替换静态 raw peer map 路由；在 Gateway 和 overlay 两侧再次精确核对代次。

#### P2

无已确认 P2；该描述仅保留初测时的风险分级，最终状态以本报告顶部结论为准。

#### 历史 P3（已修复）：内部 HMAC replay Set 没有容量上限

[server/src/routes/hermes-bindings.ts](/home/yj/xiansuo/server/src/routes/hermes-bindings.ts:11) 使用进程级 `Set` 保存 nonce，60 秒后删除，但没有总量限制。拥有内部 secret 的异常调用方可在窗口内制造大量唯一 nonce，占用内存。

建议：使用有界 TTL replay cache（最大容量、拒绝策略和安全计数日志）；不要记录 nonce/原始请求正文。

### 数据完整性、迁移与回滚前提

- `001`–`007` 的 checksum 未变；008 通过重建 `notification_logs` 增加 `recipient_binding_generation` 和 `hermes` channel。隔离迁移回归验证了记录/外键/索引及事务回滚。
- 008 是前向 schema 变更，没有实现降级迁移。上线前仍需以生产副本进行备份、完整性校验、升级演练和明确回滚策略；不得直接在生产库试错。

### 测试阶段产生的文件变化

- 更新：[TEST_REPORT.md](/home/yj/xiansuo/docs/03-测试验证/TEST_REPORT.md)。
- 新增独立验证测试：[test_daemon_verifier.py](/home/yj/xiansuo/poc/hermes-weixin-transport/test/test_daemon_verifier.py)，仅覆盖 daemon HMAC、`item_list`、群聊拒绝和 generation 隔离；未改业务实现。
- 构建产物、`/tmp` 隔离数据库和临时安全文件均为工具生成或已删除；没有修改 `app/src`、`server/src`、`scripts`、`deploy` 或 `server/data`。
- 除本报告外，`git status --short` 与测试开始前一致；现有未提交实现改动不归因于测试阶段。

### 放行结论

**允许进入验收阶段。** 历史 P1-1/P1-2/P1-3/P1-4 与 P3 已按本报告复验通过；`result_unknown` 重启后不重试、OpenClaw/Mock 回归、daemon 无 Agent/AI/reply/typing/media、敏感标识不落业务 DB/日志和 008 迁移契约均已复验。上线仍需单独授权真实微信 Pilot，并以生产副本完成备份与迁移演练。

### 34.1 最终加固复测追加记录（2026-08-08，当前工作区）

本追加记录为第 34 节的**最新结论**，保留上述历史测试轨迹但覆盖其“允许进入验收”的放行判断。

**结论：FAIL，不允许进入验收阶段。** 发现 1 个 P1 和 1 个 P2；四端构建、既有自动化回归及其余加固项均通过。

#### 测试环境、基线与范围

- 工作目录：`/home/yj/xiansuo`；Node `v24.18.0`、Python `python3`。开始前记录 `git status --short`、`git diff --name-only` 与 `server/data` SHA-256。实现相关未提交改动和此前报告均已存在；未恢复、覆盖或清理。
- 仅更新本报告；没有修改 `app/src`、`server/src`、`scripts`、`deploy` 或 `server/data`。`git diff --check` 通过。生产依赖/lockfile 无差异，依赖审计不适用。
- 覆盖：vault 跨进程锁/容量/peer 冲突，prepared→commit→activate 崩溃恢复，nonce 持久化与容量，停用事务，XYY 码，008 迁移，Server/Gateway/overlay/H5 回归，以及敏感数据与禁用能力静态检查。
- 未覆盖：真实微信登录、扫码、联网收发和生产备份演练；这些不是本次授权范围，且不能替代下列 P1 修复。

#### 已执行命令及结果

| 命令/隔离复现 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS，命令退出码 0；含 Hermes 绑定、迁移、OpenClaw/Mock、`result_unknown` 不重试回归。 |
| `cd poc/ilink-gateway && npm run build && npm test` | PASS，59/59。Hermes user+generation 下传、OpenClaw/Mock、并发/重启和 unknown 单次尝试均通过。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | PASS，18/18。含 daemon mock `getUpdates`、`item_list`、群聊拒绝、prepared 崩溃恢复和 send-bound 代次隔离。 |
| `cd app && npm run build:h5` | PASS；仅 H5，未验收小程序。 |
| 11 个独立 Python 进程对同一 vault `put` | PASS：`capacity_ok=10`、`capacity_blocked=1`；另一组 2 个进程同 peer 为 `conflict_ok=1`、`peer_conflict=1`。所有公开 vault 读写均经同一 `fcntl.flock` 临界区。 |
| nonce 隔离库容量/清理 | PASS：连续插入 10,000 个不同 nonce 后第 10,001 个拒绝；65 秒 TTL 后可再次插入；表仅存 SHA-256 `nonce_hash`，不含原 nonce。 |
| 008 迁移差异核对 | PASS：仅 `008`，无 `009`；`git diff --unified=0 HEAD -- server/src/db.ts` 没有 001–007 的删除/替换行，008 新增 66 行；既有 fresh、007→008、重复、checksum 和失败回滚回归均通过。 |

#### 通过项

- `MultiUserVault` 的 `put/get/cursor/set_cursor/activate/user_for_peer/binding_for_peer/prepared_entries` 均在 lock 内读写；跨进程容量和同 peer 冲突复现 fail-closed，最多 10 个非 cursor 条目。
- daemon 先持久化 prepared（含 activationId），向 Server commit 后再 activate；进程在两者之间崩溃时，重启会先对 prepared 条目重放 commit 并 activate。正确 activationId 的 Server commit 重放通过且不改变既有绑定。
- 用户主停用路由在 `BEGIN IMMEDIATE` 中更新用户、禁用绑定、取消 pending/retry_wait Hermes 任务；服务层在外层事务失败回滚时三者保持原状。
- 绑定码格式为 `XYY-[A-Z2-7]{26}`；26 个 Base32 字符承载 128-bit 随机字节。公开 API/业务 DB 不保存 raw peer、context token、cursor 或 raw nonce；H5 统一使用 `app/src/utils/request.ts`。
- daemon/overlay 静态路径未发现 Agent/model/AI 调用、自动 reply、typing 或 media 发送；群聊在提取文本之前拒绝。server/data 五个文件哈希复测前后相同：`app.db=8b8bc326…`、`app.db-shm=42a2baf3…`、`app.db-wal=194c0753…`、`leads.db/xiansuo.db=e3b0c442…`。

#### 失败项与最小复现

##### P1：active 状态 commit 重放未绑定 activationId

位置：[hermes-binding.ts](/home/yj/xiansuo/server/src/services/hermes-binding.ts:68)。active fast-path 只比较 `userId + generation + peer_fingerprint`，未比较请求中的 `activationId`；但 commit 的 prepared 路径会比较它，二者契约不一致。

最小复现：在隔离 SQLite 中生成 code、prepare，使用正确 activationId commit 成功；再以随机 UUID、相同 userId/generation/peerFingerprint 调用 `commitHermesBinding`。输出为：

```json
{"wrongActivationAccepted":true,"status":"active"}
```

预期：只有原 activationId 的崩溃恢复重放可被幂等接受；随机/错误 activationId 必须返回 `HERMES_BINDING_GENERATION_CONFLICT`。

实际：随机 activationId 被 200/成功语义接受，破坏 activationId 作为 prepared→commit→activate 关联凭证的完整性。建议 active 幂等分支也持久化并校验已提交 activationId（或采用等价的不可变 committed activationId），并补充“正确 ID 通过、错误随机 ID 拒绝”的单元和 HTTP 测试。

##### P2：内部 disable 路由不是原子事务

位置：[hermes-bindings.ts](/home/yj/xiansuo/server/src/routes/hermes-bindings.ts:35) 调用的 [hermes-binding.ts](/home/yj/xiansuo/server/src/services/hermes-binding.ts:85)。`/internal/hermes-bindings/disable/:userId` 没有包裹事务；`disableHermesBinding` 分别执行 binding 更新和通知取消。

最小复现：在隔离库对 `notification_logs` 的 cancelled 更新安装 `RAISE(ABORT,'forced')` trigger，再调用 `disableHermesBinding`。输出：

```json
{"thrown":true,"binding":"disabled","task":"pending"}
```

预期：失败时 binding 与待发任务均回滚。

实际：第一条更新已自动提交，第二条失败，留下 disabled binding 和 pending Hermes 任务。用户 `PATCH /api/users/:id` 主停用路径已自行使用 `BEGIN IMMEDIATE`，该路径通过；但内部 disable 仍会留下部分状态。建议将 disable 服务操作自身封装为可组合事务，或由该 internal route 显式包 `BEGIN IMMEDIATE/COMMIT/ROLLBACK`，并增加触发器失败回滚测试。

#### 放行与修复方向

在 P1 修复并重新验证前，**不得进入验收或开启 Hermes 绑定**。P2 应与 P1 一并修复，避免运维/内部清理路径产生不可恢复的待发任务。修复后至少重跑本节四端命令、错误/正确 activationId 双断言、internal disable 注入失败回滚，以及 10,000 nonce 和多进程 vault 压力复现。

#### 测试阶段文件变化

- 更新：[TEST_REPORT.md](/home/yj/xiansuo/docs/03-测试验证/TEST_REPORT.md)（本追加记录）。
- 除本报告外，测试后 `git status --short` 与开始基线一致；构建和隔离数据库均未写入业务数据目录。

### 34.2 P1/P2 修复后最终独立复测（2026-08-08，当前工作区）

本记录是第 34 节的**最终结论**；34.1 的 P1/P2 失败证据保留用于追溯，已由本次实际复测关闭。

**结论：PASS，允许进入验收阶段。** 本轮无遗留 P1、P2 或 P3。

#### 修复复测结果

| 验证项 | 独立实际结果 |
| --- | --- |
| P1：active commit 与 activationId | PASS。正确 activationId 在 active 状态的重放保持幂等；同一 userId/generation/peerFingerprint 配随机 UUID 被拒绝。隔离输出：`{"correctReplayAccepted":true,"wrongReplayRejected":true}`。active 记录仅保存 activationId 的 SHA-256 派生哈希，不保存原 ID。 |
| P2：internal disable 失败回滚 | PASS。对通知取消安装 `RAISE(ABORT,'forced')` trigger 后，standalone `disableHermesBinding` 抛错并回滚：`{"active":1,"binding":"active","task":"pending"}`。 |
| 用户停用主事务 | PASS。在同一强制第二步失败条件下，用户状态、binding、pending task 全部回滚为 `1/active/pending`；`PATCH /api/users/:id` 保持 `BEGIN IMMEDIATE`，调用 transaction 内 disable 函数，不出现嵌套事务。 |
| fresh / 007→008 / 重复迁移 | PASS。fresh 和从仅含 001–007 的库升级均得到 `001…008`；重复运行 ledger 不变，新增 `active_activation_id_hash` 列存在。隔离输出 `repeatStable:true`。 |
| 迁移边界 | PASS。MIGRATIONS 无 `009`；`git diff --unified=0 HEAD -- server/src/db.ts` 未出现 001–007 的 version/checksum/description 删除或替换行，`git diff --check` 通过。 |
| 完整回归 | PASS：`cd server && npm run build && npm test` 退出码 0；`cd poc/ilink-gateway && npm run build && npm test` 59/59；`cd poc/hermes-weixin-transport && ./run-tests.sh` 18/18；`cd app && npm run build:h5` 通过（仅 H5）。 |

#### 兼容性、安全与数据复核

- Gateway/OpenClaw/Mock、`result_unknown` 单次终态、user+generation overlay 隔离、daemon prepared 崩溃恢复、flock 多进程容量与 peer 冲突、durable nonce 哈希/10,000 容量/清理、XYY 26 位 Base32、无 Agent/AI/reply/typing/media 的先前独立复测仍适用，且本轮相关四端回归未回归。
- 测试前后 `server/data` SHA-256 一致：`app.db=8b8bc326…`、`app.db-shm=42a2baf3…`、`app.db-wal=194c0753…`、`leads.db/xiansuo.db=e3b0c442…`。隔离 SQLite 均在内存或 `/tmp`，未写业务数据目录。
- 生产依赖和 lockfile 无差异，生产依赖审计不适用。真实微信登录、扫码、联网收发及生产副本备份/升级演练仍未执行，须在上线授权后单独进行受控 Pilot；它们不阻塞代码验收。

#### 测试阶段文件变化与放行

- 本轮仅更新：[TEST_REPORT.md](/home/yj/xiansuo/docs/03-测试验证/TEST_REPORT.md)。未修改业务源码、部署文件或 `server/data`；开始前存在的未提交实现改动保持原状。
- **允许进入验收阶段。** 上线前仍应执行已批准的真实微信 Pilot 与生产备份/迁移演练。

### 35. Hermes 两步式 H5 绑定页独立测试计划（2026-08-09，执行前）

本节只验证当前未提交的 H5 绑定页改动；开始基线为 `git status --short` 中的
`app/src/pages/hermes-binding/index.vue`、`app/test/h5-runtime.spec.ts`、
`docs/00-项目说明/README.md`、`docs/02-开发实现/CHANGELOG.md` 四项已跟踪改动及
未跟踪 `app/src/config/hermes-bot-entry.ts`。这些均为测试前已有内容，测试不得恢复、
覆盖或归因。开始时 `git diff --check` 通过。

计划：

1. 审查完整 diff、构建配置和请求调用链，确认没有新增 API/迁移/生产依赖，页面所有 API 请求均经 `request.ts`。
2. 分别以未配置、非法 URL、合法 HTTPS URL 构建 H5，检查页面/制品：未配置或非法时不产生图片或 Hermes/iLink 登录二维码；合法公开入口才渲染/可复制。
3. 运行 H5 真实浏览器回归，验证登录用户生成 `绑定 XYY-…` 的精确命令、剪贴板复制、10 分钟倒计时、轮询成功、401 会话清理；补充过期和页面卸载后零轮询请求观察。
4. 对 H5 制品和相关源码进行登录二维码、token、peer、session 敏感内容静态扫描；运行 `git diff --check`。
5. 运行 `cd app && npm run build:h5`、`npm run test:h5`、`npm run test:e2e`；因本次前端实现/测试通过既有 Hermes Server API 联动，运行 `cd server && npm run build && npm test`。依赖/lockfile 未变化，不额外运行生产依赖审计。
6. 在报告中记录每个命令、失败最小复现、证据路径、严重级别、测试后 Git 差异和放行结论。

### 35.1 最终独立复核结果（2026-08-09）

**结论：PASS；实际 Playwright 用例 10/10 通过；P1=0、P2=0、P3=0。允许进入验收阶段。**

#### 环境、基线与范围

- 工作目录：`/home/yj/xiansuo`；仅验证 H5。测试前 `git status --short` 为 `app/src/pages/hermes-binding/index.vue`、`app/test/h5-runtime.spec.ts`、`docs/00-项目说明/README.md`、`docs/02-开发实现/CHANGELOG.md`、`docs/03-测试验证/TEST_REPORT.md` 五项已跟踪修改，及未跟踪目录 `app/src/config/`（其中为 `hermes-bot-entry.ts`）。这些均为已有改动，未恢复、覆盖、暂存或清理。
- 对第 35 节执行前记录作更正：该节的文字清单遗漏了当时已修改的 `TEST_REPORT.md`，实际 Git 基线以上述状态输出为准；本次只追加本复核结果。
- 覆盖：绑定码完整命令/复制/倒计时/成功轮询、未配置降级、401 会话清理、离页延迟 GET、合法/非法构建期入口配置、制品敏感信息、差异与依赖/API/迁移边界。未覆盖真实微信、真实 HTTPS 图片内容、生产环境变量和生产数据库；这些不在本次 H5 验收授权内。

#### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd app && npm run build:h5 && npm run test:h5` | 通过；`test:h5` 内再次构建后，Playwright 显示 **10 tests**，退出码 0。构建仅有“未配置 Appid，统计不可用”和可选 uni-app 更新提示。 |
| 合法配置：`VITE_HERMES_BOT_ENTRY_URL=https://bot.example.com/hermes-contact VITE_HERMES_BOT_ENTRY_IMAGE_URL=https://cdn.example.com/hermes-contact.png npm run build:h5` | 通过。隔离 Fastify + Chromium 登录后进入绑定页，实际显示“已验证的 Hermes 机器人入口”；点击复制后剪贴板精确为 `https://bot.example.com/hermes-contact`。 |
| 非法配置：`VITE_HERMES_BOT_ENTRY_URL=http://bot.example.com/not-allowed VITE_HERMES_BOT_ENTRY_IMAGE_URL=https://user:pass@cdn.example.com/not-allowed.png npm run build:h5` | 通过。隔离 Chromium 实际显示“机器人入口尚未配置”，已验证入口/图片/复制按钮的计数均为 0。 |
| 无入口配置：`cd app && npm run build:h5` | 通过；恢复为无配置制品。既有 H5 用例也验证此状态的人工索取提示。 |
| `git diff --check`、`git status --short`、包和锁文件差异检查 | 通过；结束状态除本报告内容外与测试前基线一致，`app`/`server` 的 `package.json` 和 lockfile 无差异。 |
| 制品扫描：`rg -a` 检查登录二维码、Hermes/iLink token/peer/session/凭据以及验证 URL | 通过。最终无配置制品不含两条验证 URL，也未命中 Hermes/iLink 凭据模式或登录二维码文件/路径；命中的 `data:image` 仅为现有站点 favicon 与 uni-app 加载动画 SVG，不是二维码。 |
| `.playwright-cli` 与隔离目录检查 | 通过；未生成 `.playwright-cli`，`/tmp/xiansuo-hermes-ui-mriWFW` 已删除。 |

#### 通过项与证据

- 页面请求仅从 `app/src/utils/request.ts` 导入 `get`、`post`、`request`；没有在业务页面直接使用 `fetch` 或 axios。轮询静默错误使用同一封装的 `request(..., { showError: false })`。
- `app/test/h5-runtime.spec.ts` 的 Hermes 成功场景覆盖精确 `绑定 XYY-<26 位 Base32>`、剪贴板、剩余时间、内部 prepare/commit 后的“绑定成功”；离页用例在路由卸载、已发 GET 返回、再等待 2.3 秒后断言请求数仍为 **1**。该回归本次随 10 条 H5 测试通过，验证了 `trackingGeneration`/`disposed` 对轮询重排竞态的修复。
- `app/src/config/hermes-bot-entry.ts` 只接受无用户名/密码的 HTTPS URL；真实浏览器分别验证合法公开入口可见/可复制，以及 `http:`、userinfo HTTPS 均 fail-closed。未配置状态也由自动化 H5 用例覆盖。
- 差异中没有 `server/src`、迁移、路由或包/锁文件变化；绑定页仅调用既有 `/api/hermes-binding` 与 `/api/hermes-binding/code`。因此无需本轮生产依赖审计，也未发现新增 API 或迁移。

#### 失败项、风险与建议

- 无可复现失败项，P1/P2/P3 均为 0。
- 残余范围：上线前仍应由受控部署流程复核实际公开入口的归属、内容和 HTTPS 证书；不得把登录二维码、token、peer、session 或任何凭据作为 `VITE_HERMES_BOT_ENTRY_*` 值。真实 Hermes/微信流程仍须遵循既有单独 Pilot 授权。

#### 测试阶段产生的文件变化与放行

- 本测试阶段仅更新本报告第 35.1 节；构建输出为被 Git 忽略的 `app/dist/build/h5/`，隔离 SQLite/secret 只在精确的 `/tmp/xiansuo-hermes-ui-mriWFW` 下创建且已删除。未修改 `app/src`、`server/src`、`scripts`、`deploy` 或业务数据目录。
- **允许进入验收阶段。** 本结论是 H5 代码与离线浏览器验证结论，不构成真实微信登录、消息发送或生产部署授权。

### 35.2 验收阶段发现的 active 重绑 P2 与修复复测（2026-08-09）

第 35.1 节的 `P1/P2/P3=0` 是进入验收前的历史结论，未覆盖已绑定用户的二次发码。
验收阶段对该分支进行独立代码路径复现后确认 **P2**：服务端为 active 用户发放新码时
会正确保留旧 `active` 状态并返回本次非空 `expires_at`；旧页面仅看到 `active`
就立即显示“绑定成功”、隐藏新命令并停止轮询，导致已绑定用户无法完成重绑。

修复与回归：

- 页面只在 `status === 'active' && expires_at === null` 时确认本次码已 commit；轮询以本次 `bindingConfirmed` 为终止信号，不再被旧 active 状态提前截断。
- H5 新增独立 active 重绑用户，在测试自身的 `tempDir/runtime.sqlite` 精确回拨该用户 `last_code_issued_at`，避免等待 60 秒且不改生产限流。回归验证新命令不同于旧码、页面不误报成功、第二次 prepare/commit 产生下一 generation，最后轮询到成功并隐藏命令。
- `cd app && npm run test:h5` 最终退出码 0；内含 H5 构建和 Playwright **11/11**。仅有既有 Appid/可选版本提示。
- 最终 `git diff --check` 通过；package/lockfile 和 Server 源码无差异。无配置 H5 制品未命中测试 Secret/peer 或合法/非法入口 fixture，也无 Hermes 登录二维码图片路径；测试临时 SQLite/secret 目录已由 `afterAll` 删除，无遗留 `xiansuo-h5-runtime-*`/`xiansuo-hermes-ui-*` 目录。

最终分级：**P1=0、P2=0、P3=0**；本 P2 已关闭。仍未提供或人工核验真实长期公开联系人入口，也未部署、登录、扫码、联网或发送；这些不得写成通过。

### 36. 每网站用户独立 Hermes 账号 + H5 串行 QR 绑定独立测试（2026-08-09）

**结论：FAIL，不允许进入验收阶段。** 本节以主代理明确的高风险实现范围为准执行第三阶段独立验证。发现 1 项 P1、2 项 P2；此外 H5 基线套件有 1 条失败。未修改任何业务源码、部署代码或既有测试断言。

#### 环境与测试前基线

- 工作目录：`/home/yj/xiansuo`，分支 `feature/hermes-per-user-qr-binding`；Node `v24.18.0`，Python 3，Chromium/Playwright 可用。
- 已完整读取根 `AGENTS.md`、用户高风险验收要求、现有设计/实施摘要、当前差异。设计目录中的历史“暂停真实外部渠道”说明仅作为背景；本节按本次明确的 per-user QR 实现验收。
- 测试前 `git status --short` 记录 30 个已修改跟踪文件和 3 个未跟踪实现文件：`poc/hermes-weixin-transport/src/hermes_weixin_transport/account_manager.py`、`poc/hermes-weixin-transport/test/test_account_manager.py`、`server/src/services/hermes-account-manager.ts`。这些均认定为实施阶段既有改动，未恢复、覆盖、清理或归因给测试。
- 测试前 `git diff --name-only` 与本节结束前除本报告外一致；`git diff --check` 通过。`server/data/` 为 Git 忽略目录，结束 SHA-256：`app.db=8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2`、`app.db-shm=42a2baf3a04f32142eed5a6b9eb477ae1a8c1ffc38e7124e0342c561b74c38`、`app.db-wal=194c0753141ffbc228cc791ef5627e5a1e4da3dbad325296547b25b32a839c4e`、空的 `leads.db/xiansuo.db=e3b0c442…`；本轮隔离库均在内存或 `/tmp`，没有测试写入该目录。

#### 范围、通过项与未覆盖项

- 已覆盖：001--009 空库、008→009、重复、checksum 冲突、故意失败回滚、FK/integrity；QR attempt 的 TTL/取消/全局锁/上下文门槛；nonce 持久化/容量；Vault 权限、完整性、flock、原子写入、容量；Gateway 三元组与单次未知结果；H5 H5-only 构建与浏览器交互；默认开关、loopback、上游 gate、qrcode 依赖、敏感文本与旧入口/配置静态扫描；供应链审计。
- 未覆盖且不得视作通过：真实微信登录/扫码/轮询/发送、生产数据库实际备份恢复和受控升级演练。它们需要独立授权；当前失败已足以阻断，不以真实操作替代离线门禁。
- 已通过的核心证据：migration 空库与 008→009、checksum 冲突/故障回滚、历史 users/leads/notifications、FK/integrity 的既有与本轮回归均通过；009 复制字段与索引、全局唯一 live attempt、5 分钟 TTL、owner-only 服务函数、确认前不可 active、HMAC 时间窗+哈希 nonce/10,000 容量、固定 loopback URL、Vault 0600/0700/non-symlink/flock/atomic/tamper fail-closed、10 个容量上限、Gateway 的 `userId+generation+accountRef`、无 tokenless/default/retry、`result_unknown` 保持终态均有实际覆盖。

#### 已执行命令及结果

| 命令/检查 | 结果 |
| --- | --- |
| `cd server && npm ci && npm run build` | 通过。`npm ci` 报 2 个 high（安装时）且有未批准 install-script 提示；构建通过。 |
| `cd server && npm test` | **159/159 通过**（第二次输出落入 `/tmp/xiansuo-server-hermes-verify.log` 后获得精确 TAP 计数）。 |
| `cd poc/ilink-gateway && npm ci && npm run build && npm test` | 通过，**59/59**。验证三元组透传、并发/重启下单次调用、错误/超时为 `result_unknown`。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | 通过，**24/24**。fixed upstream gate、fake provider、精确确认命令、错误账号/目标/命令零激活、Vault 篡改与容量均通过。 |
| `cd app && npm ci && npm run build:h5` | 通过，仅 H5；无 Appid/可选 uni-app 更新提示。 |
| `cd app && npm run test:h5` | **失败：10 项中 9 通过、1 失败**；失败项见下。独立取消轮询用例重跑通过。 |
| migration 009 trigger 故障注入（001--008 后创建 `notification_probe` trigger，再执行 009） | **失败**：`sqlite_master` 返回 `trigger:null`；同时 `integrity_check=ok`、`foreign_key_check=[]`，说明是静默功能丢失。 |
| `npm audit --omit=dev --json`（server/app） | server：3 high（`brace-expansion`/`minimatch`、`fast-uri`）；app：2 high（`nanoid`、直接 dev-server 依赖 `vite`）。本次无 package/lockfile 差异，仍如实记录。Gateway 生产审计为 0。 |
| `git diff --check`、敏感文本/制品扫描、配置扫描 | diff-check 通过；无 `VITE_HERMES_BOT_ENTRY` 制品残留。发现 legacy shared-account 模块与 `ILINK_HERMES_RECIPIENT_MAP_FILE` 仍在仓库、可被配置解析，见 P2。 |

#### 失败项、最小复现与修复方向

| 严重级别 | 失败项 | 最小复现 / 实际结果 | 预期与建议 |
| --- | --- | --- | --- |
| **P1** | 009 重建 `notification_logs` 丢失已有 trigger | 运行 `MIGRATIONS.slice(0,8)`；执行 `CREATE TABLE trigger_probe(v INTEGER); CREATE TRIGGER notification_probe AFTER INSERT ON notification_logs BEGIN INSERT INTO trigger_probe VALUES (NEW.id); END;`；执行 009；查询 `sqlite_master`。实际 `notification_probe` 消失。`addHermesPerUserQrBindings` 仅收集 type=index 的 SQL，随后 `DROP TABLE notification_logs`。 | 必须保留 notification_logs 的字段、数据、索引**和 trigger**。在重建前读取该表 triggers 的 SQL，重命名/复制后重建，并添加失败回归测试；在受控升级前做备份/恢复演练。 |
| **P1** | 008 的 active 共享绑定会在 009 自动 `disabled`，没有可执行上线前预检/受控重绑门禁 | 001--008 后插入 `status='active', account_ref=NULL`，执行 009；实际 `{status:'disabled', generation:1, account_ref:null}`。代码无条件执行 `UPDATE hermes_bindings SET status='disabled' ...`。既有 Hermes pending 投递会在 worker 校验时取消，形成存量用户静默停发。CHANGELOG 虽写“必须重新绑定”，未提供 active 数量预检、阻断/维护窗、完成确认或回滚条件。 | 每账号必须独立，因此不能把共享账号错误升级为私有账号；但发布应先统计并显式确认受影响 active/待发任务，提供停发公告、受控重绑完成率与回滚前提。没有这些上线门禁前不得运行 009 于生产。 |
| **P2** | H5 真实浏览器 QR 展示回归失败 | `cd app && npx playwright test test/h5-runtime.spec.ts --grep "Hermes QR 页面展示" --reporter=line`。失败于 `app/test/h5-runtime.spec.ts:172`：`getByTestId('hermes-qr-image')` 命中 `<uni-image>`，其宿主没有 `src`，5 秒后断言失败；错误上下文：`app/test-results/h5-runtime-Hermes-QR-页面展示受限-data-QR，轮询后要求精确确认命令/error-context.md`。取消轮询用例单独重跑通过。 | 不得删除或放宽 data-QR 断言；应以真实渲染的内部 `<img>`/组件公开契约断言 data URL，并保留截图/DOM 证据，随后整套 H5 复跑至通过。当前不能写成已验收。 |
| **P2** | 旧 shared-account 长期入口/配置实现仍残留 | 静态扫描命中 `config.py`、`state.py`、`multi_user.py`、`daemon.py` 的 `account_id`/`ilink_token`/`allowed_from`/capture 路径；Gateway `config.ts` 仍接受 `ILINK_HERMES_RECIPIENT_MAP_FILE`（仅警告忽略），且保留 `readHermesRecipientMapFile`。CLI 未公开 legacy command，但相关模块仍可导入。 | 按“旧/code 退役、禁止个人/长期入口配置残留”要求删除或隔离不可达旧实现与受管环境变量，并增加反向扫描/配置拒绝测试；不要只靠注释或忽略该配置。 |

#### 额外安全与兼容性证据

- server manager URL 和 account-manager config 都限制 HTTP loopback；manager callback 的 nonce 哈希持久化、60 秒时窗和 10,000 上限已在 SQLite/Vault 测试中通过，原始 nonce 未落库。
- `qrcode`：系统 Python 缺失该依赖时会 fail-closed；固定 `/tmp/hermes-agent-v2026.8.3/.venv/bin/python` 实测可 `import qrcode`，上游 `pyproject.toml` 固定 `qrcode==7.4.2`，满足运行依赖 gate。
- QR、provider accountId/token、target/context/cursor 未写入 business SQLite；QR 只在 owner `no-store` 响应返回且路由/数据库无 raw 值。账户管理器没有调用 `qr_login` 或 `save account`；无 AI/Agent/reply/typing/media 调用路径。
- 账户/target/token/context/cursor、错误 account/target/code/activation、vault 交换/缺失及单账户 poll 故障隔离：fake-provider/overlay/Gateway 现有离线覆盖通过；真实 provider 未获授权，未执行。

#### 测试阶段文件变化与放行

- 本阶段新增的唯一版本控制变化是本报告第 36 节；`app/dist/`、`node_modules/`、`app/test-results/` 和 `/tmp/xiansuo-server-hermes-verify.log` 为工具产物/临时日志，不纳入业务改动。开始前的 30 个修改文件及 3 个未跟踪实现文件保持存在；未修改 `app/src`、`server/src`、`scripts`、`deploy` 或 `server/data`。
- **不允许进入验收阶段。** 条件放行至少需要：修复/回归 009 trigger 保留；对 008 active 存量制定可审计的迁移预检与重绑/回滚门禁；修复 H5 data-QR 真实浏览器断言并取得全绿；清理或明确隔离旧 shared-account 配置/入口后重跑受影响测试。

#### 36.1 P1/P2 修复后独立复测（2026-08-09）

**结论：仍为 FAIL，不允许进入验收阶段；此前两个业务 P1 已关闭，当前 P1=0、P2=2、P3=0。** 未修改业务源码或测试源码，只追加本结果。

| 复测项 | 独立实际结果 |
| --- | --- |
| 009 trigger 保存与实际执行 | **PASS。** 001--008 后创建 `notification_probe AFTER INSERT ON notification_logs`，执行 009 后 trigger 仍在；插入任务令 probe=1，`idx_notification_hermes_account` 索引存在，`integrity_check=ok`、`foreign_key_check=0`。实现现已在 DROP 前读取 trigger SQL 并在 rename 后恢复。 |
| 009 失败回滚前提 | **PASS（事务边界与现有 failure 测试）。** 迁移 runner 使用 `BEGIN IMMEDIATE`，任何 rebuilding/trigger 恢复异常均在同一事务 `ROLLBACK`；160 条 server 用例包含迁移失败/rollback 及 trigger 恢复。未对 SQLite 系统表做不安全篡改来制造无效 trigger SQL。 |
| 008 active + pending 升级 / rebind_required | **PASS。** 008 active 行升级后保持 DB `status=active,generation=1,account_ref=NULL`，pending Hermes 任务保持 pending；公开 API 将该组合映射为 `{status:'rebind_required',generation:4,expires_at:null,mode:'per_user_qr'}`，响应 `Cache-Control: no-store`。不再自动 disabled 或静默取消。 |
| 新 QR 重绑原子边界 | **PASS。** 新 attempt 创建及错误 accountRef 激活不改变旧 pending 任务；取得 exact context 后 active commit 原子切换，并取消旧 generation/accountRef 任务。服务层、160 条回归和定向 SQL 验证一致。 |
| JWT owner-only、锁与 no-store | **PASS。** 真实 Fastify inject：owner POST 成功并只返回 data QR，第二用户 POST=423，第二用户 GET=404，owner DELETE 后第二用户可创建；owner 响应为 `no-store`，QR 未进入 URL。 |
| Gateway/overlay 新路径 | **PASS（定向部分）。** Gateway build/test **59/59**；adapter argv 仅为 `send-bound --manager-config <private-file>`，精确三元组保留，未知结果不重发。`ILINK_HERMES_RECIPIENT_MAP_FILE` 已被 schema 当作未知受管变量拒绝；默认 CLI command 不公开 legacy capture/daemon。旧 helper 模块仍为历史离线验证代码，但新路由没有读取 legacy map/vault 或 MultiUserVault。 |
| manager/vault/A--F 其余安全矩阵 | **PASS（既有离线覆盖未回归）。** loopback、HMAC+nonce、容量、0600/0700/non-symlink/flock/atomic、固定上游/qrcode、provider host、target/account/context exact match、无 AI/reply/typing/media、十账号上限、single-attempt/result_unknown 均在 server/Gateway/overlay 覆盖中保持。 |

#### 当前失败项与最小复现

| 严重级别 | 项目 | 命令、预期、实际与建议 |
| --- | --- | --- |
| **P2** | account manager 全量测试非确定性失败 | `cd poc/hermes-weixin-transport && ./run-tests.sh`：**23/24**。`test_fake_qr_confirm_requires_exact_command_and_account` 夹具把 `expiresAt` 固定为 `2026-08-09 10:00:00`；当前时点已过，实际 `expired`，预期 `awaiting_context`。将该单一测试夹具改为远期固定日期后，不降低“精确命令/账号”断言，重跑 24/24。 |
| **P2** | H5 真实 data-PNG 可见性仍未通过 | `cd app && npm run test:h5` 在 `test/h5-runtime.spec.ts:163` 失败；单例重跑显示 `getByTestId('hermes-qr-image').locator('img')` 5 秒内不存在。fixture 使用 `data:image/png;base64,AA==`，它不是有效 PNG，且 2 秒后 mock 即切到 `awaiting_context`。取消停轮询单例 `--grep "Hermes QR 页面取消"` 通过。必须替换为有效最小 PNG、保持 waiting 到可见断言完成，并保留 `uni-image > img` 的 data URL/可见性断言和截图证据，再跑全套 H5。 |

#### 本轮完整命令与工作区复核

- `cd server && npm run build && npm test`：通过，**160/160**。
- `cd poc/ilink-gateway && npm run build && npm test`：通过，**59/59**。
- `cd poc/hermes-weixin-transport && ./run-tests.sh`：失败，**23/24**（上述 P2）。
- `cd app && npm run test:h5`：构建通过、Playwright QR 可见性项失败（上述 P2）；取消轮询单例通过。
- `git diff --check`：通过。`server/data` 五个 SHA-256 与第 36 节记录一致；本轮没有业务数据目录差异。测试后 Git 状态相对本轮开始基线仅本报告继续追加，32 个实施差异和 3 个未跟踪实现文件均被保留。
- 因 package/lockfile 仍无变化，沿用第 36 节已执行的生产依赖审计记录；未新增依赖。

**放行条件：** 两条 P2 都以不降低断言的方式修复并取得 overlay 24/24、H5 全绿后，重新执行受影响套件及本节迁移/API/Gateway 定向检查；在此之前不得进入验收阶段。

#### 36.2 P2 最终独立复测（2026-08-09）

**最终结论：PASS，允许进入验收阶段；P1=0、P2=0、P3=0。** 本轮只复跑修复所影响的 overlay 与 H5 套件；server 160/160、Gateway 59/59、迁移/API/三元组定向检查沿用 36.1 的已通过、且本轮差异未触及其实现。

| 复测项 | 命令与独立结果 |
| --- | --- |
| account manager 的过期时间夹具 | `cd poc/hermes-weixin-transport && ./run-tests.sh`：**24/24 通过**。此前失败的 `test_fake_qr_confirm_requires_exact_command_and_account` 现使用远期固定 expiry，仍保留精确账号与确认命令断言，未放宽安全断言。 |
| H5 data-PNG、确认命令和取消轮询 | `cd app && npm run test:h5`：H5 build 成功、Playwright **10/10 通过**。QR 用例确认 `uni-image > img` 可见且 `src` 为 `data:image/png;base64,`，在可见断言后才推进扫描/确认状态，并断言精确确认命令和复制值；取消用例仍断言 DELETE 一次、等待 2.3 秒后 poll=0。 |
| 差异与归因 | `git diff --check` 通过。工作区仍保留实施阶段 32 个差异和 3 个未跟踪实现文件；本验证阶段只追加本报告，未修改业务源码、部署文件或 `server/data`。 |

此前第 36 节与 36.1 中的 P1/P2 为历史发现和修复前证据，保留以便审计；上述最终复测已关闭全部阻塞项。真实微信/provider 的生产演练仍未获授权，属于已声明的非本地测试覆盖边界，不能解读为已执行。

#### 36.3 H5 确认命令即时查询 UX 复核（2026-08-09）

**结论：PASS，允许提交；P1=0、P2=0、P3=0。** 本次低风险差异仅涉及 `app/src/pages/hermes-binding/index.vue` 与其 Playwright 回归，未新增 API、迁移或生产依赖。

- `checkConfirmation()` 与自动轮询共用 `refreshAttempt()`，统一经 `app/src/utils/request.ts` 对当前 attempt 执行 `GET /api/hermes-binding/qr-attempts/:id`；没有直接 fetch/axios 或新接口。
- `scanned`/`awaiting_context` 均展示“我已发送确认命令”。手动 GET 返回 scanned 或 awaiting_context 时分别显示等待确认/接收的提示，且断言不存在成功文案；网络失败时显示“查询绑定状态失败，请稍后重试”，同样不显示成功。
- 仅 `active` 分支会 `clear()`、重新 `load()` binding 并展示成功；浏览器回归确认绑定状态刷新为“已绑定”。非终态错误在自动轮询的 `finally` 中仍安排下一轮，不改变原有轮询恢复语义；取消用例仍验证 DELETE 一次且随后 2.3 秒无 poll。
- 执行：`cd app && npm run build:h5` 通过；`cd app && npm run test:h5` 通过，Playwright **10/10**。为覆盖此前未覆盖的网络失败路径，本验证阶段在既有 Hermes H5 用例补充了请求 abort 后的失败提示/无成功断言，未放宽原断言。`git diff --check` 通过。

#### 36.4 AccountManager pinned item_list 解析复核（2026-08-09）

**结论：PASS，允许提交；P1=0、P2=0、P3=0。** 差异仅为 `account_manager.py` 与对应单元测试，没有 API、数据库、依赖或 Agent 路径变更。

- `HermesPrimitiveProvider.get_updates()` 先使用固定上游 `_guess_chat_type` 拒绝非 DM/官方群聊，再要求 `to_user_id` 严格等于当前 account、sender/context 均非空；仅在 `prepared` 生命周期读取真实 `item_list` 并调用固定上游 `_extract_text`。
- 独立回归以 pinned 原语形状的 `item_list` 注入：精确正文经 provider 归一化后贯穿 `AccountManager.poll_once()`，回调接受时状态变为 active，且 target/context/cursor 均来自同一 DM；官方群聊、错误 account 与带尾随空格的非精确确认命令均为零激活。active 调用不读取 `_extract_text`。
- `poll_once()` 不调用 provider `send`，实现亦无 Agent/AI/reply/typing/media 路径；既有错误路径断言 `provider.sends=[]` 保持。
- 执行：`cd poc/hermes-weixin-transport && ./run-tests.sh`，**30/30 通过**；`git diff --check` 通过。本验证阶段仅补充上述最小回归与本报告，未修改业务实现。
