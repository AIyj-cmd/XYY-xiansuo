# 阶段五A：iLink 隔离 PoC Gateway 实现

> 状态：离线实现、独立验证和最终验收已完成；不等于获准实况 PoC 或生产使用。

## 实现范围

新增独立工程 `poc/ilink-gateway/`，不导入 `server/`、业务 SQLite、通知 Worker、DeepSeek 或 H5。工程只使用 Node 内置 `http`、`crypto`、`node:sqlite`、`fetch` 与 Zod v4。

- `POST /deliveries`：严格 Zod schema，16 KiB 请求上限，固定单测试接收人约束。
- `GET /health`、`GET /session/status`：仅本地回环监听下的安全状态投影；不返回 token、二维码、接收人全文或消息正文。
- HMAC-SHA256：`METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256`，常量时间比较，当前/前序 Secret 验证窗口，时间窗、速率限制和持久 nonce 防重放。
- PoC 独立 SQLite state：只存 nonce、消息/接收人哈希、投递状态和安全元数据；不使用业务数据库。
- 幂等：同键同消息 sent 返回 `deduplicated`；同键不同消息或接收人拒绝；`result_unknown` 永不自动重发或改发。
- `FakeAdapter`：成功、重复、超时、临时/永久失败、结果未知、离线、登录失效和延迟；无网络。
- `ILinkAdapter`：精确预留官方 `POST ilink/bot/sendmessage`、`base_info`、`iLink-App-Id`、`iLink-App-ClientVersion`、认证头和加密随机 UIN 边界；默认 `ILINK_POC_LIVE_ENABLED=false`，关闭时不读凭证、不发网、不生成二维码并返回 `ILINK_LIVE_DISABLED`。
- 会话：`state/session.json` 是本项目 PoC 的人工导入抽象，**不是腾讯官方稳定凭证格式**。它严格拒绝未知字段，要求 state 根目录内的 0600 常规文件；只实现状态、权限检查、过期/缺失投影和清理 CLI，不实现扫码、设备确认、二次验证或无人值守登录。
- CLI：`gateway:health`、`gateway:session-status`、`gateway:send-synthetic`、`gateway:clear-session`。合成发送只使用固定文本模板。

## 隔离与安全取舍

1. Gateway 固定监听 `127.0.0.1` 或 `::1`，拒绝 `0.0.0.0`；后续跨节点方案须经单独审计后增加 mTLS/HMAC 网络边界。
2. `recipient_external_id` 仅以 SHA-256 哈希保存在独立 state，而非明文，仍足以检测幂等冲突。
3. iLink 官方 README 没有稳定公开的 base URL 或可被本项目依赖的 session 文件格式；base URL、App ID 和版本字段仅能通过仓库外严格配置提供。PoC 会话固定为本地受控 `state/session.json` 抽象，源码不猜测腾讯持久化格式。
4. 官方 `sendmessage` 接受不是最终投递证明，live Adapter 保守返回 `result_unknown`，等待未来实况 PoC 核验回执语义。

## 未包含内容

无真实登录、二维码、扫码、发送、OpenClaw/iLink 安装、真实测试账号、业务消息、业务数据库、迁移007、通知 Worker 变更、DeepSeek 变更、企业微信或 H5 页面。

最终验收补充收敛了畸形会话 JSON：解析失败只返回安全错误码
`ILINK_SESSION_INVALID`，不会把解析器异常文本当作渠道错误码或健康信息输出。
