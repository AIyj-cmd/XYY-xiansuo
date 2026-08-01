# 阶段五A-2：Direct iLink Gateway 官方协议审计与技术设计

> **2026-08-01 最新用户授权说明：** 本文对 **Direct iLink** 的 No-Go 结论仍然
> 有效；用户没有批准深层导入、私有凭据解析或 Direct Gateway。用户另行批准的是
> 复用现有 `poc/ilink-gateway` 与官方 OpenClaw CLI/daemon 的实验性内部通知路线，
> 并明确接受其人工扫码、长轮询、会话失效和主动通知不确定性。本文中把 OpenClaw
> daemon No-Go、阶段五A全部关闭或所有真实渠道暂停写成“当前状态”的文字，仅作为
> 当时审计历史保留，不得用于否定这项后续明确授权；Hook、RPA、逆向协议仍禁止。

> 状态：**2026-08-01 用户决定：OpenClaw daemon 与 Direct iLink 均为 No-Go；所有真实外部消息渠道暂停。本文仅保留路线关闭的历史审计事实与未来重新审计参考。**
> 审计日期：2026-08-01
> 审计基线：`validation/phase5a-ilink-authenticated-session` /
> `0b308fc6200d9d466e258d7f6ba27b164f529dff`
> 审计对象：OpenClaw `2026.7.1-2`、
> `@tencent-weixin/openclaw-weixin@2.4.6`、现有隔离 PoC Gateway

## 1. 执行结论

> **后续决策覆盖说明：** 企业微信自建应用已由用户明确取消，不属于后续候选；
> 公众号/服务号及其他真实外部渠道也全部暂停。现行正式通知仅为 H5 站内通知，
> Mock 仅用于测试/灰度验证；阶段三通知基础设施与阶段四 DeepSeek 调度、
> `scheduled_follow_overdue`、`daily_report`、AI 审计和模板降级保留，但不向外部
> 渠道发送。迁移 `007`、`notification_deliveries`、`notification_channel_bindings`
> 暂缓，不进入实现，不补发。本文中任何企业微信门禁、Gateway、握手、轮询、
> 测试、PoC、fallback 或实施顺序均不是当前计划。后续仅等待新的官方普通微信
> 独立 client/session 且支持主动通知，或用户重新批准合法官方渠道后重新审计。

本轮最终结论为 **双 No-Go，阶段五A关闭**：OpenClaw daemon 与 Direct iLink
路线当前均不得进入实现、登录、入站轮询、固定握手、延迟发送 PoC、3 至 7 天
功能观察、30 天稳定性观察、真实 outbox、生产或 fallback。

这不是关闭整个 iLink 研究方向，也不是否定 HTTP 协议在技术上的可调用性。
阻塞点是：当前官方资料没有提供一个能同时满足以下条件的稳定客户端边界：

1. 不运行 OpenClaw daemon；
2. 使用官方支持的登录与会话；
3. 不读取或解析插件私有凭据文件；
4. 通过公开、稳定的包导出获取登录凭据并调用 `getUpdates/sendMessage`；
5. 不依赖深层内部文件、复制内部登录实现或未文档化的登录接口。

官方 README 公开了后端 HTTP JSON 协议中的 `getUpdates`、`sendMessage`、
`getUploadUrl`、`getConfig`、`sendTyping`，并明确 `context_token` 来自消息上下文、
回复时必须带回。可是 npm 包根入口只导出 OpenClaw 插件注册对象；包没有声明
稳定的客户端 `exports`，登录、API client、账户文件和 token 存取均位于深层内部
源码。官方 CLI 能完成登录，但凭据保存在插件私有状态中，没有公开的安全凭据
移交或独立 session client 接口。

因此以下两条当前均不可批准：

- **OpenClaw daemon 路线**：启动后进入 `notifyStart`、`getUpdates`、Agent 回复、
  typing 和错误通知链，无法证明零出站，已判定 No-Go。
- **Direct 路线**：若不使用 daemon，只能深层导入/复制插件内部代码或解析私有
  凭据，违反本任务冻结的 Go 条件，当前同样 No-Go。

未来只有腾讯提供并承诺稳定的独立 client/session 导出，或书面确认 Direct 使用
方式及登录凭据交接契约后，才可重新审计。届时本文件中保留的架构、握手、轮询、
测试和 PoC 内容仅可作为参考，不能自动恢复为实施计划；还须重新确认主动通知
契约、用户授权和范围。

### 1.1 已保留的历史事实

- 离线 Gateway 曾实现且相关测试通过；
- 已安装 OpenClaw 与官方插件，并使用专用账号完成扫码；
- 本地曾持久化登录凭据；消息实际发送数为 0；
- OpenClaw daemon 未启动；
- Direct 路线已完成只读审计；最终结论为上述双 No-Go。

这些事实不构成已批准的运行、登录、轮询或发送授权。

## 2. 审计范围与证据分级

### 2.1 官方资料

- [腾讯官方仓库及 README](https://github.com/Tencent/openclaw-weixin)
- [官方中文 README](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md)
- [官方 API 实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts)
- [官方 API 类型](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts)
- [官方二维码登录实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)
- [官方账户存储实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/accounts.ts)
- [官方 MIT LICENSE](https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE)
- npm registry 中 `2.4.6` 的实际 package metadata

### 2.2 本地真实代码

- 已安装包 `package.json`、`index.ts`、`src/api/*`、`src/auth/*`、
  `src/messaging/inbound.ts`、`src/storage/sync-buf.ts`、`src/monitor/monitor.ts`
- `poc/ilink-gateway/src/official-runtime.ts`
- `poc/ilink-gateway/src/adapters/ilink-adapter.ts`
- `poc/ilink-gateway/src/auth.ts`
- `poc/ilink-gateway/src/state-store.ts`
- `poc/ilink-gateway/src/gateway-service.ts`
- `poc/ilink-gateway/src/message-policy.ts`

### 2.3 证据规则

- README 明示内容视为公开协议说明；
- npm 根导出和 package metadata 视为可依赖的公开包契约；
- 深层源码行为只视为当前 `2.4.6` 实现事实，不视为跨版本承诺；
- Issue 只作为风险线索，不视为服务级保证；
- 本文的主动发送、token 有效期结论若无官方文字，明确标记为“未知；仅在未来
  官方能力解锁并重新批准后才可验证”，不由源码参数存在性推导。

## 3. OpenClaw daemon 与 Direct 路线

| 维度 | OpenClaw daemon | 理想 Direct Gateway |
|---|---|---|
| 登录 | 官方 CLI 与插件 | 官方独立 session client |
| 收取更新 | 插件 monitor | 最小只读 poller |
| 入站处理 | 进入 OpenClaw Channel/Agent | 只提取路由元数据，正文立即丢弃 |
| 自动回复 | 存在回复、typing、进度和错误通知链 | 代码中不存在相关模块 |
| 业务依赖 | OpenClaw runtime/Agent | 无 Agent、LLM、Tool、业务库 |
| 当前结论 | No-Go | 当前缺少官方稳定登录/client 边界，No-Go |

Direct 的价值是从构造上消除 Agent 和回复能力，而不是绕开腾讯的登录、会话、
token、频率或账号限制。

## 4. 官方 HTTP 协议审计

### 4.1 公共请求结构

当前 `2.4.6` 源码使用的默认 Base URL 是
`https://ilinkai.weixin.qq.com`。该值来自实现中的账户默认值；README 没有把
Base URL 声明为独立长期兼容承诺，因此升级时必须重新核验。

共同请求头：

| 请求头 | 当前来源与语义 |
|---|---|
| `Content-Type` | `application/json` |
| `AuthorizationType` | 固定 `ilink_bot_token` |
| `Authorization` | `Bearer <登录后 token>` |
| `X-WECHAT-UIN` | 随机 uint32 的十进制字符串再 Base64 |
| `iLink-App-Id` | 包 metadata 的 `ilink_appid`，当前为 `bot` |
| `iLink-App-ClientVersion` | 由插件语义版本编码 |
| `SKRouteTag` | 可选，实现配置项；不得自行猜测 |

每个业务请求还包含 `base_info`：

```json
{
  "channel_version": "<插件版本>",
  "bot_agent": "<经清洗的客户端标识>"
}
```

### 4.2 已公开的端点

| 能力 | 方法与实际路径 | 关键请求 | 关键响应 |
|---|---|---|---|
| getUpdates | `POST /ilink/bot/getupdates` | `get_updates_buf`, `base_info` | `ret`, `errcode`, `errmsg`, `msgs`, 新 cursor、长轮询时间 |
| sendMessage | `POST /ilink/bot/sendmessage` | `msg.to_user_id`, `msg.context_token`, `item_list`, `base_info` | `ret`, `errmsg` |
| getConfig | `POST /ilink/bot/getconfig` | `ilink_user_id`, 可选 `context_token`, `base_info` | `ret`, `typing_ticket` |
| sendTyping | `POST /ilink/bot/sendtyping` | 用户 ID、typing ticket、状态、`base_info` | JSON 响应 |
| getUploadUrl | `POST /ilink/bot/getuploadurl` | 媒体与接收人参数、`base_info` | 上传参数 |

`getUpdates` 的当前默认长轮询超时为 35 秒，普通 API 为 15 秒，轻量配置
API 为 10 秒。这些是 `2.4.6` 实现默认值，不是项目应永久写死的协议常量。

文本发送的最小消息对象还必须由严格 Schema 固定以下字段，不允许请求方自由
覆盖：`client_id`、`message_type=BOT`、`message_state=FINISH`、单一文本
`item_list`、`to_user_id` 和 `context_token`。Base URL、公共头和 `base_info`
同样不得由 HTTP 投递请求传入。

### 4.3 成功语义

Direct 设计必须使用：

```text
HTTP 响应可用 + JSON 对象可解析 + ret === 0
→ sent / success
```

不得用“HTTP 2xx”或缺少 `ret` 推断成功。当前插件 `sendMessage()` 返回 `void`，
并用宽松条件判断非零 ret；Direct 设计不能照搬该弱语义，必须保留并严格解析
原始安全字段。`errmsg` 只用于分类，不进入日志或用户响应。

### 4.4 未公开为稳定契约的端点

当前源码还使用：

- `POST /ilink/bot/get_bot_qrcode?bot_type=...`
- `GET /ilink/bot/get_qrcode_status?qrcode=...`
- `POST /ilink/bot/msg/notifystart`
- `POST /ilink/bot/msg/notifystop`

二维码状态响应可包含 bot token、bot ID、Base URL 和扫码用户 ID。但官方 README
只公开 CLI 登录流程，没有将上述登录 HTTP 契约、状态枚举和凭据交接声明为
独立客户端 API。因此它们只能作为当前源码事实，不能作为 Direct 实现的稳定
批准边界。

### 4.5 会话状态

未发现独立、公开、只读且不消费更新的远端会话状态 API。当前实现通过 token
执行实际请求来发现失效；`getUpdates` 中 `-14` 被当前源码视为 stale token。
不能把本地凭据文件存在等同于远端 authenticated。

## 5. npm 包公开导出能力

`@tencent-weixin/openclaw-weixin@2.4.6` 的事实：

- npm latest 为 `2.4.6`；
- Node 要求 `>=22`；
- peer dependency 为 OpenClaw `>=2026.5.12`；
- license 为 MIT；
- package metadata 没有声明客户端 `exports`；
- 根 `index.ts` 默认导出 OpenClaw 插件注册对象；
- `getUpdates/sendMessage`、登录和账户函数虽在深层源码中使用 `export`，但没有
  从包根作为稳定 client/session API 暴露。

结论：可以通过深路径在技术上触达某些内部模块，不等于官方承诺这些路径、
参数或存储格式可供独立应用稳定使用。Direct 实现若依赖
`@tencent-weixin/openclaw-weixin/dist/src/...`，属于私有内部耦合，版本升级可以
无预警破坏，当前禁止。

## 6. 登录与会话结论

### 6.1 官方支持的登录

官方公开方式是：

```bash
openclaw channels login --channel openclaw-weixin
```

它人工展示二维码、轮询扫码/确认，并把 token、Base URL、账号 ID 等保存在
OpenClaw 插件自己的状态目录。该流程本身可作为官方登录工具。

### 6.2 CLI 登录 + Direct Gateway 是否闭环

当前不闭环。Direct Gateway若坚持不解析私有凭据文件，就拿不到 Bearer token
和重定向后的有效 Base URL；官方 CLI 也没有公开安全的 client handle、IPC 或
凭据移交接口。若读取 `accounts/*.json`，便依赖未承诺稳定的私有格式，违反冻结
边界。

### 6.3 Direct 自建登录是否闭环

当前源码提供深层 `startWeixinLoginWithQr()` 与 `waitForWeixinLogin()`，但这些
不是 npm 根公开 API，且依赖内部账户存储与 OpenClaw 状态目录。复制或深层导入
它们都触发 No-Go 条件。

### 6.4 重新审计的解锁条件

至少满足一项：

1. 腾讯包根导出并文档化独立 client/session API；
2. 官方提供受支持的 token/session broker 或只读凭据句柄；
3. 腾讯明确书面支持 Direct 客户端的登录、持久化和升级契约。

当前也未发现面向 Direct 客户端的公开主动退出或凭据轮换 API；插件内部的
`clearWeixinAccount()` 不是稳定公共契约。任何未来 session lifecycle 都必须
包含官方支持的退出、失效和重新登录方式。

## 7. `to_user_id` 与 `context_token`（协议审计事实；未来重新审计参考）

### 7.1 `to_user_id`

发送目标来自入站 `WeixinMessage.from_user_id`。未发现官方联系人目录查询或按
姓名、昵称、手机号解析的方法。首次获得通常需要接收该用户的消息。

结论：

- 是敏感外部标识，日志只保存 hash/末尾脱敏；
- 可以在专用 PoC 状态库按账号和接收人绑定保存，但需用户批准握手规则；
- 稳定性、跨重新登录/设备是否保持不变没有官方承诺；
- 从未互动的用户无法按当前公开协议预先安全取得。

### 7.2 `context_token`

官方 README 将其定义为消息中的会话上下文 token，并要求回复时原样带回。
当前 `2.4.6` 源码行为是：

- 从每条入站消息获取；
- 以 `accountId + userId` 为键覆盖当前值；
- 保存到每账号的私有 token 文件；
- Gateway 启动时恢复；
- 发送时按账号和目标用户查找。

但源码没有为持久记录保存官方到期时间，也没有证明服务端会接受恢复后的旧
token。公开文档没有承诺：

- 固定 TTL；
- 可重复使用次数；
- 10 分钟、1 小时或 24 小时后仍有效；
- 第二天定时主动发送；
- 长期无互动时主动发送；
- 重新登录或设备变化后继续有效。

因此“文件可恢复”只说明客户端保存能力，不等于服务端有效性。相关 Issue 中有
主动任务缺少 token、长耗时后疑似 token 失效、接口成功但未实际送达的报告；
这些只强化 PoC 必要性，不构成官方有效期结论。

## 8. 是否必须轮询入站更新（未来重新审计参考，非当前计划）

在当前公开能力下，为一个新接收人获得 `to_user_id/context_token`，必须接收
`getUpdates` 返回的消息；没有官方目录查询或主动创建上下文的方法。

| 方案 | 可行性 | 结论 |
|---|---|---|
| A 完全不轮询 | 无法为新用户取得路由 ID 和 token | 不可行 |
| B 只读更新轮询 | 技术上可提取元数据并丢弃正文 | 将来官方 client 解锁后的首选 |
| C 一次性人工绑定握手 | 可限定接收人和测试窗口 | 若解锁，作为 B 的受控产品流程 |

推荐的未来规则是 **B + C**：只允许一个专用测试接收账号发送固定握手；poller
只解析消息 envelope 的 sender、context token、时间、消息 ID 和 cursor，正文
与媒体不解码、不记录、不路由、不回复。该规则改变了此前“完全不接收微信
内容”的字面边界，必须由用户另行确认。

停止轮询后 token 能否用于延迟通知未知，不能由一次握手直接推断。

## 9. 零自动回复的 Direct 架构（未来官方能力解锁后的参考）

若未来官方稳定 client 解锁，建议新建独立目录，而不是向现有 OpenClaw Adapter
中增加模式：

```text
poc/direct-ilink-gateway/
├── src/config.ts
├── src/official-client.ts
├── src/login-controller.ts
├── src/session-store.ts
├── src/update-poller.ts
├── src/routing-token-store.ts
├── src/delivery-service.ts
├── src/idempotency-store.ts
├── src/message-policy.ts
└── src/cli/
```

依赖方向：

```text
人工登录 CLI → session-store
只读 poller → routing-token-store
固定合成投递 CLI → delivery-service → official-client.sendMessage
```

代码层禁止存在：

- OpenClaw Plugin/Channel/Agent runtime；
- LLM、Tool Call、Prompt、命令解析；
- `sendTyping`、`getConfig`、read receipt、自动回复；
- 业务数据库、outbox、DeepSeek、JWT；
- 收到更新后调用 `delivery-service` 的依赖边。

网络权限矩阵：

| 模块 | 允许网络 | 允许持久化 | 禁止事项 |
|---|---|---|---|
| login-controller | 仅官方登录端点 | 加密会话句柄 | 不记录二维码/token |
| update-poller | 仅 getUpdates | cursor、路由元数据 | 不保存正文、不调用 send |
| delivery-service | 仅 sendMessage | 幂等与安全结果 | 不调用 getUpdates/typing |
| CLI/HTTP boundary | 仅本机 | 无敏感正文 | 不接受自由消息或接收人 |

零自动回复证明应由静态依赖测试、网络端点 allowlist 和运行时 egress 断言共同
完成，而不是依赖配置布尔值。

## 10. 会话和凭证设计（未来官方能力解锁后的参考）

未来可行实现必须：

- 仓库外单独状态目录，目录 `0700`、敏感文件 `0600`；
- session/routing token 使用 OS secret store 或独立密钥加密；
- token 不进入业务 SQLite、日志、报告或环境变量；
- 单进程文件锁，第二实例 fail closed；
- 账号限制或 `-14` 时停止轮询和投递，等待人工登录；
- 不猜测、复制或编辑 OpenClaw 私有账户文件；
- 清除会话须人工命令并保留脱敏审计；
- 版本升级先通过录制契约测试，再允许 live。

由于当前官方稳定 session 接口不存在，本节只是解锁后的设计边界，不能实施。

## 11. 发送、幂等和错误语义（未来官方能力解锁后的参考）

复用既有逻辑投递键和保守结果：

```text
idempotencyKey + recipientHash + messageHash
```

- `ret === 0`：`sent`，无官方 ID 时生成 `ilink-local:<hash>`；它只是本地审计
  回执，不是微信服务端 message ID。
- 明确非零 ret：按会话、账号限制、频率或永久拒绝分类。
- 请求前失败：`retryable_failure` 或 `permanent_failure`，可确认未发送。
- 请求提交后超时、连接断开、非 JSON 或缺少 ret：`result_unknown`。
- `result_unknown`：禁止自动重试、换键重发和渠道 fallback，等待人工确认。
- token 失效：停止该接收人的投递，不无限刷新或无限重试。

固定 PoC 内容和每日最多三条的限制保持不变；本轮未发送。

## 12. 现有 PoC Gateway 复用评估（历史与未来参考）

### 12.1 可复用

- `auth.ts`：HMAC、时间戳、nonce、请求体 hash；
- `state-store.ts` / `replay-store.ts`：独立 SQLite、防重放；
- `idempotency-store.ts`：同键冲突、sent 去重、unknown 隔离；
- `message-policy.ts`：固定合成消息；
- `gateway-service.ts`：超时阶段与结果分类思想；
- `fake-adapter.ts`：离线故障矩阵；
- loopback、请求大小和频率限制。

### 12.2 必须替换

- `official-runtime.ts` 的 OpenClaw daemon/CLI 能力探测；
- `OpenClawCliTransport`；
- 现有 OpenClaw session status 映射；
- OpenClaw 登录包装与私有状态目录耦合；
- `ilink-adapter.ts` 中 `openclaw message send` 路径。

### 12.3 目录决策

推荐新建 `poc/direct-ilink-gateway/`，复制经过审计的通用安全模块并保留来源，
而不是在现有目录加入第二种 live Adapter。现有 `poc/ilink-gateway/` 保留为历史
OpenClaw 实验，默认关闭。构建和配置必须互斥；任何进程检测到两条 live 路线
同时启用都应启动失败。

当前 No-Go 下不得创建新目录。

### 12.4 现有 OpenClaw CLI 路线的具体缺陷

只替换状态解析器不能把现有 Adapter 变成 Direct 客户端：

- `official-runtime.ts` 用自定义 `actions=send/message.send` 结构判断能力，与插件
  实际通过 `outbound.sendText` 暴露发送能力的结构不等价；
- 当前 CLI 成功确认解析假设特定 `{ok,result}` 包络，不能作为当前 OpenClaw
  输出契约的稳定证明；
- context token 的磁盘恢复由插件 `startAccount` 路径执行；每次新起一个
  `openclaw message send` 进程，不能证明已恢复目标用户 token；
- iLink 响应没有稳定官方 message ID；插件返回的 client ID 或项目生成的 hash
  都只能称本地回执，不能证明终端已收到。

因此 Direct 路线必须替换 OpenClaw CLI transport，不能靠放宽 parser 或伪造
capability 结果继续。

## 13. 许可证与支持边界

官方仓库和 npm 包均声明 MIT。MIT 允许使用、复制、修改、分发和商业使用，
前提是保留版权与许可声明；这支持未来把官方源码作为参考或依法复用。

但许可证不等于：

- 深层内部 API 的兼容承诺；
- iLink 服务允许任意独立客户端；
- 账号主动通知资格；
- 规避平台会话与频率限制的授权；
- 腾讯对生产可用性提供保证。

因此“许可证允许复制”不能消除当前 No-Go。若未来复制少量 MIT 实现，必须保留
notice、记录来源版本并取得接口使用方式确认。本结论不是法律意见。

## 14. 威胁模型（未来重新审计参考）

| 风险 | 阻断层 |
|---|---|
| 二维码泄露 | 只在人工 TTY 显示，不落盘、不进日志 |
| 会话凭据泄露 | OS secret/加密状态、0600、进程隔离 |
| context token 泄露 | 加密存储；日志只报存在性与 hash |
| to_user_id 泄露 | 绑定库加密/哈希投影，不输出全文 |
| 入站正文落盘 | poller 在解析 envelope 后立即丢弃 `item_list` |
| 自动回复误触发 | poller 无 send 依赖；禁止 Agent/typing 模块 |
| 伪造更新 | TLS、官方 host allowlist、严格 Schema、cursor 单调推进 |
| 更新重复 | message ID/seq 去重；不触发任何回复 |
| token 重放 | 账号+用户绑定、文件锁、失效即停止 |
| 接收人替换 | 固定配置、recipient hash 和幂等冲突拒绝 |
| 内容篡改 | 固定模板、message hash、HMAC |
| 结果未知 | 不重试、不 fallback、人工确认 |
| 会话过期无限重试 | 有限退避后 `login_required`，人工处理 |
| 官方接口变化 | 固定版本、契约测试、升级门禁、fail closed |
| 依赖供应链 | 官方来源、lockfile、完整性与许可证核验 |
| 测试账号受限 | 立即停用 live、保留脱敏证据、不绕过 |

## 15. 测试矩阵设计（未来官方能力解锁后的参考）

### 15.1 官方客户端

- `ret=0`、非零 ret、空响应、非 JSON；
- 请求前失败、响应丢失、超时；
- endpoint/header/base_info 契约漂移；
- 版本升级与 schema 增删。

### 15.2 登录和会话

- 首次登录、二维码过期、人工取消；
- 会话持久化与重启恢复；
- token 失效、并发启动、文件锁；
- 目录权限、符号链接、清除会话；
- 不输出二维码和凭据。

### 15.3 更新轮询

- 空更新、单条、重复、多用户；
- 文本/图片/文件/非法结构；
- 只保留 sender、token、时间、cursor；
- 正文和媒体立即丢弃；
- send/typing/AI/业务调用计数始终为 0。

### 15.4 token

- 正常、缺失、过期、重复使用；
- 不同用户混用拒绝；
- Gateway 重启恢复；
- 10 分钟、1 小时、24 小时、无新互动；
- 明确拒绝和 `result_unknown`。

### 15.5 发送和隔离

- 单条成功、幂等、同键冲突、本地 receipt；
- unknown 不自动重试；
- 不访问业务数据库、outbox、DeepSeek、JWT；
- 不创建迁移 `007`；
- 不修改阶段三至阶段四代码。

所有 live 测试必须在未来重新审计并获得新的明确批准后才可提出；当前阶段五A
已关闭，本节不是待执行测试计划。

## 16. 解锁后的最小 PoC 顺序（已废止的候选顺序，仅供未来重新审计参考）

1. 取得官方稳定 client/session 支持证据；
2. 固定版本与公开契约，完成离线 Fake 测试；
3. 用户确认“元数据只读轮询 + 一次性固定握手”规则；
4. 专用账号人工登录并验证凭据隔离；
5. 接收账号发送一次固定握手，正文立即丢弃且零回复；
6. 短时间内发送一条固定合成消息；
7. 分别验证 10 分钟、1 小时、24 小时和 Gateway 重启后发送；
8. 无新互动验证主动通知；
9. token 失效和结果未知验证；
10. 形成脱敏报告，再决定是否继续 3 至 7 天功能观察。

任何失败不得通过持续互动、换 token、换幂等键或非官方接口掩盖。

## 17. 最终路线决定：双 No-Go，阶段五A关闭

### 已由用户确认：No-Go

当前存在实现阻塞 P1：

1. npm 根未提供稳定独立客户端和 session API；
2. CLI 登录与 Direct 客户端之间没有公开凭据移交契约；
3. 独立登录只能依赖深层内部函数或未文档化登录 HTTP 接口；
4. 独立 client 的服务使用资格和升级兼容没有官方承诺；
5. `context_token` 的延迟主动通知能力无官方有效期承诺。

其中 1 至 4 阻止实现；第 5 项进一步阻止对主动通知能力作出任何生产判断。
本文不保留 Conditional Go 状态，也不批准以 PoC 先行绕过这些阻塞项。

## 18. 未来重新审计的前置条件（非当前待确认事项）

阶段五A当前没有待确认规则、没有任务拆分、也没有可执行 PoC。若未来官方接口
解锁并重新审计，才需由用户重新明确确认：

1. 允许专用接收账号发送一次固定绑定握手；
2. 允许 Direct poller 接收更新 envelope；
3. 只保存 sender ID、context token、时间、message ID/seq、cursor；
4. 正文和媒体立即丢弃，且不进入日志、AI、业务系统；
5. 不回复、不 typing、不 read receipt、不执行命令；
6. token 加密持久化及最长保留时间；
7. 10 分钟/1 小时/24 小时验证最多发送次数；
8. `result_unknown` 由人工确认且不自动重试。

## 19. 二十二项明确回答（按路线关闭结论更新）

| # | 问题 | 明确结论 |
|---|---|---|
| 1 | 能否完全不运行 daemon | HTTP 层技术上可以；当前受支持登录/session 闭环不可以 |
| 2 | 是否有官方公开客户端 API | 有公开 HTTP 协议说明；没有稳定 npm 根 client/session 导出 |
| 3 | 是否必须调用私有内部实现 | 当前要闭环登录与凭据，必须；因此 No-Go |
| 4 | 官方登录能否独立完成 | CLI 可独立完成人工登录，但只保存到插件私有状态 |
| 5 | 是否仍需 CLI | 当前需要；但不能安全把会话交给 Direct 客户端 |
| 6 | 能否安全读取会话状态 | 未发现公开独立状态 API；不能靠本地文件推断远端认证 |
| 7 | `to_user_id` 来源 | 入站消息 `from_user_id` |
| 8 | `context_token` 来源 | 入站 `WeixinMessage.context_token` |
| 9 | 是否必须轮询 | 新接收人的可审计 ID/token 获取需要 `getUpdates` |
| 10 | 能否丢弃正文 | 未来自建 poller 可；当前未实现且需用户确认 |
| 11 | 是否需一次性握手 | 当前不批准；仅在官方能力解锁并重新审计后作为参考规则 |
| 12 | 能否延迟主动通知 | 未证明 |
| 13 | 是否有官方有效期承诺 | 未发现 |
| 14 | 重启后 token 能否恢复 | 客户端能恢复文件；服务端有效性未证明 |
| 15 | 能否证明无自动回复/typing | 独立最小架构可设计证明；OpenClaw daemon 不可 |
| 16 | 许可证是否允许 | MIT 允许使用/修改并要求保留 notice；不等于服务授权 |
| 17 | 可复用模块 | HMAC、nonce、幂等、固定消息、Fake、unknown 分类 |
| 18 | 是否新建独立目录 | 是，若未来解锁 |
| 19 | 总结论 | No-Go |
| 20 | 是否有阻塞 P1 | 有：公开 client/session/凭据闭环缺失 |
| 21 | 当前任务拆分 | 无；阶段五A已关闭 |
| 22 | 后续顺序 | 所有真实外部渠道暂停；仅等待新的官方普通微信独立 client/session 且支持主动通知，或用户重新批准合法官方渠道后重新审计 |

## 20. 未决项

- 腾讯是否会提供独立 client/session SDK 或稳定根导出；
- 登录 token 的受支持安全移交方式；
- 独立 client 是否属于官方允许的服务使用方式；
- `context_token` 的服务端 TTL、可重复使用和主动发送资格；
- 无近期互动时 `ret=0` 是否等于终端真实送达；
- 外部 ID 在重新登录、设备变化后的稳定性。

这些是外部协议/产品事实，不能由项目代码自行解决。

## 21. 变更与安全声明

本轮只读审计仓库、官方公开资料和已安装包的非凭据源码/元数据，并创建本设计
文档及同步阶段五路线状态。没有：

- 修改任何源码、依赖、锁文件或迁移；
- 读取真实 token、context token 或会话文件内容；
- 启动 OpenClaw daemon；
- 登录、扫码、调用 getUpdates、接收或发送消息；
- 访问业务数据库、outbox 或 DeepSeek；
- 创建实现分支、提交、推送、PR、部署。
