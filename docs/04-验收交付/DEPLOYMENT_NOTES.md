# 当前版本部署手册

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
