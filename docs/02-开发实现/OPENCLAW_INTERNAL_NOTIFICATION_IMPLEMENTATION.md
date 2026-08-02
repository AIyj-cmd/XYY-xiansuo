# OpenClaw 普通微信内部通知实现

本实现为实验性内部渠道，不是客户消息或大规模生产渠道。用户已接受专用账号长轮询、人工扫码、会话失效及账号风控风险；系统仍禁止 RPA、逆向协议、自动换号、批量发送、客户自动回复和任何入站业务接口。唯一例外是仓库内可审计的官方 OpenClaw `before_agent_reply` Hook：它仅让 `openclaw-weixin` 入站回合静默结束，不能读取后续业务系统、不能发回复、不能调用模型。

链路为业务 outbox → 单实例 notification-worker → 回环 iLink Gateway → 静态批准的内部接收人。Gateway 不访问业务数据库；API、AI Scheduler、H5 不读取微信会话或 Gateway Secret。Secret 与可选 `OPENCLAW_RECIPIENT_MAP_FILE` 均仅从仓库外精确 0600 文件读取；映射为最多 50 项的严格 JSON 对象，键仅允许规范正整数系统用户 ID（如 `"12"`），值为 `{ "target": "<接收人>@im.wechat", "enabled": true|false }`，且仅在 Gateway 启动时加载。未绑定返回 `OPENCLAW_RECIPIENT_NOT_BOUND`、禁用返回 `OPENCLAW_RECIPIENT_DISABLED`，均不会调用 Adapter；旧单接收人路径继续使用 `OPENCLAW_RECIPIENT_NOT_ALLOWED`。Gateway 使用规范 `OPENCLAW_STATE_DIR` 作为官方会话状态目录，旧 `ILINK_POC_SESSION_DIR` 仅兼容别名且不可并存。

迁移 `007` 在单事务内重建 `notification_logs`，保持字段、数据、索引和外键，再将 `channel` 限制扩展为 `NULL`、`mock`、`openclaw`。不改 `001` 至 `006`，不回填、不补发、不启用规则。

OpenClaw 支持由静态映射批准的正整数内部用户，以及 `owner_changed`、`scheduled_follow_overdue`、`daily_report` 三个事件的单一 `openclaw` 规则。映射模式优先于旧单 pilot 配置；旧配置仅兼容并产生脱敏弃用警告。`owner_changed` 在 outbox 捕获时读取真实线索字段并写入不可变快照：标题固定为 `【新线索已分配】`，字段按客户、联系人、联系方式、来源、需求、跟进要求排序，手机号只保留掩码；联系人、手机号可缺省，缺失跟进时间固定降级为“请尽快联系”，合法 `next_follow_at` 日期显示为 `YYYY-MM-DD前`、datetime 显示为 `YYYY-MM-DD HH:mm前`，不虚构 `00:00`。服务端将 Unicode `Cc`/`Cf`/`Zl`/`Zp`（含换行、零宽和双向控制字符）、`微信：`、微信号/ID、`wxid`、带分隔符的 wechat/weixin/vx/v信 标识和凭证标记排除或归一，不影响合法来源“微信咨询”；Gateway 除模板结构换行外对这些 Unicode 类别失败关闭，并拒绝任意字段的未脱敏大陆手机号或标识泄露。Worker 不重新读取线索，从而避免发送数据漂移。Gateway 仅接受该精确结构；OpenClaw 出站无论 snapshot 中的相对详情路径为何，统一使用无 token 的 `https://xs.tomatopia.top/`，Mock 仍保留其相对 `detailPath`。AI 事件仍使用固定文本模板。`result_unknown` 记录为不可重试 `failed`，不自动重发。

入站静默插件位于 `poc/ilink-gateway/openclaw-plugins/xiansuo-no-reply/`，以官方原生插件 manifest 和 `before_agent_reply` 契约实现。它只匹配 `messageProvider === "openclaw-weixin"`，返回无 `reply` 的 `{handled:true}`，因此在 Provider 前短路且不产生外发内容；其他渠道不拦截。它默认不安装、不写 `OPENCLAW_CONFIG_PATH`；受控安装必须使用受支持的 `openclaw plugins install --link <绝对路径>`（不得加 `--force`），再用 `config set` 显式启用插件与 `allowConversationAccess=true`，并通过 runtime inspect 的 `hookCount=1`、`before_agent_reply` 和零 diagnostics 验证，详见插件 README。

Gateway 对同一幂等键持久保存投递状态和原子发送锁。只有明确 `retryable_failure` 才能在 Worker 的两次尝试上限内重新获取发送权；重启后仍可重试。同键的并发请求不能重复调用 Adapter；`sent`、`permanent_failure`、`result_unknown` 均失败关闭。`deduplicated` 必须返回已持久化的原本地回执，否则安全失败。OpenClaw 超时完全由 `OPENCLAW_GATEWAY_TIMEOUT_MS` 控制；Worker 的旧 10 秒保护只保留给 Mock。

管理员规则 preview 和 PUT 共用事件接收人策略、单渠道门禁：规则启用与否均必须恰好指定 `mock` 或 `openclaw`。空数组、多渠道和其他渠道均被拒绝，preview 不会将无渠道规则显示为 `pending`。Gateway 已删除无调用的旧 `existing`/`reserve` 及 StateStore 独立创建、更新、查询包装；投递状态仅经原子 `acquire`/`finalize` 路径维护。

## 隔离 synthetic 入队（仅受控实况准备）

新增一次性本地 `openclaw:enqueue-synthetic-pilot` CLI；没有 HTTP、H5 或入站接口。它要求显式绝对 `--db-path`、正整数 `--pilot-user-id` 和固定 `--idempotency-key`，只接受仓库外系统临时目录中权限精确 `0700` 的空目录及固定库名 `openclaw-synthetic-pilot.db`。首次仅迁移 `001–007` 并创建一个无登录用途的 member 测试用户、一条 `notification_logs` 任务；不读取 `leads`、`follow_ups`、`ai_request_logs` 或 DeepSeek。重复同键只验证此前密封的单用户/单任务状态并返回去重，不新增记录；CLI 从不删除或清理该库。

该任务仍为既有 `daily_report`，使用既有严格 snapshot Schema、空 `subject_lead_ids`、`event_source=openclaw_synthetic_pilot` 和哈希 operation ID，不新增正式事件、迁移或表字段。Worker 仅在整行 envelope 与固定键、用户、快照、渠道完全一致时使用批准的固定测试正文；否则不可重试失败。只读 `pilot:queue-check` 增加 `--synthetic-idempotency-key`，连续检查该唯一任务可为 SAFE，任何其他可领取任务仍为 UNSAFE。

P1 加固后，synthetic 路径的请求父目录必须就是其 `realpath`，并严格处于 `realpath(os.tmpdir())` 之内；上级符号链接、硬链接、非普通文件、目录非 `0700` 及 DB/WAL/SHM 非 `0600` 一律拒绝。首次插入后、重复 CLI、只读 queue-check 和 Worker 发送前共享只读 sealed-state 校验：迁移 `001–007` 的精确 checksum、完整性/外键、唯一测试用户、默认关闭规则、除白名单外所有表零记录、唯一任务的阶段化租约/尝试/回执字段和隐私快照均须完全匹配。queue-check 仅在证明成功时才给出 SAFE；Worker 校验失败时不调用 Gateway。

Worker 对含 synthetic marker（或 synthetic 固定库名）的库额外使用批次门禁：在领取前以可领取前的 sealed 阶段校验，并在有任务领取后以 `sending` 阶段再次校验。任何额外任务，包括 `pending`、`retry_wait` 或可恢复的 `sending`，都会使整轮直接返回，所有已领取任务保留给既有 lease 恢复逻辑，绝不按排序先发送另一项。没有 marker 的普通生产 Worker 不使用此分支。

最终验收进一步把领取前 sealed 门禁移到 retention cleanup 之前。这样即使污染项是已经到保留期的 `sent`、`failed`、`cancelled` 或 `suppressed`，Worker 也不能先删除污染证据再发送 synthetic 任务。任务封存同时固定 `lease_recovery_count`、`management_audit_json`、`row_version`、尝试时间、发送时间与保留期；任何元数据篡改均失败关闭。普通数据库没有 synthetic marker/固定库名时仍走原有 cleanup 与 Worker 流程。
