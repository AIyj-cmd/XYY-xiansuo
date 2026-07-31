# 阶段五A：iLink 官方兼容性复核

> 核验日期：2026-07-31
> 核验范围：仅官方资料与源码公开契约；未安装 OpenClaw/iLink、未登录、未生成二维码、未发送消息。
> 结论：**存在可维护的官方 `sendmessage` 调用边界，因此可实现默认关闭的离线 PoC Gateway；主动定时通知能力仍须由后续专用测试账号实况 PoC 证明。**

## 官方证据

- [Tencent/openclaw-weixin 官方仓库](https://github.com/Tencent/openclaw-weixin)：审计日公开仓库显示 `2.0.x` 为 Active，要求 OpenClaw `>=2026.3.22`；`1.0.x` 仅 legacy maintenance。
- [官方 README](https://github.com/Tencent/openclaw-weixin/blob/main/README.md)：要求预先安装 OpenClaw；安装命令为 `npx -y @tencent-weixin/openclaw-weixin-cli install` 或插件安装命令。二者均**未在本轮执行**。
- [官方 API 源码](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts) 与 [类型定义](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts)：与 README 的 HTTP JSON 协议和消息类型一致。
- [LICENSE](https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE)：MIT。

## 已核验的接口与运行约束

1. 官方 README 明确 QR 登录流程：`openclaw channels login --channel openclaw-weixin`，终端展示二维码、手机扫码并确认后，本地自动保存登录凭证。该流程是**交互式门禁**，本轮未调用。
2. 后端协议为 HTTP JSON；公共头包含 `AuthorizationType: ilink_bot_token`、登录后获得的 Bearer token 和 `X-WECHAT-UIN`。
3. 官方端点清单包括 `getupdates`、`sendmessage`、`getuploadurl`、`getconfig`、`sendtyping`。本 PoC 只定义文本 `sendmessage` 最小边界。
4. 当前官方源码的文本发送端点为 `POST ilink/bot/sendmessage`；请求包含 `msg.to_user_id`、`msg.context_token`、文本 `item_list` 与 `base_info`。公共头包含 `AuthorizationType: ilink_bot_token`、登录 token、`X-WECHAT-UIN`（密码学随机 uint32 的十进制字符串再 Base64）、`iLink-App-Id` 和 `iLink-App-ClientVersion`。`context_token` 来自入站消息，并须在回复时带回；它不是本系统可以自行生成的稳定业务用户标识。
5. `getupdates` 响应例中 `ret=0` 表示成功，`errcode=-14` 代表 session timeout。公开资料未提供足以证明“定时主动通知”的永久会话窗口、投递回执或重启后自定义 Gateway 会话文件格式。
6. README 说明登录凭证会本地保存，但未给出可供本项目安全依赖的稳定、版本化 session 文件格式。因此 Gateway 的 `state/session.json` **只是后续实况 PoC 人工导入的本地抽象**，不是腾讯官方凭证格式；它以严格 schema、0600 权限、常规文件和 state 根目录边界验证，不猜测格式、不实现扫码、不会伪造无人值守恢复能力。

## 兼容性结论与实现边界

| 项目 | 结论 |
|---|---|
| 当前维护状态 | 官方仓库 `2.0.x` 标为 Active；实现前仍要复核 Release、Issue 和目标 OpenClaw 版本。 |
| 运行环境 | 官方插件依赖 OpenClaw；本轮独立 Gateway 不安装、不嵌入该插件。后续实况 PoC 必须按官方环境要求单独准备。 |
| 登录/二维码 | 仅人工交互式登录；本轮和离线验收均禁止。 |
| `to_user_id` | 来自官方会话/消息上下文；PoC 只允许仓库外固定测试接收人配置，绝不按姓名或通讯录猜测。 |
| `context_token` | 来自入站会话、有效范围和主动通知可用性尚待实况验证；不会写入普通日志。 |
| 发送语义 | `sendmessage` 有官方 HTTP 边界；公开资料不足以证明最终送达或 exactly-once，因此成功响应也不能被设计为最终生产回执。 |
| 重启恢复 | 官方登录凭证会本地保存，但本项目不将其当作稳定公开文件契约；PoC 需实际验证重启、过期与重新扫码。 |
| 许可证 | MIT；仍需在实际集成当天复核依赖链、版本和商业/账号使用要求。 |

## Go / No-Go

**Go（仅离线 Gateway）**：有官方维护的文本 `sendmessage` 协议和明确的 `to_user_id` / `context_token` 边界，可在 `ILINK_POC_LIVE_ENABLED=false` 下完成测试替身、请求认证、幂等和会话边界。

**No-Go（真实使用）**：本复核不能证明从未与 Bot 近期互动的用户可接收定时通知，也不能证明 context token 有效期、最终投递回执或无人值守重启。因此不得在本轮登录、扫码、调用外网或发送测试消息；后续实况 PoC 必须用专用账号和合成内容验证这些条件。
