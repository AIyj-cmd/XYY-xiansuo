# 变更日志

## Unreleased — 当前版本离线收尾（2026-08-02）

- 单账号发布冻结：保留既有多人映射解析和旧单用户兼容，但 `ILINK_POC_LIVE_ENABLED=true` 的映射模式与离线 `gateway:recipient-map-check` 均要求恰好一个 `enabled=true`；零个或多个启用项失败，检查输出只保留安全结论和聚合计数，绝不输出用户 ID 或 target。未绑定仍为 `OPENCLAW_RECIPIENT_NOT_BOUND`，不回退。
- 发布口径为单账号/单接收人 GO、多账号定向发送 NO-GO；账号 B 仅 `experimental/disabled`、不删除凭据且不生产使用，其他同事使用 H5。DeepSeek、AI Scheduler 默认关闭；`owner_changed` 固定详情/脱敏与 OpenClaw 入站静默保持已验证边界。
- 修复 H5 `package-lock.json` 的 npm v11 peer 解析记录；未改 `package.json`、直接依赖或小程序依赖。普通 `npm ci && npm run build:h5` 已作为唯一 H5 安装/构建口径。
- 增加只读离线的 `gateway:recipient-map-check`：仅校验仓库外 `0600` 多人映射并输出聚合计数，不读取 Gateway Secret、不连接 OpenClaw/微信，也不输出 target 或用户 ID。
- 部署模板的 API PM2 名称统一为 `xiansuo-api`，三项首版进程均为单实例/合并日志；运行目录、Nginx 域名和证书位置改为仓库外变量或占位符。补充当前部署、停止/回滚和同事绑定实测文档。
- 验收收紧 PM2 cwd 为必填绝对路径，修正生产 `NODE_ENV`，让 `setup.sh` 在切换前安全渲染 Nginx 域名/证书路径；部署包现包含并构建 Gateway，同步 Worker/Gateway PM2 模板，但仍不自动启动真实渠道。
- 映射检查命令改为执行已编译的 `dist/cli/recipient-map-check.js`，使生产裁剪 devDependencies 后仍可离线验证。Vite audit 保留为后续 uni-app 工具链升级门禁；生产不运行 dev server，当前 H5 为 ES module 静态制品。
- 默认继续关闭 DeepSeek、AI Scheduler、AI 日报、到期汇总及所有其他通知规则；本次未发送真实消息、未启动后台进程、未操作生产数据库或生成小程序产物。
- 最终离线验收复跑：Server build 与 `146/146`、Gateway build 与 `53/53`、H5 build 均通过；未发现真实账号 ID、target、Secret/会话凭据或完整手机号进入本次发布文档。

> OpenClaw 负责人详情提醒与入站静默：负责人变更在同一业务事务内读取 `leads` 的 `company_name`、`contact_name`、`phone`、`source`、`demand_note`、`next_follow_at`，生成不可变的清洗快照；手机号仅保留 `138****1234` 形式，Unicode `Cc`/`Cf`/`Zl`/`Zp`（含换行、零宽与双向控制字符）被归一为空格。`微信：`、微信号/ID、`wxid`、以及带分隔符的 wechat/weixin/vx/v信 标识和凭证标记不会进入可选字段，但合法来源 `微信咨询` 保留；联系人、手机号和跟进时间缺失时分别省略、省略和降级为“请尽快联系”。Gateway 除模板结构换行外拒绝这些 Unicode 类别，并以同一规则拒绝任意字段中的未脱敏大陆手机号和标识泄露，仅接受标题 `【新线索已分配】`、严格字段顺序和固定尾句。新增无网络、无存储的官方 `before_agent_reply` 本地插件，只对 `openclaw-weixin` 静默返回 `{handled:true}`，不调用模型或回复；受控安装使用 `plugins install --link` 后的显式 `config set` 和 runtime inspect，默认未安装、未启用且未修改仓库外会话配置。

> OpenClaw 轻量级多人内部通知：Gateway 新增启动时一次性加载的仓库外 `OPENCLAW_RECIPIENT_MAP_FILE`。文件必须为精确 `0600` 的严格 JSON 对象（最多 50 个规范正整数系统用户 ID 键，值为 `@im.wechat` target 和 boolean enabled）；映射模式优先，未绑定返回 `OPENCLAW_RECIPIENT_NOT_BOUND`、禁用返回 `OPENCLAW_RECIPIENT_DISABLED`，均不调用 Adapter。旧单接收人配置继续兼容并保留 `OPENCLAW_RECIPIENT_NOT_ALLOWED`，且只输出不含用户或接收人标识的弃用警告；未修改业务数据库、Worker、H5 或真实发送边界。

> 最终闭环（2026-08-01）：legacy import 会登记 generation 1 的 `result_unknown` attempt，人工确认只能写入一个终态；新 synthetic generation 必须使用新隔离 DB、新 key 和 sealed control manifest。私有 key 仅从 `0600` 文件或 stdin 读取，CLI 拒绝 argv key 和未知/重复/缺值参数。最终回归为 Gateway 44/44、Server 138/138、H5 构建通过；本轮未发送消息，仍禁止真实重跑。

> 2026-08-01 离线 result_unknown 修复补充：Gateway 状态库新增 realpath/owner/0700/0600/符号链接与硬链接门禁、内部 checksum 迁移、append-only 人工确认和审计哈希链、永久 key 占用、attempt 与线性 generation ledger。仅离线 CLI 可烧毁 legacy key、记录人工确认、准备/授权/取消 generation 和 reconcile；无 HTTP/H5 入口。超时、断连、abort、非法 JSON 和裸 5xx 均收敛为 `result_unknown`；synthetic 任务最大尝试次数为 1，并携带 sealed control manifest 与稳定 delivery request ID。历史 `result_unknown`、`manually_confirmed_not_received`、confirmed count 0 保持不改写；未实际导入外部 state、启动 daemon 或发送。

> 2026-08-02 Worker/Gateway 超时协调：Gateway `ILINK_REQUEST_TIMEOUT_MS` 明确为 Adapter 与 OpenClaw CLI 共用的完整发送窗口，默认 30000ms；Worker HTTP 窗口默认 40000ms。业务端以 `OPENCLAW_GATEWAY_SEND_TIMEOUT_MS` 声明并校验 Gateway 窗口，要求 Worker 严格多出 5000ms 缓冲，非法值或反向关系拒绝启动。每个既有 HMAC 覆盖的投递正文还携带两项实际定时器值；Gateway 在授权、幂等 acquire 和 Adapter 前对本实例 `ILINK_REQUEST_TIMEOUT_MS` 强制核对，独立进程的 30/40 对 60 秒错配以既有 `ILINK_REQUEST_INVALID` 永久拒绝、零发送。延迟 Gateway 成功会在 Worker 窗口内写入 `sent` 和 providerMessageId；只有真正超时、断连或响应无法确认才写入不可自动重试的 `OPENCLAW_SEND_RESULT_UNKNOWN`。未修改迁移、通知内容、映射、入站 Hook、target 或历史任务。

## Unreleased — OpenClaw 普通微信内部通知（实验性）

- 用户的最新明确授权覆盖了此前“OpenClaw daemon No-Go / 全部真实渠道暂停”的执行口径：接受长轮询、人工扫码、会话维护和实验性主动通知风险，仅批准单账号、单 pilot、单固定接收人的内部文本通知；Direct iLink、Hook、RPA、逆向协议和客户自动回复仍禁止。旧设计文档保留历史风险事实，并增加了最新授权说明。
- 新增迁移 `007`，以事务重建方式保留 `notification_logs` 数据、字段和索引，并允许 `mock`、`openclaw` 或 NULL 渠道；`001` 至 `006` 未修改。
- notification-worker 仅在渠道启用时领取对应任务，新增本地 HMAC Gateway 的 OpenClaw Adapter、单 pilot 用户限制、固定隐私文本和 `result_unknown` 不自动重试映射。OpenClaw 所有永久失败显式禁止人工重试，Mock 保持既有语义。
- Gateway 保持独立进程和业务数据库隔离，投递契约改为系统用户 ID；Gateway 仅接受 pilot，并固定投递到其受保护配置的单测试接收人。共享 Secret 改为仓库外精确 0600 文件；官方会话状态使用 `OPENCLAW_STATE_DIR`，旧 session 配置仅兼容别名。
- Gateway retryable 结果使用持久原子发送锁，重启后同一幂等键可在 Worker 两次上限内继续真实尝试；并发、永久和未知结果均不会双发。OpenClaw 使用配置化 Gateway 超时，Mock 维持既有 Worker 10 秒保护。
- 管理员规则 preview 与 PUT 统一要求单一 `mock`/`openclaw` 渠道和事件接收人策略；禁用规则也不能使用空、多渠道或未知渠道，避免错误显示为 `pending`。清理 Gateway 已废弃且无调用的幂等入口，状态只经原子 `acquire`/`finalize` 维护。
- 新增默认不执行的一次性隔离 synthetic 入队 CLI：只接受仓库外私有临时空目录、显式 pilot ID 和固定键，创建/复核唯一 `daily_report` OpenClaw outbox；不增加事件、迁移、HTTP/H5 接口或真实外呼。只读队列预检可识别该严格 envelope，其他任务继续阻断为 UNSAFE。
- P1 修复补充：synthetic DB 父目录的请求路径必须等于其 realpath、且严格位于 `realpath(os.tmpdir())` 内；目录为精确 `0700`，DB/WAL/SHM 为非链接、非 hardlink 的精确 `0600` 普通文件。创建、重复 CLI、queue-check 与 Worker 投递前均运行阶段化 sealed-state 证明，拒绝任一业务表污染、规则变化、迁移/checksum、完整性/外键或唯一任务字段异常。
- P1 批次门禁补充：只要当前库有 synthetic 标记或使用 synthetic 固定库名，Worker 会在 claim 前和有任务的 claim 后验证整个密封库；发现额外 `pending`、`retry_wait` 或可恢复 `sending` 任务时，本轮全局停止且不调用 Gateway，不依赖候选任务顺序。无 synthetic 标记的普通 Worker 不进入该分支。
- 最终验收补强：synthetic sealed 门禁现在先于 retention cleanup，终态过期污染不能被清理后继续发送；封存任务新增 `lease_recovery_count`、`management_audit_json`、`row_version`、尝试/发送/保留时间约束。新增终态污染与元数据篡改回归，完整后端测试为 137/137。
- 实况前 P1 兼容修复：OpenClaw `2026.7.1-2` 的 `channels status` 使用 `channels.<channel>.configured` 与 `channelAccounts.<channel>` 单账号状态，不再只有旧 top-level session 字段。Gateway 现仅在精确 channel、恰好一个结构完整账号、已启用/配置/运行、无重启待定/错误/重连时判为 authenticated；多账号、空账号、篡改、错误或歧义一律失败关闭，账号 ID 不进入任何公开结果。旧格式继续兼容。最终验收进一步拒绝空白 accountId、未知或类型错误的显式 account status，并固定验证 unknown 状态不会调用发送 transport；Gateway 37/37 通过。
- 验收将 Gateway 固定合成消息校准为“XYY-xiansuo普通微信通知通道已连接 / 这是一条内部测试消息”，并补强迁移 `007` 固定 checksum、历史整行、规则关闭、重复执行和冲突拒绝回归。固定合成 CLI 不等同于 outbox/Worker 实况；真实 Pilot 必须先在运行手册的两种模式中明确选择，不能直接伪造 outbox。
- 自动化验收后执行了一次受控实况：唯一 Worker 尝试因 `OPENCLAW_GATEWAY_TIMEOUT` 进入 `retry_wait`，Gateway 持久结果为 `result_unknown/ILINK_SEND_RESULT_UNKNOWN`，两侧均无 receipt。系统确认发送成功数为 0，微信端实际可能为 0 或 1；按停止条件未执行第二次尝试、同键重跑或真实去重验证，全部进程已停止且临时运行目录已精确删除。Pilot 判定未通过，当前禁止扩大或重试。

## 2026-08-01 — 真实外部渠道暂停（仅文档决策）

- 本条仅更新文档口径，未修改源码、依赖、迁移、测试或任何真实外部服务。
- 用户决定 OpenClaw daemon 与 Direct iLink 为 No-Go；企业微信自建应用取消，不属于后续候选；公众号/服务号及其他真实外部消息渠道全部暂停。Hook、RPA、逆向协议和 Windows 自动化继续禁止。
- 现行正式通知仅为 H5 站内通知，Mock 仅用于测试/灰度验证。阶段三 outbox、通知规则、租约、重试、TTL、审计保留；阶段四 DeepSeek 调度、`scheduled_follow_overdue`、`daily_report`、AI 审计和模板降级保留，但只写通知基础设施→站内展示→Mock 验证，不发送真实外部渠道。
- 迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 全部暂缓，不进入实现，不补发历史通知；只有官方普通微信提供独立 client/session 且支持主动通知，或用户重新批准公众号/服务号/其他合法官方渠道后，才重新审计。

## Unreleased — 阶段五A：iLink 实况 PoC 就绪补丁（2026-08-01）

- Gateway 改由官方 OpenClaw CLI 管理登录与会话状态；每个子进程显式覆盖 `OPENCLAW_STATE_DIR` 与 `OPENCLAW_CONFIG_PATH` 到仓库外隔离会话目录，移除自定义 `session.json`/token/context token 读取，新增版本、插件 metadata 与 capability 的失败关闭前置检查。
- 新增确认参数保护的官方登录包装、脱敏官方会话状态、显式幂等的固定合成消息 CLI；raw/mock HTTP 仅 `ret=0` 成功，CLI 仅接受严格 `ok/channel/messageId` 官方运行时确认，其他形态失败关闭或待人工确认。
- 配置统一为仓库外绝对 state/session 目录和独立超时名称；收紧 state SQLite/WAL/SHM 权限。未安装 OpenClaw、未登录、未生成二维码、未发送消息，也没有外网或业务链路访问。
- 验收仅修复阶段三独立测试中已过期的人工重试时间夹具，改为运行时 Asia/Shanghai 当前时间；TTL 规则、生产源码和断言语义未变。最终 Gateway 28/28、后端 121/121、H5 构建及 Gateway 生产依赖审计全部通过。

## Unreleased — 阶段五A：iLink 隔离 PoC Gateway（2026-07-31）

- 新增独立 `poc/ilink-gateway` TypeScript 工程：回环监听、严格最小投递契约、HMAC/nonce 防重放、固定单测试接收人、独立 SQLite 幂等 state、Fake Adapter 和默认关闭的 iLink Adapter。
- 后续独立测试修复：配置只投影已知 `ILINK_*` 键；live Adapter 精确对齐官方 `ilink/bot/sendmessage`、`base_info` 和版本头；会话仅限 state 内 0600 的严格本地 PoC 抽象；健康状态持久化，重复/超时状态分类一致。
- 最终验收修复：畸形 `session.json` 统一收敛为安全错误码 `ILINK_SESSION_INVALID`，避免解析器异常文本进入渠道错误码或健康状态。
- Gateway 不导入业务数据库、通知 Worker、DeepSeek 或 H5；没有迁移007、真实登录、二维码、扫码、消息发送或外部网络调用。
- iLink Adapter 仅按官方 `sendmessage` 公开字段预留受控边界；公开资料尚未证明主动定时通知、最终回执和重启会话契约，仍须后续专用账号实况 PoC 验证。

## Unreleased — 阶段四点五：Provider 延迟审计修复（2026-07-31）

- 新增迁移 `006`（`b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a`）：为 `ai_request_logs` 追加 nullable、非负整数约束的 `latency_ms`；迁移 `001` 至 `005` 未修改。
- Provider 成功与实际调用后的安全错误统一携带单调时钟的非负 `latencyMs`；协调服务逐尝试累计，重试、fallback、失败、结果清理和租约恢复均保留审计值。
- admin-only AI 请求日志安全投影新增 `latency_ms`，不增加筛选或任何 Prompt、上下文、结果正文、上游原文及密钥暴露。
- 历史 `005` 记录保持 `NULL`，不允许估算或回填；补丁验收后必须在新隔离副本重新执行受控单用户 Provider 联调。

## Unreleased — 阶段四点五：DeepSeek Pilot Readiness（2026-07-31）

- 为 `scheduled_follow_overdue` 与 `daily_report` 分别建立版本化 JSON Prompt 契约和虚构安全示例；DeepSeek 请求显式使用 JSON Output、关闭思考、关闭流式输出并限制输出 token，不发送工具字段。
- 新增严格 `AI_MAX_OUTPUT_TOKENS`、Provider 响应门禁、真正只读且拒绝未合并 WAL 的 dry-run，以及无 PII 的实际候选排序证据。
- 新增只读 `pilot:queue-check`，复用通知 Worker 的可领取条件，对整个当前可领取队列执行 pilot operation、快照和实时权限检查。
- 验收移除队列预检 CLI 的外部时间覆盖，防止使用历史时间绕过当前 Worker 领取范围；补充 dry-run 表数量不变证明，并隔离 dry-run 与 Provider-only 配置解析。
- 本补丁没有修改迁移、H5 或业务任务范围，没有真实 Key、真实 DeepSeek、真实外网、通知 Worker 或生产数据库操作。

## Unreleased — 阶段四：DeepSeek 后端调度（2026-07-31）

- 新增迁移 `005`：`ai_request_logs` 状态机、租约、幂等、结果/元数据保留索引；只在两条 `004` 原始占位规则完全匹配时初始化其受控 Mock 配置，否则迁移整体失败。
- 新增独立 AI Scheduler、严格 AI 配置、上海业务日调度、逐用户 allowlist、只读权限查询、上下文裁剪、脱敏、严格 JSON 输出校验、Fake Provider 与 Node `fetch` DeepSeek 适配器。
- 实现 `scheduled_follow_overdue` 与 `daily_report` 的确定性候选、模板降级、结果暂存、通知 outbox 衔接、快照解析和发送前实时权限复核；`weekly_report` 仍未实现。
- 新增 admin-only `GET /api/admin/ai/request-logs` 和只读 CLI dry-run；无普通用户 AI API、无 H5 AI 入口、无真实消息渠道。
- 所有 AI、具体任务和通知捕获开关默认关闭；当前无真实 DeepSeek 联调或 API Key，测试使用内存 SQLite 与 Fake/本地结构验证。

### 验收修复

- 收紧迁移 `005` 的受控恢复和字符/状态约束，避免同名伪表绕过规则占位保护，并使过期 `ready` 临时结果安全转为终态后清理。
- 调度入口只执行当前上海时点命中的任务；到期提醒固定本人 scope，日报只纳入冻结的四类重点线索并修正“今日到期未跟进”口径。
- Provider 在读取响应流时限制大小，严格分类重试、超时和取消；非重试失败不再错误累计为两次，并保存安全 fallback 错误码。
- outbox 与 AI 完成关联使用同一短事务，创建通知前复核角色、owner 和冻结线索集合；聚合通知人工重试使用事件专用实时校验。
- 新增阶段四验收回归，覆盖配置、迁移、权限、Provider、恢复、调度、注入和通知重试；未新增生产依赖。

## Unreleased — H5-only 前端决策（2026-07-30）

- 前端发布、验收和构建目标收敛为 H5；移除微信小程序平台依赖及开发/构建脚本。
- 保留 uni-app H5、页面、组件、`uni` API、manifest/pages 配置和全部 H5 业务。
- 此决定不涉及普通微信/企业微信通知规划、微信字段、跟进方式“微信”或公众号来源。

## Unreleased — 阶段三：通知基础设施（2026-07-30）

- 公海待认领改为独立软关闭：默认拒绝两个公海 API，线索池、全部线索及既有线索关系保持不变；前端构建开关只隐藏入口。
- 新增迁移 `004` 的 `notification_rules`、`notification_logs`、队列/租约/管理索引和全部关闭的初始规则；未改动 `001`、`002`、`003`。
- 负责人单条编辑和批量转移在原事务中写入 `owner_changed` outbox；捕获关闭时仅记录不可补发的结构化告警。
- 新增独立 Worker、仅本地 Mock 渠道、有限重试、租约恢复、TTL 取消、终态保留清理、管理 API 和空 Scheduler registry。
- 未实现真实微信、AI、拜访、日报、周报、外网调用或管理前端。

### 验收修复

- 补齐 `owner_changed` 静默时段计算和跨午夜 preview，严格校验 `HH:mm`，并在幂等命中时核对完整不可变事件字段。
- Worker 发送前复核当前负责人和接收人有效性，使用不可变消息快照发送；失效任务取消，非法快照转为不可人工重试的永久失败。
- Worker 启用时要求显式绝对 `DB_PATH`，PM2 固定单实例并安全处理默认关闭；补齐限批队列维护和结构化状态日志。
- 收紧管理日志 ID 包络及 failed 人工重试门禁，只有规则、Mock、接收人和当前负责人均恢复有效时才允许重试。

## Unreleased — 阶段二：业务一致性基线（2026-07-30）

### 负责人权限与一致性

- member 创建线索时只能成为自己的负责人；admin 指定的负责人必须存在且处于启用状态。
- 单条编辑、批量转移和公海认领统一使用负责人变更服务；负责人没有真实变化时不更新、不重复写审计。
- 批量转移在单一 `BEGIN IMMEDIATE` 事务中先完整校验、再逐条更新和审计；同一批次共享 `operation_id`，任一步失败整体回滚。
- 公海认领记录 `pool_claim` 来源，并通过旧负责人条件更新防止重复认领产生重复审计。

### 跟进派生时间

- 跟进新增、编辑、删除后统一按 `created_at DESC, id DESC` 重算 `last_follow_at` 和 `next_follow_at`。
- 按已确认的方案 B，删除最后一条跟进后清空 `last_follow_at`、`next_follow_at` 和来源，不恢复此前人工日期。
- 导入历史跟进使用同一派生算法；停用或不存在的导入负责人回退为导入者并返回警告。
- 前端移除非法“邮件”选项，跟进类型保持“电话、微信、拜访、其他”。

### 数据库与兼容性

- 新增迁移 `003`：`audit_logs.source`、`audit_logs.operation_id`、`leads.next_follow_at_source` 及批次查询索引。
- `001`、`002` 的版本、描述和已发布 checksum 保持不变；`003` 支持幂等执行并执行完整性、外键检查。
- API 路径和 `{ code, msg, data }` 响应包络保持不变。

### 验收修复

- 将 Fastify 全局错误处理器提前到插件和路由注册之前，使事务异常也返回既有 `{ code, msg, data }` 包络；业务事务回滚逻辑未改变。
- 阶段二独立用例 6/6、后端全量测试 39/39、H5 与微信小程序构建均通过。

### 明确未包含

- 未新增通知队列、微信机器人、企业微信、定时提醒、DeepSeek/AI、拜访计划、日报周报或 `sales_stage`。
- 未全面调整现有读取权限，未提交、推送、创建 PR 或操作生产数据库。

## Unreleased — 阶段一：安全与数据库基线（2026-07-30）

### 安全

- JWT 仅作为用户 ID 身份凭证，每次请求从数据库刷新用户名、姓名、角色和启用状态。
- 用户角色升降、停用或删除立即作用于旧 token；管理员接口使用数据库实时角色。
- 移除固定默认管理员密码；生产空库要求至少 12 位初始密码，开发/测试可生成安全随机一次性密码。
- JWT secret 必须配置且至少 32 字节；种子账号密码改为显式环境变量。

### 数据库

- 支持 `DB_PATH`，默认保持 `server/data/app.db`，相对路径按进程工作目录解析。
- 应用连接启用 WAL 和 foreign keys，并验证外键状态。
- 新增 `schema_migrations` 与版本 `001`、`002`，支持固定 checksum、事务、幂等、完整性和外键检查。
- 兼容旧库缺少 `memos`/`favorites`、`follow_ups.images/amount`、`leads.phone NOT NULL` 及旧 status CHECK。
- 迁移默认输出结构化 `applied`、`skipped`、`failed` 结果；失败摘要不含原始错误消息或业务数据，logger 失败不掩盖迁移异常。

### 测试与文档

- 新增安全、配置、管理员初始化、迁移、启动失败、核心 API 和独立基线验证。
- 新增迁移 applied/skipped/failed 日志测试。
- 公海测试在结束时关闭 Fastify 与数据库连接，并只删除自己创建的 `/tmp` 临时数据库目录。
- 补充环境变量、备份、部署、验收、监控和回滚说明。

### 明确未包含

- 未新增通知、普通微信、企业微信、DeepSeek、AI、拜访、日报、周报、`sales_stage`、客户价值评分或组织架构功能。
- 未提交、推送、创建 PR 或执行生产数据库迁移。

## Unreleased — Hermes Weixin v2026.8.3 纯离线 PoC（2026-08-08）

- 新增 `poc/hermes-weixin-offline/`：固定读取官方 `NousResearch/hermes-agent` tag `v2026.8.3`、commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、包版本 `0.20.0`、MIT 的本地源码副本。
- 新增纯离线运行脚本与 9 项测试，覆盖双 peer/session、account+peer context token、DM 策略、Gateway 授权、公开 `cmd_send` fake transport、单 peer payload、失败重试和跨调用 `client_id`。
- 测试在导入 Hermes 前把 HOME/HERMES_HOME/XDG 定向到随机 `/tmp`，并以失败桩禁止 DNS/socket；不登录、不扫码、不轮询、不发送微信、不构造真实 Agent/Provider/模型工具。
- 未修改 `app/src`、`server/src`、`server/data`、数据库 schema、package/lockfile、部署脚本或生产配置；不新增生产依赖。
- 已知阻断：timeout、HTTP 400/503、坏 JSON 均默认执行 1+4 次尝试；相同业务消息跨独立调用生成新 `client_id`，没有跨调用业务幂等。因此仅离线 PoC PASS，真实 Pilot/生产 NO-GO。
