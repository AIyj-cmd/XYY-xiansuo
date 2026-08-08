# OpenClaw 内部通知运行手册

## 默认边界

默认所有开关关闭。Gateway 只监听 `127.0.0.1`，不配置 `DB_PATH` 或 DeepSeek Key。业务 API、AI Scheduler 和 H5 不读取 OpenClaw 会话或 Gateway Secret。不得使用日常主账号、客户账号、RPA、逆向协议、自动换号、批量发送或入站业务指令。唯一允许的 Hook 是仓库内 `xiansuo-openclaw-no-reply` 官方插件：它只对 `openclaw-weixin` 返回无 reply 的 `{handled:true}`，用于在模型调用前静默结束入站回合。

配置 `OPENCLAW_CHANNEL_ENABLED`、回环 `OPENCLAW_GATEWAY_URL` 和仓库外精确 0600 `OPENCLAW_GATEWAY_SECRET_FILE`。Gateway 可读取仓库外精确 0600 的 `OPENCLAW_RECIPIENT_MAP_FILE`：其 JSON 根必须为对象，最多 50 项，键必须是规范正整数系统用户 ID，值严格为 `{"target": "<接收人>@im.wechat", "enabled": true|false}`。文件只在 Gateway 启动时读取，不热更新；映射优先于旧单接收人配置。**本次发布冻结要求 live Gateway 和离线 `gateway:recipient-map-check` 均为恰好一个 `enabled=true`；多人定向发送为 NO-GO。** 账号 B 只能作为 `experimental/disabled` 预配置保留，凭据不删除但不得用于生产；其他同事使用 H5。Gateway 使用同一 Secret 文件、规范 `OPENCLAW_STATE_DIR`（仓库外 0700 官方会话状态目录）和 `OPENCLAW_CONFIG_PATH`。旧 `ILINK_POC_SESSION_DIR` 仅为兼容别名，不得与规范项同时设置。会话失效只能由人工使用专用账号重新登录。

超时按两个明确窗口协调：Gateway 的 `ILINK_REQUEST_TIMEOUT_MS` 是 Adapter Abort 与 OpenClaw CLI 进程共用的完整发送窗口，默认 `30000`ms；Worker 的 `OPENCLAW_GATEWAY_TIMEOUT_MS` 是回环 HTTP 等待窗口，默认 `40000`ms。Worker 同时设置 `OPENCLAW_GATEWAY_SEND_TIMEOUT_MS=30000`；启动校验要求 Worker 窗口严格大于该值加 `5000`ms 缓冲。每次投递还会把这两个**实际控制定时器**值放入既有 HMAC 覆盖的 request body；Gateway 在消耗授权、获取幂等发送权或调用 Adapter 前，强制要求前者等于本实例的 `ILINK_REQUEST_TIMEOUT_MS`，且后者严格多出 `5000`ms。这样独立进程配置成 Worker `30/40`、Gateway `60` 时会在发送前以 `ILINK_REQUEST_INVALID` 拒绝，调用次数为零。任一值不是允许范围内正整数、或关系不满足时业务进程拒绝启动。不得将 Worker 窗口缩短到 Gateway 的完整发送窗口以内。

仅管理员可显式启用单一 `openclaw` 规则。Gateway 可通过经批准的静态映射管理最多 50 名内部接收人；修改映射后必须重新启动 Gateway，禁止自动绑定、客户接收人、AI 日报和批量发送。日志只能记录状态和安全错误码，不能记录消息全文、会话凭证、用户或接收人标识。

上述 50 项仅是映射文件的结构上限，不代表发布允许 50 名启用接收人；本次生产始终只允许一项 `enabled=true`。

## 启动前门禁

1. 使用全新的隔离非生产数据库副本并迁移到 `007`；不得连接生产库或 `server/data`。
2. 确认 `001` 至 `006` checksum 未变、`007` 成功、完整性为 `ok`、外键检查为空、全部规则关闭。
3. Secret 文件为仓库外普通文件且权限精确 `0600`；状态/会话目录为仓库外真实目录且权限 `0700`。不得输出文件内容。
4. 运行已编译的 `gateway:recipient-map-check`，它必须仅以 `SAFE` 和聚合计数成功，并证明映射恰好一个 `enabled=true`；零个或多个启用项均停止。live Gateway 复核同一门禁。未绑定用户以 `OPENCLAW_RECIPIENT_NOT_BOUND`、`enabled=false` 用户以 `OPENCLAW_RECIPIENT_DISABLED` 在 Gateway 调用 Adapter 前被拒绝，绝不回退到其他接收人。旧 `OPENCLAW_PILOT_USER_ID` 与 `ILINK_POC_RECIPIENT_EXTERNAL_ID` 仍兼容但已废弃，并保留 `OPENCLAW_RECIPIENT_NOT_ALLOWED`，且 Gateway 的弃用警告不得输出用户或接收人标识。
5. OpenClaw 官方前置检查和会话状态明确就绪；如需重新扫码，必须由专用账号人工完成。
6. API、AI Scheduler、DeepSeek、Mock、其他 Worker 和其他队列写入来源均停止；Gateway/Worker 必须为单实例。
7. 记录隔离数据库、Gateway 状态库和 `server/data` 的安全哈希；不得输出客户数据、接收人标识或 Secret。
8. 如需启用入站静默，先停止专用 daemon，备份仓库外 `OPENCLAW_CONFIG_PATH` 并保持 `0600`；仅按 `poc/ilink-gateway/openclaw-plugins/xiansuo-no-reply/README.md` 执行受支持的 `openclaw plugins install --link <绝对路径>`（不得加 `--force`），随后依次执行 `config set plugins.entries.xiansuo-openclaw-no-reply.enabled true` 和 `config set plugins.entries.xiansuo-openclaw-no-reply.hooks.allowConversationAccess true`。只用官方 `plugins inspect --runtime --json` 验证注册：必须有 `hookCount=1`、`typedHooks` 中的 `before_agent_reply` 且没有 diagnostics；不得以真实微信消息、Provider 或业务 API 验证。默认不安装且本轮未修改仓库外配置。
9. 取得正式启动授权后，在只注入同一组仓库外 `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` 的专用服务环境中执行官方前台入口 `openclaw gateway run --bind loopback`，再用 `openclaw gateway status` 只读核对。禁止 `--force`、`--allow-unconfigured`、`lan`/`tailnet`/`custom` 绑定和公网暴露；本手册不授权执行该命令。

## 首次真实 Pilot 的隔离 synthetic 门禁

默认不执行。仅在主代理获得实况授权后，以新建的 `0700` 系统临时目录运行一次：

```bash
mkdir -p /tmp/<本次唯一随机目录>
chmod 700 /tmp/<本次唯一随机目录>

cd server
npm run openclaw:enqueue-synthetic-pilot -- \
  --db-path /tmp/<本次唯一随机目录>/openclaw-synthetic-pilot.db \
  --pilot-user-id <唯一正整数> \
  --idempotency-key <固定键>
```

CLI 拒绝相对、仓库内、`server/data`、非 `0700`、非空或已有但不完全匹配的库；不会删除、清理、登录或发送。Gateway Secret 必须放在另一个仓库外私有目录，不能放进这个要求首次为空的 DB 目录。成功输出中的 `business_date` 只用于下面两次只读预检：

```bash
DB_PATH=/tmp/<本次唯一随机目录>/openclaw-synthetic-pilot.db \
npm run pilot:queue-check -- \
  --recipient-user-id <唯一正整数> \
  --event-type daily_report \
  --business-date <入队输出日期> \
  --synthetic-idempotency-key <同一固定键>
```

必须原样连续执行两次且均为 `SAFE`，并核对每次预检前后 DB/WAL/SHM 哈希不变；中间不得启动任何写入进程。随后才可使用完全相同的绝对 `DB_PATH` 启动单实例 Worker。不得通过 API/H5、业务动作、直接 SQL 或不同键创建任务；任何非 synthetic 任务或终态污染均停止。

路径的请求父目录必须等于 realpath 且严格位于 `realpath(os.tmpdir())` 内；上级符号链接、硬链接和 DB/WAL/SHM 非精确 `0600` 均会失败。每次 CLI、queue-check 与 Worker 发送前会证明 sealed 状态（完整性、外键、迁移 checksum、零业务数据、关闭规则、唯一任务阶段）；任一失败均不得启动或继续发送。

如库存在 synthetic 标记，Worker 将在 retention cleanup 和 claim 之前对整库门禁，并在 claim 后再次校验：额外 pending、retry_wait、可恢复 sending 或任何终态项均会停止整轮，不能通过任务顺序或保留期清理绕过。出现 `notification.worker.synthetic_batch_blocked` 时不重试本轮或手改任务，保持渠道关闭并交由独立复验。

## 结果检查与停止

- 成功必须有 Gateway 安全回执；去重返回必须携带相同原回执。只有 Gateway 完整发送窗口真正耗尽、连接中断或响应不能确认时才会记录 `OPENCLAW_SEND_RESULT_UNKNOWN`，且 `retry_allowed=0`；永久失败或账号受限同样停止且不重试。
- 必须确认唯一任务为 `sent`、自动尝试不超过 2、无其他任务被领取、无 DeepSeek 或 AI Scheduler 调用或业务副作用。`owner_changed` 的固定详情、脱敏和 `openclaw-weixin` 入站静默仅以自动化验证为准，不扩大为入站业务能力。
- 完成后关闭 `OPENCLAW_CHANNEL_ENABLED` 和 `ILINK_POC_LIVE_ENABLED`，正常停止 Worker、Gateway 与 OpenClaw daemon，确认无残留进程。
- 不退出或删除会话，除非用户明确要求；不补发历史任务。将脱敏结果写入 Pilot 报告，不提交配置、状态库、二维码、日志或 Secret。
