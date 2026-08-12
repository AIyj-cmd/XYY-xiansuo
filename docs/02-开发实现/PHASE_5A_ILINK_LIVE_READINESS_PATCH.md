# 阶段五A：iLink 实况 PoC 就绪补丁

> 实现日期：2026-08-01。此补丁只准备受控实况门禁；未安装 OpenClaw、未登录、未生成二维码、未扫码、未发送消息，且未访问业务数据库、outbox、Worker 或 DeepSeek。

## 实现范围

- 每个 OpenClaw 子进程显式注入 `OPENCLAW_STATE_DIR` 与 `OPENCLAW_CONFIG_PATH=<stateDir>/openclaw.json`，覆盖父进程同名变量；live 模式使用必填的 `ILINK_POC_SESSION_DIR`，live 关闭的只读前置检查使用 `ILINK_POC_STATE_DIR/openclaw-offline`。二者均为仓库外、非符号链接且 `0700`，Gateway 从不读取目录内容。
- `gateway:prereq-check` 以实际 `openclaw --version`、插件 metadata 的版本/兼容范围（含 `openclaw.install.minHostVersion` / `install.minHostVersion`）及 `channels capabilities --channel openclaw-weixin --json` 决定 `READY` 或 `NOT_READY`。仅公开的 `actions` 含 `send`/`message.send` 或明确 `send=true` 能证明桥接；`sendText` 等猜测字段、冲突或不可解析结构均返回 `ILINK_SEND_CONTRACT_UNVERIFIED`。源码没有写死任一最低 OpenClaw 版本。
- `gateway:login -- --confirm-live-login` 只有 `ILINK_POC_LIVE_ENABLED=true`、先决条件 `READY`、仓库外非符号链接 `0700` state/session 目录均通过时，才以继承当前终端 stdio 的方式运行官方 `openclaw channels login --channel openclaw-weixin`。包装器不捕获二维码、不保存密码或凭证，也不打印官方 stdout。
- `gateway:official-session-status` 使用 `channels status --probe --json`；只输出脱敏状态、是否需要人工登录及安全错误码。它不解析 OpenClaw 私有文件。
- live 出站必须再次由 capability/契约门禁允许，且只能调用官方 `openclaw message send --channel openclaw-weixin --target <固定测试接收人> --message <固定合成正文> --json`。它不接受 token/context token、自定义正文或接收人。通用 CLI 的正常成功不是 raw iLink `ret`：只有严格 `{ ok: true, result: { messageId: "…" } }` 才是 OpenClaw 适配器已完成 provider `ret` 校验后的官方运行时确认；如 envelope/result 提供 `channel` 必须为 `openclaw-weixin`，`channelId` 是 provider 目标标识，仅校验安全非空格式且绝不回显或用于回执。Gateway 仅保存其哈希 `ilink-runtime:` 回执，不伪造 raw `ret` 或官方 message ID。

## 结果语义与隔离

- raw/mock HTTP 响应中可解析 `ret=0`：`sent`；缺失服务端 ID 使用 `ilink-local:<sha256>` 审计回执。CLI 包装响应只接受上述严格运行时确认；若 CLI 非零退出但 stdout 含数值 `ret`，仍按 raw `ret` 分类；其他不可解释输出不成功。
- 明确会话失效、登录要求、限流、账号限制、拒绝和请求前本地失败各自安全分类；上游 `errmsg` 不存储。
- 只有进程/请求可能已提交、但超时、连接中断或输出不可解释时才记录 `result_unknown`。同一幂等键的未知结果不会自动重发。
- `ILINK_POC_STATE_DIR` 只存本 Gateway 的 nonce、幂等与安全回执哈希；state DB 及 WAL/SHM 均收紧为 `0600`。`ILINK_POC_SESSION_DIR` 仅作为官方运行时隔离目录门禁，Gateway 不读取其内容。

## 冻结配置和运维入口

冻结名称为 `ILINK_POC_LIVE_ENABLED`、`ILINK_OPENCLAW_BIN`、`ILINK_OPENCLAW_CHANNEL`、`ILINK_POC_RECIPIENT_EXTERNAL_ID`、`ILINK_POC_STATE_DIR`、`ILINK_POC_SESSION_DIR`、`ILINK_GATEWAY_HOST`、`ILINK_GATEWAY_PORT`、`ILINK_GATEWAY_SECRET`、`ILINK_REQUEST_TIMEOUT_MS`、`ILINK_SESSION_CHECK_TIMEOUT_MS`。所有路径均须绝对；不再保留未实际生效的 `ILINK_CONNECT_TIMEOUT_MS`。旧 `ILINK_GATEWAY_STATE_DIR` 和 `ILINK_POC_TIMEOUT_MS` 临时映射并打印弃用告警，同时设置新旧名会拒绝启动。

`gateway:send-synthetic` 必须显式提供严格格式的 `--idempotency-key`；不接受自定义正文或接收人。`--expect-deduplicated` 只能核验已有同键结果，不能换键绕过未知结果。

## 离线验证

自动化使用 fake command runner 与 mock transport；不调用真实 OpenClaw、不访问腾讯网络，也不生成二维码或读取会话。Gateway 测试覆盖登录 argv、版本/能力失败关闭、全部健康状态、`ret=0`、非零 ret、请求前失败、提交后不确定、HMAC/nonce、配置、目录权限与幂等。

## 验收补充

验收阶段只处理独立测试报告确认的 P2 时间夹具：`server/test/phase3-independent-verifier.test.ts` 的人工重试用例改为从运行时当前 Asia/Shanghai 时间派生创建、领取和失败时间，避免固定日期在 TTL 之后失效。没有修改业务源码、TTL、人工重试门禁或断言。修复后 Gateway 28/28、后端 121/121、H5 构建与 Gateway `npm audit --omit=dev` 全部通过；本机未安装 OpenClaw 时实际前置检查安全返回 `NOT_READY / ILINK_OPENCLAW_NOT_INSTALLED`。
