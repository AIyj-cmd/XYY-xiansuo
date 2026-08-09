# 当前版本部署手册

> **当前发布记录（2026-08-09，覆盖下方提交前的“当前/最新”口径）：** 当前代码 RC 为 `dd5559de3082591fcfe89f62ecd6077014e6d665`，本地 tag 为 `rc/xiansuo-hermes-multi-user-clean-20260809`，二者一致。后续纯文档提交可位于 `release/single-account-openclaw-v1` 的更新 HEAD，不改变该 RC 代码快照。launcher 权限 P1 修复已随该提交完成，不再是“尚未提交”的候选差异；当前离线验收 P1=0、P2=0、P3=0。
>
> 当前 schema 迁移为 `001`–`010`。生产数据库一致性备份、`009`→`010` 恢复演练和部署授权均**尚未执行**；因此本手册不授权生产迁移、部署、PM2/systemd/Nginx 操作、真实 Pilot、登录、扫码、联网或微信发送。生产只发布 `app/dist/build/h5/` 静态制品，绝不运行或公网暴露 Vite `dev:h5` 开发服务器。当前锁文件下 App audit 为 **2 high / 0 moderate / 0 critical**（Vite 和间接 nanoid）；保留为 R-1，不使用 `--force` 或 `--legacy-peer-deps` 规避。
>
> 已有“本人绑定后本人收件、旧固定接收人未误收”的结果，只能作为**单用户路由隔离证据**。两名员工同时 active 的独立账号、交叉隔离及各自单次收件尚未完成，仍是多人开放 Pilot 的硬门禁。下方历史章节保留其当时事实；其中关于未提交 launcher、旧提交基线、`001`–`009` 或提交/tag 前条件式放行的表述均由本记录 superseded，不得作为当前发布状态引用。

## Hermes 1–10 用户部署前置门禁

1. 保持 `HERMES_CHANNEL_ENABLED=false`、`HERMES_BINDING_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false` 和 `ILINK_POC_LIVE_ENABLED=false`；所有通知规则继续关闭。当前只允许验收 `owner_changed` Hermes 路径，不启用其他 Hermes 事件。
2. 先形成经评审、可追溯的发布 commit/制品；当前未提交工作区不是生产制品。任何部署、迁移、PM2/systemd/Nginx 操作或真实发送都需单独授权。
3. 使用生产数据库的一致性副本演练迁移 `001`–`008`；`008` checksum 必须为 `f26b25fe25e8cb5f21da92f06eb9f0303f27d8649299be4b35697ea2af17005a`。核对记录数、`active_activation_id_hash`、持久 nonce 表、`integrity_check=ok`、`foreign_key_check` 为空，并完成可恢复备份演练；禁止先在生产主库试跑 `008`。
4. 在仓库外建立当前服务 UID 所有的 `0700` Gateway ledger、Hermes state 和 vault 目录；Gateway Secret、内部 HMAC Secret、overlay 配置文件必须为仓库外 `0600` 单硬链接普通文件，且所有祖先不得是符号链接。vault 的 `bindings.lock` 必须保持私有并由同一服务 UID 使用，不能绕过 `flock` 直接编辑 `bindings.json`。raw peer、context token、cursor、Secret 不得进入 Git、业务 DB、环境示例实值、argv 或日志。
5. Server→Gateway 只允许回环 HTTP 与现有 `x-ilink-gateway-*` HMAC 合同；capture daemon→Server 使用独立 `x-hermes-*` HMAC Secret。Gateway→overlay 只传 `userId + generation + 受控文本 + idempotencyKey`，禁止 peer map、fallback、自由正文和第二次尝试。
6. 若未来获批启动，顺序为 API（完成迁移）→ Hermes capture-only daemon → Hermes Gateway → notification-worker；只对批准的 `owner_changed` 规则、小范围批准用户和固定窗口启用。停止顺序为先关规则及 Hermes 两个 Server 开关，再停 Worker、Gateway、capture daemon。
7. 监控至少覆盖：迁移失败/checksum 冲突、绑定 prepare/commit/refresh 拒绝、activationId 冲突与 prepared 恢复反复失败、容量/peer 冲突、停用事务失败、持久 nonce 容量/清理异常、代次取消、`recipient_not_bound`、`binding_generation_changed`、Gateway HMAC/重放拒绝、幂等冲突、`result_unknown`、overlay timeout/kill/reap、vault lock/权限/完整性失败、进程重启循环。监控和日志不得记录绑定码、raw nonce、activationId、peer、token、cursor、正文或 Secret。
8. 任一 `result_unknown`、代次不一致、vault 不可读、HMAC/权限失败、错误接收人、重复发送或真实结果与账本不一致时立即停用，不换 key、不重发、不 fallback；保留 Gateway ledger、vault 和脱敏日志供人工确认。

离线复验基线：`server` build + `156/156`，`poc/ilink-gateway` build + `59/59`，`poc/hermes-weixin-transport` `18/18`，`app` H5 build。未构建微信小程序，未执行生产依赖审计（依赖/lockfile无变化）。

日期：2026-08-02
当前状态：仓库内离线收尾完成；本手册不授权任何生产操作。

当前运行范围仅为 `xiansuo-api`、`xiansuo-notification-worker`、专用 OpenClaw 和 `xiansuo-ilink-gateway`。API 与 Worker 的 PM2 cwd 分别只从仓库外 `XIANSUO_SERVER_DIR` 读取，Gateway 只从 `XIANSUO_ILINK_GATEWAY_DIR` 读取；模板不保存服务器目录。Nginx 模板中的域名、证书路径均为占位符。

默认关闭：`DEEPSEEK_ENABLED`、AI Scheduler、AI 日报/到期汇总、`NOTIFICATION_CAPTURE_ENABLED`、`NOTIFICATION_WORKER_ENABLED`、`NOTIFICATION_MOCK_ENABLED`、`NOTIFICATION_SCHEDULER_ENABLED`、`OPENCLAW_CHANNEL_ENABLED` 和所有通知规则。不得将这些开关通过 API、环境默认值或 PM2 配置悄然打开。

## 1. 上线前硬门禁

1. 从当前未提交工作区形成经过评审、可追溯的发布 commit/制品；逐项排除不属于阶段一的夹带变更。
2. 核对生产实际运行版本、Node.js 版本（至少 22.13）、服务工作目录和真实数据库路径。
3. 在服务器受控 `.env` 中配置：
   - `NODE_ENV=production`
   - 绝对路径 `DB_PATH`
   - 至少 32 字节 `JWT_SECRET`
   - 空库首次部署时设置至少 12 位 `ADMIN_INITIAL_PASSWORD`
   - 可选 `ADMIN_INITIAL_USERNAME`、`ADMIN_INITIAL_NAME`
4. `.env` 权限设为 `600`，不得进入 Git、部署包、普通日志或前端产物。
5. 使用 SQLite `.backup` 或 `scripts/backup.sh` 备份实际 `DB_PATH`；同时备份上传目录。校验备份文件可打开，并在隔离副本完成恢复演练。此步需要正式部署门禁授权。
6. 先在生产数据库副本执行同一发布制品，确认迁移、记录数、索引、`integrity_check` 和 `foreign_key_check` 全部通过。

## 2. 推荐部署顺序

1. 进入维护窗口并停止业务写入。
2. 记录发布 commit、制品校验值、原服务版本、`DB_PATH` 和备份位置。
3. 完成数据库与上传文件备份，保留原应用制品。
4. 安装锁文件依赖并执行：

   ```bash
   cd server
   npm ci
   npm run build
   npm test
   ```

5. 构建前端 H5 并确认产物：

   ```bash
   cd app
   npm ci
   npm run build:h5
   ```

   Vite 只参与构建，不进入发布制品，也不得在生产机启动 `dev:h5`。当前固定工具链的 audit 告警主要针对开发服务器；另一个 DOM clobbering 条目只影响 `cjs`/`iife`/`umd` 输出，而本项目 H5 的入口为 `type="module"`。这不取消后续 uni-app/Vite 兼容升级任务，但不把静态 H5 发布误判为正在运行有漏洞的 Vite 服务。

6. 建立仓库外私有运行目录：`.env`、Gateway Secret 文件、接收人映射 JSON 文件均为精确 `0600`；Gateway state 与 OpenClaw state/config 父目录均为 `0700`。映射和 Secret 不得进入部署包、日志、PM2 配置或 Git。映射可保留 disabled 的 experimental 预配置，但本次发布只允许恰好一个 `enabled=true`；账号 B 不删除凭据且不得生产使用，其他同事使用 H5。
7. 若本版明确批准启用内部通知，安装依赖并以单实例依次启动：OpenClaw（仅人工登录/官方会话检查）→ `xiansuo-ilink-gateway` → `xiansuo-api` → `xiansuo-notification-worker`。API 会先连接数据库、启用 WAL/外键、运行迁移和检查，再监听 HTTP。Worker 最后启动，避免 Gateway 未就绪时领取任务。
8. 配置 PM2 日志轮转（首次一次）：`pm2 install pm2-logrotate`，建议受控值为 `max_size=20M`、`retain=14`、`compress=true`、`dateFormat=YYYY-MM-DD_HH-mm-ss`；执行前仍需生产授权。不得将通知正文、target、Secret 或会话凭证写入日志。PM2 配置均为单实例并使用 `merge_logs`。
9. 仅在上述进程停止且渠道关闭时，应用可按 API 单独启动；不得自动启动 `ecosystem.phase4.config.cjs` 的 AI Scheduler。
10. 检查标准日志中每个迁移版本都有：
   - 首次执行：`result=applied`
   - 已执行且 checksum 匹配：`result=skipped`
   - 不得出现：`result=failed`
11. 确认启动日志中的数据库路径为预期绝对路径，且没有密码、哈希、客户数据或 SQL 参数。
12. 完成冒烟后再恢复流量和写入。

## 内部通知的独立门禁

OpenClaw 的安装、会话检查和入站静默插件只按 [运行手册](OPENCLAW_INTERNAL_NOTIFICATION_RUNBOOK.md) 的官方命令执行。映射变更后必须重启 Gateway；本次发布冻结为单账号、单启用接收人，且当前业务 Worker 仍只允许 `OPENCLAW_PILOT_USER_ID`。Gateway 构建后可仅离线运行 `npm run gateway:recipient-map-check`，它执行已编译的 `dist/cli/recipient-map-check.js`，只读取 `OPENCLAW_RECIPIENT_MAP_FILE` 并在恰好一个启用项时输出 `SAFE` 与总数/启用数/停用数；零个或多个启用项以非零状态失败。它不读取 Gateway Secret、不连接 OpenClaw/微信、也不输出用户 ID 或 target；live Gateway 同样拒绝零个或多个启用项。多账号定向发送为 NO-GO。每次新的真实微信发送仍须先取得单独授权，并明确接收人、消息类型、数量与是否使用生产数据。

生产路径、备份和启动授权齐备后，OpenClaw 必须在注入同一组仓库外 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 的专用服务环境中运行官方前台入口 `openclaw gateway run --bind loopback`；不得使用 `--force`、`--allow-unconfigured`、`lan` 或公网监听。由所选系统服务管理器托管该前台进程，并用 `openclaw gateway status` 做只读检查。随后依次加载 `ecosystem.openclaw-gateway.config.cjs` 和 `ecosystem.phase3.config.cjs`；这些 PM2 模板会在 cwd 缺失或不是绝对路径时拒绝加载。仓库脚本只会更新 API，不会自动启动真实渠道进程。

## 停止顺序

先把 `OPENCLAW_CHANNEL_ENABLED=false` 和相关通知规则关闭，再停止 notification-worker、Gateway、OpenClaw，最后按维护需要停止 API。不得直接杀掉进程来跳过正在进行的可审计投递；不要删除会话、映射、Secret 或 Gateway state。

## 3. 上线后验证

- 健康检查成功，且迁移或管理员初始化失败时服务不会监听端口。
- 使用受控测试账号验证登录和 `/api/users/me`。
- 验证 admin 可访问管理员接口、member 返回 403。
- 在测试账号上执行 admin→member 降级、member→admin 升级、停用，确认旧 token 立即采用数据库实时状态。
- 验证线索创建、列表和跟进创建继续返回 `{ code, msg, data }`。
- 只读核对：

  ```sql
  SELECT version, description, checksum, applied_at
  FROM schema_migrations
  ORDER BY version;

  PRAGMA integrity_check;
  PRAGMA foreign_key_check;
  PRAGMA foreign_keys;
  ```

- `integrity_check` 必须为 `ok`，`foreign_key_check` 必须为空；应用连接日志/测试应证明 `foreign_keys=1`。

## 4. 监控与告警

- 启动日志：`database-migration` 的 version/description/result；任何 `failed` 立即阻断上线并告警。
- 进程：启动失败、PM2 重启循环、健康检查失败。
- 数据库：磁盘空间、数据库/WAL 增长、`SQLITE_BUSY`/I/O 错误、定期 integrity/foreign key 检查。
- 安全：登录 401、管理员接口 403 的异常增幅；管理员角色和启停变更。
- 备份：每日备份成功时间、大小异常、恢复抽检结果。
- 日志内容：不得出现初始密码哈希、JWT secret、SQL 参数或客户数据。

## 5. 停止上线条件

- 发布制品无法关联到评审 commit。
- `DB_PATH` 为空、相对路径或与预期不符。
- 数据库/上传备份缺失或恢复演练失败。
- 任一迁移 `failed`、checksum 冲突、完整性或外键检查失败。
- 生产空库缺少合规初始管理员密码。
- 核心 API、实时降权或响应包络冒烟失败。

## 6. Hermes Weixin 纯离线 PoC 交付说明（2026-08-08）

本 PoC **没有部署步骤，也不得作为服务启动**。它只供开发/评审机器在固定本地上游源码副本上复现离线证据：

1. 准备 `/tmp/hermes-agent-v2026.8.3`，核对 remote、tag、commit、`pyproject.toml` 版本和 MIT 许可证；依赖环境只建立在该副本自己的 `.venv`。
2. 从仓库根目录运行 `./poc/hermes-weixin-offline/run-offline-poc.sh`；期望 9/9，且结束后无 `/tmp/xiansuo-hermes-weixin-offline-*`。
3. 复现前后核对 `server/data` 哈希与相关进程；任何 DNS/socket 尝试都会令测试失败。

禁止把该目录加入 PM2/systemd/Nginx、禁止配置真实 token/账号、禁止扫码、禁止启动 Gateway/轮询、禁止真实发送，也禁止把本机 `/tmp` 上游副本打入生产制品。当前没有可用的 Hermes 生产监控信号；只有离线测试退出码、用例数、临时目录清理和数据哈希可作为 PoC 证据。

若未来申请真实 Pilot，必须另行提交并批准：持久化业务幂等、失败分类、未知结果人工确认、真实账号与接收人边界、限流/停止条件、监控告警和专用回滚方案。本说明不授权该扩展。

## 7. Hermes Weixin transport-only overlay 本地交付说明（2026-08-08）

本轮是**本地 overlay 代码交付，不是部署或实况授权**。禁止在生产机、PM2、systemd、Nginx、真实账号或真实网络上启动；禁止登录、扫码、轮询或发送。

### 离线复验

1. 只在开发/评审机准备独立的 `/tmp/hermes-agent-v2026.8.3`，核对 remote `https://github.com/NousResearch/hermes-agent.git`、tag `v2026.8.3`、commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、tree `b217767ccb994605dad522e693fa1b4cdbc2f352`、clean、包版本 `0.20.0` 和 MIT。依赖只存在于该副本自己的 `.venv`，不进入仓库或发布制品。
2. 从仓库根目录运行 `./poc/hermes-weixin-transport/run-tests.sh`；期望 12/12。该测试使用注入 transport，不发送网络。再运行 `./poc/hermes-weixin-offline/run-offline-poc.sh`；期望 9/9，且上游默认 1+4 重试只发生在 fake 对照路径。
3. 运行 Gateway `npm run build && npm test`、Server `npm run build && npm test`、H5 `npm run build:h5`；核对 `git diff --check`、`server/data` 前后 SHA-256、临时目录和相关进程。

### 冻结配置边界

- 默认保持 `ILINK_POC_TRANSPORT=openclaw`、`ILINK_HERMES_TRANSPORT_ENABLED=false`、`ILINK_POC_LIVE_ENABLED=false`。本轮不创建可运行的 live 配置，也不启动 Gateway。
- 若未来另获明确实况授权，Hermes 模式仍必须同时显式选择 transport、enable 和 live；`ILINK_POC_STATE_DIR`、`ILINK_HERMES_STATE_DIR` 为仓库外当前 UID 的精确 `0700` 非链接目录，Gateway Secret、overlay config、recipient map 为仓库外当前 UID 的精确 `0600` 单硬链接普通文件。
- recipient map 必须为 1–10 个规范系统用户 ID 到唯一 Hermes peer 的严格映射；overlay config 的 `allowed_from` 也必须为 1–10 个固定 peer，并由人工核对两者一致。Secret、token、HMAC key、peer、context token、正文和状态绝不进入 Git、argv、日志或部署包。
- Gateway HTTP 合同不新增 peer、token 或自由消息字段；不得绕过固定业务消息策略、持久幂等账本、单次 adapter 调用或 `result_unknown` 禁止重试门禁。

### 监控与停止信号

当前可用信号只用于后续获批实况设计：配置 fail-closed、Gateway `ILINK_HERMES_DISABLED`/`ILINK_HERMES_SESSION_UNCHECKED` health code、`result_unknown` 数量、幂等冲突、子进程 timeout/kill/reap、状态文件权限/完整性失败、Gateway 重启与状态目录增长。没有真实 session/送达监控，本轮不能据此上线。

任一 upstream gate、路径权限、HMAC/状态完整性、映射、幂等、子进程回收或数据哈希检查失败即停止；任何 DNS/网络、登录、扫码、真实发送或相关常驻进程出现均视为越界并进入安全事件处置。真实 Pilot 必须另行批准账号、接收人、数量、消息、网络、停止条件、监控和人工确认流程。

## 8. Hermes 成功响应分类修复交付说明（2026-08-08）

本修复是**离线代码交付，不是部署或实况授权**。不需要数据库迁移、依赖安装或环境变量变更；默认 `openclaw` transport、Hermes enable=false、live=false 保持不变。不要为验证本修复启动 Gateway、Worker、Hermes、登录、扫码或网络发送。

离线复验顺序：运行 overlay 测试两轮（期望每轮 13/13），随后运行 Gateway build/test（期望 59/59）、Server build/test（期望 146/146）和 H5 build；最后检查 `git diff --check`、`server/data` 哈希及相关进程。stdout 只能包含 `status`、`code`、固定 `responseShape`、`idempotencyKey`；日志和制品不得包含原始 provider 响应、正文、token、context token、peer、Secret 或映射。

上一 Pilot 的事实必须继续分别保存：技术记录 `permanent_failure / ILINK_PROVIDER_REJECTED`，人工记录 `manually_confirmed_received`、实际收到 1 条、自动重试 0、其他渠道 0；不得用新分类规则批量回写旧账本。

若以后获得新的真实单条授权，只允许唯一接收人、固定正文、新幂等键和一次 adapter 调用。放行标准同时要求技术状态 `sent`、人工实际收到 1 条、自动重试 0、其他渠道 0；任何 unknown、超时、断连或结果不一致立即停止且不重发。在该实况门禁完成前不得接入 Worker、PM2/systemd、Nginx 或生产。

## 9. Hermes 每用户 QR manager 交付说明（2026-08-09）

本轮没有部署或真实账号操作。`HERMES_BINDING_ENABLED=false`、`HERMES_CHANNEL_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false` 和 `ILINK_POC_LIVE_ENABLED=false` 必须保持默认关闭；禁止启动 manager、Gateway、轮询、登录、扫码或发送。

如未来另获单独实况授权，manager 仅可绑定 `127.0.0.1`/`::1`，以仓库外 0600 JSON 配置文件启动：`host`、`port`、`vault_dir`、base64 `vault_key`、`manager_secret`、loopback `server_url`、`internal_secret` 必须齐全，`vault_dir` 为当前 UID 的非链接 0700 目录。密钥、provider accountId/token、二维码、target、context、cursor、activationId 绝不进入 PM2 环境、argv、日志、SQLite 或 H5 静态制品。固定上游必须通过 provenance/hash gate，并包含其锁定的 `qrcode==7.4.2` messaging extra；不得改上游源码或调用 `qr_login`。

放行前先以 fake provider 完成离线 manager/Server/Gateway/H5 全套测试，核查单一活动 attempt、owner-only API、五分钟过期且无刷新、扫码后精确确认命令、三元组零 fallback、vault 0600/0700/完整性、重启恢复和第 11 账号拒绝。任何权限、HMAC/nonce、vault、上游 gate 或泄密扫描失败都必须停止；不允许以真实二维码或实际发送代替测试。

## 10. 每用户 QR 生产前门禁补充（2026-08-09）

当前结论仍是**不得部署**。未来取得真实双人 Pilot 与部署授权后，按以下顺序执行：

1. 冻结发布 commit 和制品；保持 `HERMES_BINDING_ENABLED=false`、`HERMES_CHANNEL_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false`、`ILINK_POC_LIVE_ENABLED=false` 及全部通知规则关闭。
2. 对真实 `DB_PATH` 做一致性备份和可恢复验证，只在生产副本首次运行 `009`。升级前统计 legacy Hermes active、pending/retry/sending 数量并经业务确认停发与重绑窗口；升级后确认 legacy 行/任务未改变、公开状态为 `rebind_required`、trigger/索引实际可执行、`integrity_check=ok`、`foreign_key_check` 为空。
3. manager 配置只放仓库外 0600 JSON；`vault_dir` 为当前 UID 的仓库外非链接 0700 目录。`vault_key`、`manager_secret`、`internal_secret` 不进 env、argv、Git 或日志；Server 仅通过各自 0600 Secret 文件读取 manager/internal Secret。确认固定 Python 的 `qrcode==7.4.2` 可导入、upstream provenance/hash gate 通过，并静态核对确认响应仍使用 `bot_token/baseurl`、扫码重定向 host 仍为固定 `ilinkai.weixin.qq.com`；任一契约变化均停止。
4. 启动顺序固定为 API（渠道关闭）→ account manager（loopback）→ Hermes Gateway（transport/live 仍关闭）→ notification-worker（仍关闭）。manager 不在当前 PM2 自动启动模板中，不得因加载 API/Worker 模板而隐式启动。
5. 用两名明确测试用户串行执行：A 生成/扫描/确认并 active；B 在 A 完成或取消后执行；交换 accountRef、generation、确认命令、target/context 的负例必须零网络。再验证 manager 重启、prepared 过期、用户停用退役、active 重绑旧账号退役，以及 A 自助解绑后 generation 撤权、任务/attempt 取消、B 完全不变且 manager 退役失败时数据库仍保持 unbound。
6. 只有双人隔离通过后，才可单独授权 `owner_changed`：每人一条固定消息、一个新幂等键、一次 adapter 调用；人工核对接收人、数量、技术结果、自动重试 0、其他渠道 0。任何 `result_unknown`、错投、重复、fallback、重试或账本不一致立即停止，不换 key、不重发。

## 11. Hermes 离线服务链 D-1（2026-08-09）

本节只描述已打包的离线部署单元；**不授权执行 PM2、Nginx、服务器、登录、扫码、轮询或发送操作**。`deploy/deploy.sh` 会把 `poc/hermes-weixin-transport/` 和固定的 `hermes-agent-v2026.8.3` 源码副本放入制品，但只重载 API，绝不自动加载下面两个 Hermes PM2 模板。

Git 只能保存三个 launcher 的可执行位，不能保存去除组写位的 `0755`。因此本地 Gateway 的 `build`、`test` 和 `start` 前、部署打包前，以及远端解包后、`rsync -a` 前后且任何构建/PM2 动作前，均会运行固定白名单的 `poc/ilink-gateway/scripts/normalize-runtime-launchers.mjs`。它不接收路径参数，先以 `O_NOFOLLOW` 打开**全部**三个受控 launcher 并以 `fstat` 校验当前 UID、普通文件和单硬链接；仅在全部初检成功后才以文件描述符统一设为 `0755`，关闭后逐项复核。任一初检失败不会修改任何 launcher。制品创建后还会逐项验证 tar 成员恰好为 `-rwxr-xr-x`。符号链接、多硬链接、非属主或无法复核均失败关闭；它绝不处理 `.env`、Secret、manager JSON、vault、账本或其他用户路径。Gateway 的 `requireRepositoryLauncher` 仍会拒绝任何组/其他用户可写 launcher，规范化不是放宽运行时门禁。

- `ecosystem.hermes-account-manager.config.cjs`：单实例、固定 overlay `cwd`、仅 `127.0.0.1:38117`，配置只通过 argv 中的仓库外 `0600` JSON 路径传入；启动包装器会清空继承环境，只保留 PATH、语言、源码/Python 路径，不能含 DB、JWT、DeepSeek 或任何 Secret 实值。
- `ecosystem.hermes-gateway.config.cjs`：单实例、固定 Gateway `cwd`、仅 `127.0.0.1:38116`。启动包装器同样以 `env -i` 清空 PM2 shell 继承值，只把 PATH/LANG/LC_ALL/TZ、明确的 `ILINK_*` 路径与固定开关传给 Node；因此 DB、JWT、DeepSeek 和 Secret 实值不会进入 Gateway。`ILINK_POC_LIVE_ENABLED=false` 与 `ILINK_HERMES_TRANSPORT_ENABLED=false` 被硬编码。两个模板均使用 15 秒正常停止窗口、5 秒重启退避、最多 10 次重启及仓库外日志目录。
- manager JSON 默认且必须保持 `"enabled": false`。关闭态仍可在 loopback 返回 `/livez` 和纯本地 `/readyz`，但 QR、poll、内部 callback 与 send 全部拒绝，也不会创建 poll thread。Gateway `/livez`、`/readyz` 只检查配置、账本、launcher、manager 配置和超时，不调用 adapter、不启动子进程或访问网络。
- 机器可读检查使用 `poc/hermes-weixin-transport/run-hermes-weixin-transport.sh preflight --manager-config /绝对/私有/manager.json`；它核验 Node/Python、OS/arch、固定上游 tag/commit/tree/hash/clean、`qrcode` 导入、0600/0700/UID/无链接/仓库外路径、loopback 端口及全部真实开关为 false。`dry-run` 使用临时 fake config、空 vault/ledger/state 与 fake Secret，不做 DNS/socket、业务 DB 或常驻进程。

未来另获单独部署授权时，启动顺序只能是：**manager → Hermes Gateway → API → notification-worker**；health/readiness 均通过后才能进入下一项，且真实开关和规则仍先保持关闭。停止顺序严格反向：**notification-worker → API → Hermes Gateway → manager**。任一失败只保全账本/vault/日志并停止，不用网络消息作验证。

监控新增：全局 live attempt 数/最老年龄、prepared 超 TTL、manager 401/409/不可达、周期授权拒绝、同用户旧账号退役失败、vault live 用户数、QR 进程重启失效、`rebind_required` 完成率，以及三元组不匹配取消数。日志不得记录 QR、activationId、accountRef 原值、provider account/token、target/context/cursor 或消息正文。

## 12. 项目健康整改 v2 发布说明（2026-08-09）

### 当前可交付边界

- 代码 SHA 冻结为 `2d5ce5964c7f00ff25a4cdb31f5157bf6d8b6866`。当前只建议进入合并评审，本文不授权 merge/push/部署。
- dashboard summary/export 对 member 保持公司级可见，这是用户批准行为；普通 `/api/export` 仍按 member 本人 owner 限制。部署验证不得以“安全修复”名义改变该口径。
- 迁移 001–009 保持不变，唯一新迁移是 010 `token_version`。任何生产执行前都必须先获得 R-3 授权，用一致性备份在隔离恢复路径验证 009→010、重复启动、checksum、完整性、外键和旧 JWT 撤销；未授权前不得运行。
- App 完整 audit effect graph 仍为 29 high/1 moderate、critical=0。生产只能发布 `app/dist/build/h5/` 静态制品；Vite 开发服务器不得绑定公网，CI 继续以 critical 阻断，不运行 force/legacy peer 修复。

### Hermes 必须保持的状态

- 新的真实 Pilot 和生产部署均未授权。历史单条 Pilot 不能替代当前多用户 QR/三元组/服务链验证。
- `HERMES_BINDING_ENABLED`、`HERMES_CHANNEL_ENABLED`、`ILINK_POC_LIVE_ENABLED`、`ILINK_HERMES_TRANSPORT_ENABLED` 和全部真实通知规则必须为 `false`。`deploy.sh` 可打包两个离线单元，但不得自动加载它们。
- 获得未来授权后，启动顺序为 manager → Gateway → API → Worker，停止顺序反向。manager/Gateway 只能侦听 `127.0.0.1:38117/38116`，先通过 preflight、`/livez`、`/readyz`，真实开关仍先保持关闭。

### 发布前仍需人工确定

- R-2/G2 需产品明确每用户/公司上传配额、保留期、孤儿定义、清理频率与宽限窗口；未定值前不新增自动删除任务。
- 监控除第 11 节 Hermes 信号外，还应覆盖 401 突增/改密后重登录成功率、迁移 010 失败/checksum 冲突、上传 400/413/500 比率、staging 遗留数、CSP 违规、Server/Gateway audit 和 H5 critical 门禁。日志和告警不得携带密码、JWT、QR、target/context/cursor 或客户数据。

**发布判定：合并评审 GO；生产部署 NO-GO，直到发布和 R-3 授权及演练完成；Hermes 开启 NO-GO，直到新的真实 Pilot 获批并通过。**

## 13. Release launcher 权限与 RC 冻结说明（2026-08-09）

> **已 superseded：** 本节最初记录的是提交前冻结门禁。当前 HEAD/tag、迁移与生产门禁以本手册顶部“当前发布记录”为准；以下技术门禁和未执行部署事实仍然有效。

- launcher P1 修复已提交为 `dd5559de3082591fcfe89f62ecd6077014e6d665`，本地 RC tag `rc/xiansuo-hermes-multi-user-clean-20260809` 已指向该提交；当前工作区作为发布记录应保持干净。此前 `6576f0bc7f2352b857bf808a14c36eb7cf0dbff5` 是该修复的父提交，不再是当前合并基线。
- RC 前必须保持三 launcher 为当前 UID 拥有、单硬链接、无符号链接的普通文件；`npm run build`、`npm test`、`npm start` 的 prestart 会先运行固定白名单规范化。任一校验失败都应停止，不得改为 `chmod -R`、扩大白名单或放宽 Gateway 运行时门禁。
- 未执行 `deploy/deploy.sh`。未来另获部署授权时，打包前规范化三项并检查 tar 成员精确 `-rwxr-xr-x`；远端解包后、任一 `rsync` 前以及 Hermes/Gateway `rsync -a` 后、构建/PM2 前必须再运行同一工具。任一处失败立即中止制品或部署流程。
- 监控仍须包含 Gateway 启动权限门禁失败、制品 launcher 权限偏离、manager/Gateway readiness、`result_unknown`、超时子进程回收和三元组不匹配取消；日志不得含 Secret、QR、accountRef 原值、target/context/cursor 或正文。

**本地提交与本地 RC tag 已完成。push/远程 tag/部署/真实渠道：NO-GO；生产数据库备份、`009`→`010` 恢复演练和明确部署授权完成前不得推进。**

## 14. Codex Security 九项整改部署门禁（2026-08-09）

### 当前判定

当前仅为**离线代码 GO**，不是部署授权。禁止执行 `deploy/deploy.sh`、PM2 load/reload、生产数据库操作、
Hermes 登录/扫码/发送或 DeepSeek 调用。即使代码提交或合并，也不得据此自动打开任何真实开关。

### 部署前必须全部满足

1. 使用获批准的 commit/制品，确认只包含九项整改、测试报告和四份交付文档；三份 lockfile 与迁移
   `001`–`010` 必须和 `5027a76` 一致，不得夹带 `server/data`、uploads、staging 或 backups。
2. 在运行 UID 拥有的仓库外 private root 中提供 source 和 Python：private root/source 精确 `0700`，
   Python 单硬链接普通可执行文件，全部祖先不得组/其他用户可写，不得位于仓库、`/tmp`、`/var/tmp`、
   `/dev/shm`，Python 不得位于 source checkout。
3. 固定 source 必须保持 remote `https://github.com/NousResearch/hermes-agent.git`、tag `v2026.8.3`、
   commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、tree
   `b217767ccb994605dad522e693fa1b4cdbc2f352`、干净工作树和 manifest 文件哈希一致。
4. 在同一个受控 private Python 中按批准的运行时依赖清单安装并核验 `qrcode`；不得改为系统 PATH
   上的任意 Python、source 内 venv、仓库脚本默认值或临时解释器。
5. 使用三个显式变量运行 `run-hermes-weixin-transport.sh dry-run`，必须退出 0，并只返回
   `offline=true`、`network=not_used`、`businessDatabase=not_used`、
   `residentProcess=not_started`。当前验收环境在 `import qrcode` 处失败，因此本项尚未完成。
6. dry-run 通过后仍保持 `HERMES_BINDING_ENABLED=false`、`HERMES_CHANNEL_ENABLED=false`、
   `ILINK_POC_LIVE_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false`、manager `enabled=false` 和
   全部真实通知规则关闭。真实启用需要新的明确授权及单独 Pilot。
7. 核对 `DB_PATH`、uploads/staging/backups 均为仓库外或被部署明确排除；目标目录/文件权限分别为
   `0700/0600`。本次无 schema 变更，不执行迁移作为部署步骤；若目标环境仍需历史迁移，沿用既有
   R-3 备份/副本演练门禁，不能借本次整改获得授权。

### 部署后监控（未来另获授权时）

- 登录：按来源/全局 429、`PASSWORD_HASH_BUSY` 503、认证延迟与来源 bucket 容量异常。
- 上传：并发 503、个人 413、全局 507、磁盘余量 503、staging 遗留、目录/文件权限漂移和总量趋势。
- 数据/备份：DB/WAL/SHM 权限或 symlink 拒绝、备份失败/权限漂移、部署制品误含运行数据。
- AI：`AI_OUTPUT_REJECTED` 数量及 provider 错误；日志不得记录被拒绝原文、prompt、token 或 Secret。
- Gateway/Hermes：HMAC 401、重放/限流、health singleflight 失败、runner timeout/64 KiB/TERM-KILL-reap、
  provenance/TOCTOU/readiness 失败、`result_unknown` 和三元组不匹配；不得记录正文、QR、accountRef、
  target/context/cursor、路径中的敏感租户信息或 Secret 实值。

**停止条件：任一 dry-run 门禁未完成、权限/provenance 漂移、真实开关意外为 true、Secret/路径泄露、
重复/错投或 `result_unknown` 被自动重试，立即保持或恢复 NO-GO，停止下游单元并保全证据。**
