# OpenClaw 内部通知运行手册

## 默认边界

默认所有开关关闭。Gateway 只监听 `127.0.0.1`，不配置 `DB_PATH` 或 DeepSeek Key。业务 API、AI Scheduler 和 H5 不读取 OpenClaw 会话或 Gateway Secret。不得使用日常主账号、客户账号、Hook、RPA、逆向协议、自动换号、批量发送或入站业务指令。

配置 `OPENCLAW_CHANNEL_ENABLED`、一个 `OPENCLAW_PILOT_USER_ID`、回环 `OPENCLAW_GATEWAY_URL` 和仓库外精确 0600 `OPENCLAW_GATEWAY_SECRET_FILE`。Gateway 使用同一 Secret 文件、固定 `ILINK_POC_RECIPIENT_EXTERNAL_ID`、规范 `OPENCLAW_STATE_DIR`（仓库外 0700 官方会话状态目录）和 `OPENCLAW_CONFIG_PATH`。旧 `ILINK_POC_SESSION_DIR` 仅为兼容别名，不得与规范项同时设置。会话失效只能由人工使用专用账号重新登录。

仅管理员可显式启用单一 `openclaw` 规则。不得扩大 pilot、启用 AI 日报、增加接收人或发送批量通知。日志只能记录状态和安全错误码，不能记录消息全文或会话凭证。

## 启动前门禁

1. 使用全新的隔离非生产数据库副本并迁移到 `007`；不得连接生产库或 `server/data`。
2. 确认 `001` 至 `006` checksum 未变、`007` 成功、完整性为 `ok`、外键检查为空、全部规则关闭。
3. Secret 文件为仓库外普通文件且权限精确 `0600`；状态/会话目录为仓库外真实目录且权限 `0700`。不得输出文件内容。
4. `OPENCLAW_PILOT_USER_ID` 与 Gateway 的同名配置完全一致，只配置一个启用测试用户；固定外部接收人只能来自 Gateway 私有配置。
5. OpenClaw 官方前置检查和会话状态明确就绪；如需重新扫码，必须由专用账号人工完成。
6. API、AI Scheduler、DeepSeek、Mock、其他 Worker 和其他队列写入来源均停止；Gateway/Worker 必须为单实例。
7. 记录隔离数据库、Gateway 状态库和 `server/data` 的安全哈希；不得输出客户数据、接收人标识或 Secret。

## 首次真实 Pilot 的二选一门禁

当前固定合成 CLI 不写业务 outbox，而 Worker 只发送三种批准事件模板。不得为凑齐验收证据直接伪造数据库记录、增加第四事件或绕过消息策略。操作者必须先取得用户对以下一种模式的明确选择：

- **模式 A：渠道实况。** 仅启动 OpenClaw daemon 与 `xiansuo-ilink-gateway`，运行一次 `gateway:send-synthetic`。正文固定为“XYY-xiansuo普通微信通知通道已连接 / 这是一条内部测试消息”。随后以同一幂等键调用 `--expect-deduplicated`；预期不再次发送。该模式不声称验证了 Worker/outbox 实况。
- **模式 B：完整链路实况。** 使用隔离业务动作生成三种既有事件之一的唯一 OpenClaw outbox，再启动单实例 Worker；实际正文为该事件的固定最小化模板，不是合成连接文案。执行前必须单独批准事件类型、隔离数据库和测试用户。该模式最多一条真实消息。

没有明确选择时保持所有 live 开关关闭，不发送。

## 结果检查与停止

- 成功必须有 Gateway 安全回执；去重返回必须携带相同原回执。`result_unknown`、永久失败或账号受限均停止且不重试。
- 模式 B 还必须确认唯一任务为 `sent`、自动尝试不超过 2、无其他任务被领取、无 DeepSeek 调用或业务副作用。
- 完成后关闭 `OPENCLAW_CHANNEL_ENABLED` 和 `ILINK_POC_LIVE_ENABLED`，正常停止 Worker、Gateway 与 OpenClaw daemon，确认无残留进程。
- 不退出或删除会话，除非用户明确要求；不补发历史任务。将脱敏结果写入 Pilot 报告，不提交配置、状态库、二维码、日志或 Secret。
