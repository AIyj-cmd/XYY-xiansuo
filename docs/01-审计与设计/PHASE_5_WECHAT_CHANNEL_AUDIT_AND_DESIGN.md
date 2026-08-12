# 阶段五：普通微信消息渠道审计与技术设计

> **2026-08-01 最新用户授权（优先于本文其余历史结论）：** 用户已明确接受
> OpenClaw daemon 长轮询、专用账号人工扫码、会话维护、`context_token` 有效期
> 不确定及实验性渠道风险，并批准以现有隔离 Gateway 实现**单账号、单 pilot 用户、
> 单固定接收人**的内部文本通知。Direct iLink、Hook、RPA、逆向协议、客户自动回复、
> 多接收人和多渠道 fallback 仍未获批准。本文下方“全部真实渠道暂停”、OpenClaw
> daemon No-Go、迁移 `007` 暂缓等表述均作为当时决策与风险审计历史保留，不再是
> 当前 OpenClaw 内部通知实现的执行门禁。

> 状态：**2026-08-01 用户决定覆盖：所有真实外部消息渠道暂停；企业微信自建应用已取消，不属于后续候选。**
> 审计日期：2026-07-31
> 审计基线：`validation/phase4-provider-latency-live-pilot` /
> `2c8a603085263b939636a78c397daab28d85e85b`
> 本文只定义设计边界，不批准渠道实现、账号登录、消息发送或数据库迁移。

> **现行决策（优先于本文其余历史正文）：** OpenClaw daemon 和 Direct iLink 均为
> No-Go；企业微信自建应用由用户明确取消；公众号/服务号及其他真实外部渠道也
> 全部暂停。Hook、RPA、逆向协议和 Windows 自动化继续禁止。现行正式通知仅为
> H5 站内通知，Mock 仅用于测试和灰度验证。阶段三 outbox 及通知规则、租约、
> 重试、TTL、审计保留；阶段四 DeepSeek 调度、`scheduled_follow_overdue`、
> `daily_report`、AI 审计和模板降级保留，但只写通知基础设施→站内展示→Mock
> 验证，不向真实外部渠道发送。迁移 `007`、`notification_deliveries` 与
> `notification_channel_bindings` 全部暂缓，不进入实现，也不补发历史通知。
>
> 除本节明确的现行口径外，本文中的企业微信架构、Secret、绑定、迁移、测试、
> 实施顺序和多渠道/fallback 描述均为**已取消历史方案或未来多渠道参考**，不是
> 当前计划。未来仅在官方普通微信提供独立 client/session 且支持主动通知，或用户
> 批准公众号/服务号/其他合法官方渠道后，才可重新审计并重新取得实施批准。

> 2026-08-01 后续路线审计已由用户确认：OpenClaw daemon 路线因无法证明零自动
> 发送与零自动回复，结论为 **No-Go**；Direct iLink 官方协议路线因 npm 根没有
> 稳定独立 client/session 导出、CLI 登录凭据无法通过公开契约移交给 Direct
> 客户端，结论同为 **No-Go**。阶段五A已关闭，不批准 Direct 实现、登录、轮询、
> 握手、PoC、真实 outbox、生产或 fallback。
> 详见 `PHASE_5A_DIRECT_ILINK_GATEWAY_AUDIT_AND_DESIGN.md`。

## 1. 执行摘要

阶段五的目标不是让微信机器人理解业务，而是为现有通知系统增加一个可替换、
可审计、最小权限的投递出口：

```text
线索业务 / AI Scheduler
→ notification outbox
→ notification-worker
→ 渠道投递记录
→ WeChat Channel Adapter
→ 独立 Gateway 或官方 API
→ 内部员工
```

明确结论：

1. **个人普通微信自动化目前不批准作为正式生产渠道。**
   Hook、RPA、逆向协议存在封号、掉线、版本兼容和平台规则风险；即使 PoC
   成功，也不能证明长期生产可用。
2. **腾讯官方 `openclaw-weixin` / iLink 当前不进入实现。**OpenClaw daemon
   与 Direct iLink 均为 No-Go；任何登录、轮询、固定握手、延迟发送验证、3 至
   7 天 PoC、30 天观察、真实 outbox、生产或 fallback 均不批准。只有官方公开
   稳定 client/session、凭据交接与主动通知契约解锁后，才可重新审计。
3. **企业微信自建应用已由用户明确取消，不属于后续候选。** 其官方 API、成员
   身份和部署特点仅保留为历史设计资料。
4. 公众号/服务号及其他真实外部渠道均暂停；不得据此创建账号、核验资格、接入
   API 或安排 PoC。
5. 迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 全部
   暂缓，`001` 至 `006` 保持不变；不迁移、不补发历史通知。
6. 当前不运行或新建任何真实渠道 Gateway。阶段三通知基础设施、H5 站内展示和
   Mock 验证继续保留。
7. 阶段四 DeepSeek 调度和审计继续保留，但结果只进入通知基础设施→站内展示→
   Mock 验证，禁止真实外部发送。

冻结后的渠道方向：

现行通知方向：H5 站内通知为唯一正式通知方式；Mock 仅用于测试/灰度验证；所有
真实外部渠道暂停。OpenClaw daemon 与 Direct iLink 均 No-Go；企业微信已取消；
Hook、桌面 RPA、WeChatFerry、wxauto、Gewechat、旧版 Wechaty 普通微信 Puppet
和未经授权的逆向协议继续禁止。

不设真实渠道的主、备用或 fallback，也不进行企业微信主体、自建应用或员工
UserID 外部门禁核验。下一步仅为维持通知规则/outbox/租约/重试/TTL/审计、H5
展示、Mock 验证，以及保留 DeepSeek 调度、AI 审计和模板降级。满足本页顶部列明
的未来重新审计条件前，不创建迁移 `007`，不写企业微信代码，不改造真实渠道
Worker。

### 1.1 路线决策记录

| 路线 | 已确认决定 | 当前允许动作 |
|---|---|---|
| OpenClaw daemon | No-Go | 无；保留历史审计证据 |
| Direct iLink | No-Go，阶段五A关闭 | 无；待官方公开稳定 client/session、凭据交接和主动通知契约后重新审计 |
| 企业微信自建应用 | 用户明确取消 | 不属于后续候选；正文仅作已取消历史方案/未来多渠道参考 |

历史事实保留：离线 Gateway 曾实现且测试通过；已安装 OpenClaw 与插件，专用账号
完成扫码并在本地持久化凭据；消息发送数为 0，daemon 未启动，Direct 只读审计已
完成，最终为双 No-Go。这些事实不构成当前运行、登录或发送授权。

## 2. 基线与当前代码审计

### 2.1 基线门禁

审计开始时核对：

```text
branch = validation/phase4-provider-latency-live-pilot
HEAD   = 2c8a603085263b939636a78c397daab28d85e85b
worktree = clean
git diff --check = pass
```

本轮没有切换分支，没有操作数据库，没有登录微信，没有调用真实渠道。

### 2.2 已审计代码

| 位置 | 当前行为 | 阶段五影响 |
|---|---|---|
| `server/src/notification-worker.ts` | 直接构造 `MockNotificationChannel`，领取统一队列并发送 | 维持现有 Mock 验证；不接入真实渠道 |
| `server/src/services/mock-notification-channel.ts` | 单 Mock 渠道，确定性 receipt | 继续保留，作为回归、演练和回滚渠道 |
| `server/src/services/notification.ts` | `notification_logs` 内完成租约、重试、TTL 和发送终态 | 保留现有 outbox、规则、租约、重试、TTL 和审计；不拆分 delivery 模型 |
| `server/src/notifications/snapshot.ts` | 严格解析事件快照并转换 `NotificationMessage` | 继续用于站内通知与 Mock 验证 |
| `server/src/notifications/notification-event-service.ts` | 业务事件写入 outbox | 不允许依赖微信、绑定或 Gateway |
| `server/src/routes/notification-admin.ts` | 管理规则、日志和失败重试 | 后续增加只读渠道与 delivery API；实时 `requireAdmin` 保持 |
| `server/src/db.ts` | 迁移 `004` 创建通知表，`005/006` 创建并扩展 AI 日志 | `001–006` 冻结；迁移 `007` 及其 delivery/binding 表暂缓 |
| `server/src/ai-scheduler.ts` 及 Scheduler jobs | 生成已验证内容，再进入通知事件服务 | 不得读取微信凭证或调用 Gateway |

当前 `NotificationMessage` 为：

```ts
type NotificationMessage = {
  title: string
  body?: string
  detailPath: string
}
```

当前 `notification_logs` 同时保存：

- 业务事件和规则快照；
- 消息快照；
- 单渠道名称；
- 渠道幂等键；
- Worker 租约和重试；
- `provider_message_id` 和发送终态。

这正是阶段三“单 Mock 渠道”批准的简化模型。现行计划保留该模型：它服务于
通知规则、租约、重试、TTL、审计、H5 站内展示和 Mock 验证。真实渠道和多渠道
fallback 均暂停；相关投递明细模型仅保留为本文后续的历史参考，不构成实施工作。

### 2.3 不得直接插入微信逻辑的位置

以下位置不得直接调用微信客户端、官方 API 或 Gateway：

- 负责人变更事务；
- `notification-event-service`；
- AI Scheduler 和 Provider；
- Fastify 普通业务路由；
- SQLite 迁移；
- H5 页面。

渠道失败不能回滚负责人变化、跟进业务或 AI 生成结果，也不能触发 DeepSeek
重新生成。

## 3. 调研来源与证据边界

调研日期为 2026-07-31。优先使用官方文档和项目官方仓库：

- [腾讯官方 openclaw-weixin 仓库](https://github.com/Tencent/openclaw-weixin)
- [微信服务号客服消息介绍](https://developers.weixin.qq.com/doc/service/guide/product/kf/intro.html)
- [微信模板消息运营规范](https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Operation_Specifications.html)
- [微信一次性订阅消息](https://developers.weixin.qq.com/doc/service/guide/product/message/One-time_subscription_info.html)
- [企业微信发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)
- [Wechaty 官方仓库](https://github.com/wechaty/wechaty)
- [WeChatFerry 官方仓库](https://github.com/lich0821/WeChatFerry)
- [ItChat 仓库](https://github.com/littlecodersh/ItChat)
- [openwechat 仓库](https://github.com/eatmoreapple/openwechat)

外部能力、价格、账号资格、消息配额和平台规则具有时效性。实现和 PoC 当天
必须重新核验官方文档；本文不把第三方博客或逆向分析当作官方承诺。

## 4. 已取消历史方案与未来多渠道参考

### 4.1 微信公众号或服务号

性质：官方能力，消息最终显示在普通微信内，但属于公众号会话，不是个人微信号
给好友发消息。

适用条件：

- 员工关注指定账号；
- 系统通过授权或受控绑定取得稳定 OpenID；
- 账号主体和接口权限满足当前官方要求；
- 消息类型、发送窗口、频率和模板符合当前规则。

客服消息依赖用户近期主动交互窗口；当前官方说明包括用户发消息后的 48 小时
窗口，以及关注、扫码和菜单等场景更短的次数/时间限制。模板消息要求与用户已
接受的服务和具体行为相关，一次性订阅也需要逐次授权。具体次数、资格和行业
模板可能变化，实施日必须以目标账号控制台和官方规则复核。因此不能假设它支持
任意时刻、任意文本的员工定时提醒。

结论：**当前暂停，非现行候选。** 仅在用户批准该合法官方渠道后重新审计。

### 4.2 企业微信自建应用消息

性质：官方能力。企业内部应用可使用稳定企业成员 ID 定向发送，凭证、成员和
权限模型清晰，适合内部员工通知。

代价：

- 员工需要加入并使用企业微信；
- 接收体验不等于个人微信好友消息；
- 需要企业主体、应用、Secret 管理和成员绑定。

结论：**用户明确取消，不属于后续候选。** 以下描述只保留为已取消历史方案或
未来多渠道参考；不得创建应用、核验主体/成员、接入 API、管理 Secret 或安排测试。

企业微信群 Webhook 的以下描述仅保留为历史方案/未来多渠道参考；现行同样暂停，
不作为员工个人定向通知或应急补充候选。

### 4.3 腾讯官方 iLink / ClawBot

腾讯官方 `openclaw-weixin` 仓库提供 HTTP/JSON 机器人接入协议和二维码登录
流程。审计日其 `2.0.x` 分支标记为 Active，插件使用 MIT 许可证，说明当前
存在官方普通微信机器人方向。其发送请求需要：

```text
to_user_id
context_token
```

`context_token` 来自消息上下文。这带来尚未解决的核心问题：阶段三、四的通知
是后端定时主动产生，并不保证接收人刚刚给机器人发过消息。下列原 PoC 核验项
现已废止，仅在官方公开稳定 client/session、凭据交接和主动通知契约解锁后的
重新审计中作为参考：

- `context_token` 的来源、有效期和持久化规则；
- 是否允许合规的定时主动通知；
- 接收人稳定 ID 如何取得；
- 账号/机器人资格、限额和商业使用条件；
- 是否有可查询的投递回执；
- 会话重启、二维码和二次验证行为。

公开项目问题中也存在 token 陈旧、重新登录和“接口接受但个人微信未实际收到”
的报告。这些问题不是官方服务级承诺，且当前不批准任何 PoC：

- [主动推送接受但未送达问题](https://github.com/openclaw/openclaw/issues/68805)
- [context token 过期问题](https://github.com/openclaw/openclaw/issues/61174)

原冻结结论是：**作为普通微信目标渠道的首选隔离 PoC 候选，但在主动发送语义
获得官方证据并经受控验证前，不批准生产。**2026-08-01 的后续审计进一步确认：
OpenClaw daemon 路线因无法关闭全部自动出站而 No-Go；Direct 路线因缺少公开、
稳定的独立 client/session 与登录凭据移交契约，当前也 No-Go。iLink 仍可保留
为未来研究候选，但在官方接口解锁并重新审计前，不得进入 Direct 代码实现或
实况 PoC。

### 4.4 Wechaty

Wechaty 是机器人抽象框架，其实际微信能力由 Puppet 后端决定。框架本身不能
把非官方 Puppet 变成官方能力，也不能消除账号风险、登录失效或主动消息限制。

结论：**只有在单独批准、官方或有明确商业授权的 Puppet 存在时再评估；当前
不作为生产选型。**

### 4.5 WeChatFerry、Hook、逆向协议

WeChatFerry 依赖 Windows 微信客户端 Hook，且其仓库已归档为只读。类似方案
普遍依赖特定客户端版本，存在封号、协议变化、掉线和安全软件冲突风险。

结论：**不推荐，不进入 PoC。**

### 4.6 桌面 RPA / UI 自动化

RPA 依赖桌面会话、窗口焦点、分辨率、客户端版本和人工登录，难以获得稳定
message ID，也不能可靠解决“发送成功但响应丢失”。它通常要求 Windows 节点。

结论：**不推荐用于长期生产，也不设计绕过检测、隐藏自动化或模拟真人行为。**

### 4.7 ItChat / openwechat

两者均为非官方个人微信 Web 协议客户端。ItChat 的正式 release 长期停留在
2017 年；openwechat 审计时可见的最近 release 为 2024-12。Web 微信登录资格
不是所有账号都具备，也没有正式投递回执或生产支持承诺。

结论：**不推荐，不进入 PoC。**开源许可证不等于微信平台授权。

### 4.8 冻结排除清单

以下方案不进入阶段五正式实现或 PoC，除非未来重新审计并获得用户单独批准：

- WeChatFerry、wxauto、Gewechat；
- 旧版 Wechaty 普通微信 Puppet；
- DLL Hook、客户端注入和逆向协议；
- Windows UI 自动化和模拟点击 RPA；
- 绕过微信风控或隐藏自动化行为；
- 使用领导或员工日常主微信号。

V1 不建设 Windows 渠道节点，也不得用这些方案绕过 iLink 的会话或
`context_token` 限制。

## 5. 已取消历史方案选型矩阵（非当前计划）

### 5.1 能力与维护

| 方案 | 类型 | 官方性 | 当前维护 | 平台 | Ubuntu | Windows节点 | 登录/身份 | 主动发送 | 回执/幂等 |
|---|---|---|---|---|---|---|---|---|---|
| 企业微信自建应用 | 官方 API | 官方 | 官方维护 | 服务端 HTTP | 是 | 否 | 企业应用凭证 + 成员 ID | 支持应用消息，受官方规则约束 | 有官方响应；本地仍需幂等 |
| 公众号/服务号 | 官方 API | 官方 | 官方维护 | 服务端 HTTP | 是 | 否 | Access Token + OpenID | 受消息类型、窗口、资格和频率限制 | 有 API 响应；本地仍需幂等 |
| Tencent iLink/ClawBot | 官方机器人协议 | 腾讯官方仓库 | 新能力，需持续核验 | HTTP Gateway | 预计是 | 未证明需要 | 二维码/机器人 token；接收人和上下文 token | 当前 No-Go，不批准验证 | 不进入当前方案 |
| Wechaty | 抽象框架 | 框架官方，Puppet 不一定官方 | 框架仍可用，后端各异 | Node/取决于 Puppet | 取决于 Puppet | 取决于 Puppet | 取决于 Puppet | 取决于 Puppet | 需自行实现 |
| WeChatFerry | Windows Hook | 非官方 | 已归档 | Windows | 否 | 是 | PC 微信登录 | 可自动化，但高风险 | 无可靠官方回执 |
| 桌面 RPA | UI 自动化 | 非官方 | 自维护 | Windows 桌面 | 否 | 是 | 人工登录/设备确认 | 技术上可点击发送 | 结果通常不确定 |
| ItChat / openwechat | Web协议 | 非官方 | ItChat长期无正式release；openwechat仍有历史维护 | Linux/各异 | 技术上是 | 否 | Web微信二维码/热登录 | 受账号登录资格限制 | 无正式回执 |
| 逆向 iLink/非官方网关 | 逆向协议 | 非官方 | 不稳定 | 各异 | 可能 | 不一定 | 二维码/第三方会话 | 未获官方保证 | 取决于第三方 |

### 5.2 风险、成本与结论

| 方案 | 账号/规则风险 | 凭证风险 | 部署运维 | 成本/许可证 | 生产可用性 | PoC | 推荐 |
|---|---|---|---|---|---|---|---|
| 企业微信自建应用 | 低，仍受官方规则约束 | Secret 需隔离和轮换 | 低至中 | 官方政策为准 | 高 | 高 | **用户明确取消；仅历史参考** |
| 公众号/服务号 | 中，受账号资格和主动发送规则约束 | Token/OpenID 需保护 | 中 | 官方政策为准 | 条件性 | 中 | **历史候选；当前暂停** |
| Tencent iLink/ClawBot | 未知到中；独立 client/session、凭据交接和主动通知契约未证实 | bot token/会话需 Gateway 隔离 | 中 | 插件 MIT；服务条款和费用仍需核验 | No-Go | 不批准 | **路线关闭；仅供未来重新审计参考** |
| Wechaty | 由 Puppet 决定，可能高 | Puppet/第三方云凭证 | 中至高 | 框架 Apache-2.0；Puppet 另计 | 不确定 | 条件性 | **暂不推荐** |
| WeChatFerry | 高 | PC 会话和 Hook 风险高 | 高 | MIT；许可证不消除平台风险 | 低 | 低 | **不推荐** |
| 桌面 RPA | 高 | 日常账号和桌面会话风险高 | 很高 | 商业 RPA 成本不定 | 低 | 低 | **不推荐** |
| ItChat / openwechat | 高 | Web会话状态和热登录文件风险 | 高 | MIT / Apache-2.0；不代表平台授权 | 低 | 低 | **不推荐** |
| 逆向/第三方网关 | 高 | 会话可能托管给第三方 | 高 | 条款不确定 | 低 | 低 | **不推荐** |

GitHub 星数、能否“跑通一次”或开源许可证均不能替代平台授权和生产稳定性。

### 5.3 运维与限制

| 方案 | 接收人映射 | 消息类型与限制 | 掉线检测/重连 | 二次验证 | 会话或凭证 | 运维结论 |
|---|---|---|---|---|---|---|
| 企业微信自建应用 | 企业成员 `userid`，需应用可见且启用 | 官方应用消息；文本当前文档上限为 2048 字节，最终以实施日规则为准 | HTTP健康、token刷新；无需桌面会话 | 企业管理员和成员体系处理 | 企业应用凭证，仅放渠道 Adapter/Gateway | 历史可运维评估；用户已取消 |
| 公众号/服务号 | OpenID + 关注/授权 | 客服、模板或订阅消息；受窗口、资格、次数和内容规范限制 | 官方API健康；Access Token受控刷新 | 用户关注/授权 | Access Token，不保存用户微信密码 | 历史条件性评估；当前暂停 |
| Tencent iLink/ClawBot | `to_user_id` + 会话 `context_token` | 当前 No-Go，不批准使用 | 不运行、不重连 | 不登录 | 不读取或新增会话状态 | 路线关闭 |
| Wechaty | 取决于Puppet，禁止姓名猜测 | 取决于Puppet和商业服务 | 取决于Puppet | 取决于Puppet | 可能由第三方托管 | 不确定，不选 |
| WeChatFerry | PC联系人内部ID | 客户端自动化，限制不稳定 | 客户端版本强耦合，需自建检测 | 人工登录；不得绕过 | Windows微信会话和Hook | 不可接受 |
| 桌面RPA | 窗口/联系人搜索，误发风险高 | 只能模拟UI，可用性不稳定 | 桌面会话、窗口焦点和升级均会中断 | 人工处理 | 日常账号桌面会话 | 不可接受 |
| ItChat / openwechat | Web协议内部ID | 登录资格和协议能力不稳定 | 热登录不等于可靠重连 | 二维码和账号限制由微信决定 | Web会话文件 | 不可接受 |
| 逆向/第三方网关 | 第三方ID | 无官方保证 | 供应方决定 | 供应方决定 | 可能向第三方交付会话 | 不可接受 |

维护证据快照：

| 项目 | 审计日可复核证据 | Issue/维护判断 |
|---|---|---|
| Tencent openclaw-weixin | `2.0.x` 标记 Active，33 commits，MIT | 87 issues / 30 PR；能力活跃但仍新，需跟踪主动发送问题 |
| Wechaty | Apache-2.0，框架仓库仍提供 release/changelog | Puppet 生命周期和商业依赖各异，框架活跃不代表个人微信协议可生产 |
| WeChatFerry | 最近版本线约为 `v39.5.2`；2026-07-10 仓库归档 | 已只读，不再满足长期维护门禁 |
| ItChat | MIT；正式 release 长期停留在 2017 | 283 issues；不视为当前生产维护 |
| openwechat | Apache-2.0；审计时可见最近 release 为 2024-12 | 136 issues；仍是非官方 Web 协议 |

上表是 2026-07-31 的快照，不是未来可用性承诺；实施日必须重新查询 release、
commit、issue、许可证和服务条款。

## 6. 已取消历史架构（未来多渠道参考）

### 6.1 首选结构

阶段五A已关闭，当前不运行或新建 iLink Gateway。下列企业微信独立 Gateway
结构只作为已取消历史方案/未来多渠道参考；不进行企业微信外部门禁核验，也不以
该门禁作为恢复条件：

```text
notification-worker
→ xiansuo-channel-gateway
→ 官方渠道 Adapter
→ 官方 HTTPS API
```

所有真实渠道凭证只进入独立 Gateway/专用 channel 进程。notification-worker
只持有调用 Gateway 的最小认证密钥，不能读取企业微信 Secret 或公众号 Token。

### 6.2 Ubuntu 与 Windows

- 方案 A（全 Ubuntu）：企业微信和公众号等官方 HTTP API 的历史部署候选。
- 方案 B（Ubuntu + Windows）：只有 Hook/RPA/PC 客户端方案才需要；由于这些
  方案不推荐，**当前不建设 Windows 节点**。
- 方案 C（官方 API）：历史评估中企业微信和符合资格的公众号更适合正式生产；
  当前企业微信已取消，公众号/服务号也暂停。

如果未来经重新批准使用 Windows 客户端，Windows 节点也必须是独立渠道安全
域，不得安装在业务服务器，不得直接访问 SQLite。

### 6.3 Gateway 最小契约

输入：

```ts
type ChannelDeliveryRequest = {
  deliveryId: string
  idempotencyKey: string
  recipientExternalId: string
  message: {
    title: string
    body?: string
    detailUrl?: string
  }
}
```

输出：

```ts
type ChannelDeliveryResult = {
  providerMessageId?: string
  status:
    | 'sent'
    | 'deduplicated'
    | 'retryable_failure'
    | 'permanent_failure'
    | 'result_unknown'
  errorCode?: string
  latencyMs?: number
}
```

Gateway 禁止接收 SQL、lead/follow-up 对象、Prompt、JWT、管理员密码、DeepSeek
Key 或完整业务快照；禁止直接访问业务数据库；禁止主动扫描通知表。

## 7. 迁移 `007` 与投递数据模型（已取消历史方案，非当前任务）

### 7.1 结论

迁移 `007`、`notification_deliveries` 与 `notification_channel_bindings` 已全部
暂缓，不进入实现；本章仅保留过去的设计推演。未来是否重新评估，不以企业微信
门禁为条件，而仅以本页顶部列明的官方普通微信能力或用户批准合法官方渠道为前提。

迁移 `001–006` 不修改、不重算 checksum。历史 Mock 投递不做破坏性回填；
既有 `notification_logs` 保留其历史事实。迁移后仅新通知采用 delivery 模型。

### 7.2 `notification_logs` 的新职责

`notification_logs` 继续表示：

- 一个业务通知事件；
- 规则和消息快照；
- 业务幂等；
- 接收系统用户；
- 业务 TTL、取消和抑制；
- 总体投递结论。

它不再覆盖不同渠道的 receipt、租约和重试。兼容字段只用于历史记录或迁移期
桥接，不删除。

迁移 `007` 还需为父通知追加最小兼容标记：

```text
delivery_model_version      INTEGER NOT NULL DEFAULT 1
delivery_summary_status     TEXT NULL
delivery_summary_updated_at TEXT NULL
```

- 历史行保持 `delivery_model_version=1`，继续由 legacy Mock 路径解释；
- 新行写 `delivery_model_version=2`，父行本身绝不被 Worker 领取；
- `delivery_model_version IN (1,2)`；
- `delivery_summary_status` 允许
  `blocked/pending/sending/retry_wait/sent/failed/cancelled/result_unknown`；
- v2 的渠道事实源始终是子 delivery，父摘要只能由同一数据库事务内的聚合服务
  更新，不能由 Gateway 直接修改。

父子聚合规则：

| 子 delivery 状态 | 父摘要 |
|---|---|
| 任一可信 `sent` | `sent`；取消尚未开始的其他delivery |
| 无sent、任一 `result_unknown` | `result_unknown`；冻结自动重试和fallback |
| 任一 `sending` | `sending` |
| 任一 `retry_wait` 且无sending | `retry_wait` |
| 任一 `pending` 且无上述状态 | `pending` |
| 全部因缺少有效绑定而 `blocked` | `blocked`，等待人工修复绑定；不会自动领取 |
| 全部明确failed且无可创建fallback | `failed` |
| 全部cancelled | `cancelled` |

为兼容现有管理 API，父 `notification_logs.status` 同步映射：

- `sent/failed/cancelled` 映射到同名终态；
- `blocked` 映射父 `status='failed'` 并保存
  `WECHAT_RECIPIENT_NOT_BOUND` 等安全错误码；
- 活跃子状态和 `result_unknown` 保持父 `status='pending'`，但
  `delivery_summary_status` 提供准确状态；
- v2 claim SQL 必须排除父行，所以 `pending` 不会被旧逻辑当作可发送任务；
- 父 `provider_message_id` 只在可信成功时复制被选中子 delivery 的
  provider message ID；不得用 delivery ID 或本地受理号伪造。

所有父摘要、成功子项、其他子项取消和审计更新必须在一个短事务完成。并发成功
通过父行 `row_version` 和子行 lease token 串行化；只有第一个可信成功获胜。

### 7.2.1 新旧 Worker 切换门禁

不得让 legacy Worker 与 v2 delivery Worker 同时运行：

1. 执行迁移 `007`，真实渠道和 v2 创建开关仍关闭；
2. 部署能够识别 `delivery_model_version` 的兼容版本；
3. 保持旧路径只领取 `delivery_model_version=1`；
4. 排空旧 `pending/retry_wait` Mock；不能排空的明确冻结并形成清单；
5. 停止 legacy Worker，核对 PM2 只有一个通知 Worker 实例；
6. 两次只读队列预检确认没有 legacy 可领取任务；
7. 启用 v2 创建后，新 Worker只领取 `notification_deliveries`；
8. 禁止回滚到不认识 `delivery_model_version=2` 的旧 Worker；
9. 回滚时关闭 v2 创建和 delivery 领取，保留全部父子记录，不把 v2 行转换成
   legacy 行。

`NOTIFICATION_DELIVERY_V2_ENABLED=false` 必须是严格解析、默认关闭的独立开关。
迁移 `007` 不扫描历史通知，不为历史行创建 delivery。

### 7.3 `notification_deliveries`

建议字段：

```text
id                          INTEGER PRIMARY KEY
notification_log_id         INTEGER NOT NULL FK notification_logs
channel                     TEXT NOT NULL
binding_id                  INTEGER NULL FK notification_channel_bindings
binding_version_snapshot    INTEGER NULL
delivery_generation         INTEGER NOT NULL DEFAULT 1
idempotency_key             TEXT NOT NULL UNIQUE
message_snapshot_hash       TEXT NOT NULL
recipient_external_id_hash  TEXT NULL
status                      TEXT NOT NULL
attempt_count               INTEGER NOT NULL DEFAULT 0
automatic_attempt_count     INTEGER NOT NULL DEFAULT 0
manual_retry_count          INTEGER NOT NULL DEFAULT 0
max_attempts                INTEGER NOT NULL
available_at                TEXT NOT NULL
expires_at                  TEXT NOT NULL
lease_token                 TEXT NULL
lease_owner                 TEXT NULL
lease_until                 TEXT NULL
provider_message_id         TEXT NULL
local_receipt_id            TEXT NULL
success_evidence            TEXT NULL
fallback_from_delivery_id   INTEGER NULL FK notification_deliveries
fallback_reason             TEXT NULL
failure_class               TEXT NULL
last_error_code             TEXT NULL
last_error_message          TEXT NULL
result_unknown_at           TEXT NULL
cancel_requested_at         TEXT NULL
cancellation_reason         TEXT NULL
sent_at                     TEXT NULL
cancelled_at                TEXT NULL
retain_until                TEXT NULL
latency_ms                  INTEGER NULL
attempt_audit_json          TEXT NOT NULL DEFAULT '[]'
row_version                 INTEGER NOT NULL DEFAULT 1
created_at                  TEXT NOT NULL
updated_at                  TEXT NOT NULL
```

状态：

```text
blocked
pending
sending
retry_wait
sent
failed
cancelled
result_unknown
```

关键约束：

- `channel IN ('mock','wechat_ilink','wecom_app')`；
- `idempotency_key` 全局唯一；
- 所有计数和 `latency_ms` 为非负整数；
- JSON 必须合法且为数组；
- `sending` 必须有完整租约；
- 可领取的真实渠道必须有非空 `binding_id` 和 `binding_version_snapshot`；
  只有 `mock` 或不可领取的 `blocked` 诊断行可以不绑定；
- 可领取的真实渠道必须有非空 `recipient_external_id_hash`；Mock 和无绑定的
  blocked 诊断行允许为 NULL；
- 发送前必须校验 binding 仍为 active、`row_version` 等于快照版本且外部 ID
  hash 一致；不一致转 `cancelled/binding_stale`；
- `sent` 必须有 `sent_at` 和 Adapter 认可的可信成功证据；
- `result_unknown` 必须有时间和安全错误码；
- `binding_id` 删除时不抹除历史，优先 `RESTRICT`；绑定停用而非物理删除。

`success_evidence` 固定枚举：

```text
provider_message_id
provider_accepted
mock_receipt
gateway_deduplicated
```

不同 Adapter 使用严格成功策略：

- 企业微信官方成功响应可记为 `provider_accepted`，表示平台受理，不表示员工已读；
- Mock 的确定性 receipt 可记为 `mock_receipt`；
- iLink 的 Gateway 本地 receipt 只证明本地受理或去重，**不能单独把任务标为
  sent**；没有经过 PoC 证明的可信 provider 成功证据时必须进入
  `result_unknown`；
- `gateway_deduplicated` 只有在 Gateway 已持久化原先的可信 provider 成功结果
  时才等价于 sent。

数据库使用条件 CHECK：

```text
channel = 'mock'
OR status = 'blocked'
OR (
  binding_id IS NOT NULL
  AND binding_version_snapshot IS NOT NULL
  AND recipient_external_id_hash IS NOT NULL
)
```

`blocked` 必须有安全错误码且没有租约；绑定修复后不原地替换接收人，而是在人工
确认下取消 blocked 行并创建新 generation，保留原审计。

### 7.3.1 规则关闭与在途 delivery

`PUT notification-rules/:eventType` 关闭规则时，必须在同一短事务中：

1. 更新规则版本和 `enabled=0`；
2. 继续取消 legacy 父表中未发送的 `pending/retry_wait`；
3. 将 v2 子表中 `blocked/pending/retry_wait` 转为
   `cancelled/rule_disabled`；
4. 对 `sending` 设置 `cancel_requested_at` 和
   `cancellation_reason=rule_disabled`，但不伪造“已撤回”；
5. 保留 `sent/result_unknown` 原始事实，不删除、不改写；
6. 重新聚合受影响父通知的 `delivery_summary_status`。

Worker 在调用 Gateway 前必须以 lease token 再次读取规则版本和
`cancel_requested_at`。发现关闭或取消请求且尚未发出外部调用时，转 cancelled。
若外部请求已经发出：

- 可信成功仍记 sent；
- 结果未知仍记 result_unknown；
- 明确失败后按 rule_disabled 记 cancelled，不创建 fallback。

规则关闭不能撤回已经发送的消息，也不能把不确定结果伪造成取消。关闭事务提交
后禁止创建新的该规则 delivery；事件捕获端必须读取同一事务内的最新规则状态。

唯一索引拆分，避免 SQLite 的 NULL 可重复语义：

- 真实渠道：
  `UNIQUE(notification_log_id,channel,binding_id,delivery_generation)`
  `WHERE binding_id IS NOT NULL`；
- Mock：
  `UNIQUE(notification_log_id,channel,delivery_generation)`
  `WHERE channel='mock' AND binding_id IS NULL`。

索引：

- `(status, available_at)`；
- `(status, lease_until)`；
- `(notification_log_id, created_at)`；
- `(channel, status, available_at)`；
- `(binding_id, created_at)`；
- `(retain_until)` 终态部分索引；
- `(provider_message_id)` 非空部分索引。

阶段五 V1 不再增加第四张“每次尝试”表。每次尝试只在
`attempt_audit_json` 保存脱敏元数据（时间、耗时、错误码、结果类别），不保存
请求正文、账号凭证或上游原始错误。若未来监管要求逐次不可变审计，再单独设计
迁移。

`attempt_audit_json` 最多 16 KiB，条目数不得超过
`max_attempts + manual_retry_count`。追加前先校验严格 Schema 和字节数；超限
时停止新增自动尝试并转安全失败，不能静默截断既有审计，也不能让 JSON 无限
增长导致状态事务失败。

### 7.4 `notification_channel_bindings`

建议字段：

```text
id                          INTEGER PRIMARY KEY
user_id                     INTEGER NOT NULL FK users
channel                     TEXT NOT NULL
recipient_external_id       TEXT NOT NULL
recipient_external_id_hash  TEXT NOT NULL
recipient_display_name      TEXT NULL
status                      TEXT NOT NULL
verified_at                 TEXT NULL
verification_method         TEXT NULL
last_verified_at            TEXT NULL
created_by                  INTEGER NOT NULL FK users
disabled_by                 INTEGER NULL FK users
disabled_at                 TEXT NULL
row_version                 INTEGER NOT NULL DEFAULT 1
created_at                  TEXT NOT NULL
updated_at                  TEXT NOT NULL
```

绑定状态：

```text
pending_verification
active
invalid
disabled
```

约束：

- 每个 `user_id + channel` 最多一个 active 绑定；
- 每个 `channel + recipient_external_id_hash` 最多绑定一个 active 系统用户；
- 一个用户可以分别绑定普通微信、企业微信和其他已批准渠道；
- 不允许一个普通微信接收人同时绑定多个系统用户；
- 系统用户停用后，绑定不删除但不得创建或发送新 delivery；
- `recipient_external_id` 对 Gateway 渠道优先使用 Gateway 发放的无业务含义
  opaque handle，而不是姓名或可搜索的联系人文本；
- 不保存微信密码、Cookie、二维码、会话 token 或客户端数据库。

数据库约束冻结为：

- `channel IN ('wechat_ilink','wecom_app')`；
- `status IN ('pending_verification','active','invalid','disabled')`；
- `verification_method IN ('inbound_challenge','wecom_directory','admin_manual')`
  或 NULL；
- `active` 必须同时有 `verified_at` 和 `verification_method`；
- `disabled` 必须有 `disabled_at`；
- 外部 ID 长度为 1–256，hash 为 64 位小写十六进制；
- partial unique index：
  `UNIQUE(user_id,channel) WHERE status='active'`；
- partial unique index：
  `UNIQUE(channel,recipient_external_id_hash) WHERE status='active'`。

### 7.5 已取消的历史绑定方式

V1 不开发 H5 绑定管理页面，不按姓名、昵称、手机号或通讯录搜索自动匹配。

企业微信历史绑定设计（用户已取消，不执行）：

- 由管理员取得企业通讯录中的稳定成员 UserID；
- 通过企业微信官方能力人工核验成员存在、启用且位于应用可见范围；
- 使用受控 CLI 或后续批准的 admin-only API 绑定到系统用户；
- 所有绑定记录创建人、验证方式、版本和最近验证时间。

iLink 的原隔离 PoC 绑定方式（手工配置 `to_user_id`、读取会话上下文、隔离
Gateway）已随阶段五A关闭而废止；不得据此配置、读取或持久化 iLink 数据。只有
官方公开稳定 client/session、凭据交接和主动通知契约解锁并重新审计后，才可将
其作为重新设计正式 challenge/binding 流程的历史参考。

## 8. 渠道幂等与发送状态（已取消历史方案/未来多渠道参考）

### 8.1 幂等键

```text
SHA-256(
  notification_log_id
  + channel
  + binding_id
  + message_snapshot_hash
  + delivery_generation
)
```

同一业务通知在同一渠道、同一绑定、同一冻结快照上得到稳定键。人工确认后的
新一代投递才增加 `delivery_generation`，不能用随机 UUID 绕过重复保护。

### 8.2 Gateway 去重

Gateway 必须用本地持久化、加密且可恢复的去重存储保存：

- `idempotencyKey`；
- 安全请求 hash；
- 处理状态；
- provider message ID 或本地 receipt；
- 创建和过期时间。

Gateway 重启后重复请求必须返回原 receipt 或 `deduplicated`。内存 Map 不足以
支持生产。

### 8.3 发送结果未知

普通微信客户端自动化通常无法承诺 exactly-once。若“点击发送成功但响应丢失”
或官方接口结果无法确认：

```text
sending → result_unknown
```

`result_unknown`：

- 不自动重试；
- 不自动切企业微信；
- 不允许 Worker 创建新 generation；
- 需要人工核对渠道端和审计后决定；
- 保留原任务与快照。

这采用避免重复通知的 at-most-once 偏好。只有提供官方查询接口且查询确认未发送，
才可恢复重试。

### 8.4 多渠道与 fallback

- fallback 是独立 delivery，并通过 `fallback_from_delivery_id` 关联；
- 只有原渠道返回**明确失败**且规则允许时才创建；
- 任一 delivery 成功后，取消尚未开始的其他 delivery；
- 原渠道恢复后不得自动发送已 fallback 成功的旧任务；
- `result_unknown` 不创建 fallback；
- 历史 Mock 投递保持原样，不转换成微信 delivery。

## 9. 错误分类

| 错误码 | 类型 | 默认处理 | 自动fallback | 人工动作/重复风险 |
|---|---|---|---|---|
| `WECHAT_CHANNEL_DISABLED` | 永久配置 | 不领取/取消新投递 | 否 | 管理员启用后只处理新任务 |
| `WECHAT_GATEWAY_OFFLINE` | 临时 | 有限退避重试 | V1否 | 检查进程和网络 |
| `WECHAT_SESSION_EXPIRED` | 可恢复阻塞 | 暂停重试 | 默认否 | 人工重新登录 |
| `WECHAT_LOGIN_REQUIRED` | 可恢复阻塞 | 暂停 | 默认否 | 展示受控登录流程 |
| `WECHAT_ACCOUNT_RESTRICTED` | 永久/高风险 | 立即停止渠道 | V1否 | 禁止自动换号或绕过风控 |
| `WECHAT_RECIPIENT_NOT_BOUND` | 永久 | 失败 | V1否 | 完成绑定 |
| `WECHAT_RECIPIENT_NOT_FOUND` | 永久 | 失败并使绑定 invalid | V1否 | 重新验证接收人 |
| `WECHAT_MESSAGE_TOO_LONG` | 永久数据 | 发送前拒绝 | 否 | 修正快照策略，不截断后盲发 |
| `WECHAT_SEND_TIMEOUT` | 结果不确定 | `result_unknown` | 否 | 人工核对，可能重复 |
| `WECHAT_SEND_RESULT_UNKNOWN` | 结果不确定 | 隔离 | 否 | 人工核对 |
| `WECHAT_RATE_LIMITED` | 临时 | 按官方窗口退避 | 默认否 | 监控限额 |
| `WECHAT_CLIENT_VERSION_UNSUPPORTED` | 永久阻塞 | 停止渠道 | V1否 | 受控升级与兼容验证 |
| `WECHAT_PROVIDER_REJECTED` | 永久 | 失败 | V1否 | 查安全错误码，不存原文 |
| `WECHAT_DUPLICATE_SUPPRESSED` | 成功等价 | 标记 deduplicated/sent | 否 | 无 |
| `WECHAT_INTERNAL_ERROR` | 临时或未知 | 默认有限重试一次；无法分类则 unknown | 否 | 检查 Gateway |

同一渠道默认最多 3 次自动尝试，实际值由规则严格配置；登录、账号受限、
结果未知和接收人错误不消耗无限重试。

表中的 V1 不自动 fallback。未来多渠道只有在重新批准且能证明“明确未发送”时，
才可为相应错误配置独立 fallback delivery。

## 10. Gateway 通信安全

Gateway 默认不得暴露公共互联网。优先部署在同一私网、VPN 或专用网络段。

每个请求必须同时具备：

- 双向 TLS；
- 独立 Gateway HMAC secret 和 `key_id`；
- UTC 时间戳，允许偏差不超过 60 秒；
- 128 位以上随机 nonce；
- HTTP method、path、timestamp、nonce、body SHA-256 的规范化签名；
- Gateway 持久化 nonce 防重放；
- notification-worker IP allowlist；
- 最大请求 16 KiB；
- 连接和总请求超时；
- 单调用方频率限制；
- secret 双 key 轮换窗口；
- 仅记录 delivery ID、响应分类、耗时和脱敏错误码。

不得使用用户 JWT、管理员 JWT、DeepSeek Key、微信密码或会话 token 作为
Gateway 身份凭证。

未来正式生产 Gateway 只允许 notification-worker 调用；Fastify、H5、AI
Scheduler 和公网客户端没有网络权限。阶段五A iLink Gateway 已关闭，不存在
本地 PoC Runner、登录二维码或发送端点。若未来跨节点，优先 WireGuard/VPN +
mTLS；不得为了方便将任何凭据或发送端点公开到公网。

## 11. 会话与凭证隔离

下列普通微信 PoC 凭证约束为已废止历史/未来重新审计参考，当前不得登录、扫码、
读取或持久化 iLink 会话：

- 使用专用测试机器人账号，不使用领导或员工日常主账号；
- 二维码只在 Gateway 节点的受控本地控制台或运维会话展示；
- 设备确认和二次验证必须由授权人员人工完成；
- 会话文件由 Gateway 专用系统用户持有，权限 `0600`；
- 磁盘加密或受控 secret 存储，备份也加密；
- 会话过期、退出、账号受限立即将渠道健康状态降级并停止领取；
- 客户端/协议升级先在隔离环境验证；
- 退出或撤销时销毁会话，并保留不含凭证的审计事件。

普通微信会话、企业微信 Secret、公众号 Token 等真实渠道凭证均不得进入
Fastify、AI Scheduler、notification-worker、H5、SQLite 业务库、Git 或日志；
只进入对应 Gateway/专用 channel 进程。Gateway 不读取 DeepSeek Key，Worker
只持独立的 Gateway 调用凭证。

## 12. 消息隐私与 H5 链接

V1 只发送纯文本：

```text
标题
简短摘要
数量、业务日期或时间、简短行动提示
需登录的H5详情链接
```

建议限制：

- 标题最多 30 个中文字符；
- 标题、正文、链接和换行合计采用 UTF-8 字节预算；
- 通用 V1 发送预算不超过 1800 字节，为企业微信当前 2048 字节文本上限保留
  协议和格式余量；
- 同时保留正文最多 1000 个 Unicode 字符的防滥用上限，但以更先达到的渠道
  字节上限为准；中文内容通常会先命中字节预算；
- 最多 5 个条目；
- 超限在 Worker 的严格消息适配层按 UTF-8 完整字符边界和既定规则截断，并记录
  `content_truncated=true`；不得让 Gateway 自由总结。

默认不发送：

- 公司名称、联系人姓名或任何客户名称；
- 完整手机号、微信号；
- 需求内容、意向等级和完整状态备注；
- 完整客户备注和跟进正文；
- DeepSeek 原始输出；
- Prompt、AI 上下文或内部错误；
- JWT、Cookie、API Key；
- 管理员信息。

客户名称默认完全不发送，而不是“先脱敏再发送”。如未来确需显示脱敏客户名称，
必须新增独立规则、默认关闭并重新审批，不能沿用本阶段批准。

允许的到期提醒示例：

```text
【到期跟进提醒】

你今天有5条线索需要跟进。
请登录线索系统查看详情并安排处理。

https://xs.tomatopia.top/...
```

允许的负责人变化示例：

```text
【负责人变更提醒】

你有1条新分配的线索。
请登录线索系统查看详情。
```

H5 链接：

- 生产使用正式 H5 域名 `https://xs.tomatopia.top` 和现有站内路径；不同环境
  通过严格服务端配置替换，不允许消息数据提供主机名；
- URL 不携带 JWT、Cookie、手机号、微信号或密码；
- URL 不携带客户名称；
- 链接本身不是授权凭证；
- 打开后要求正常登录，并以数据库实时用户、角色和负责人关系重新授权；
- V1 不使用短期签名链接绕过登录；
- 允许的统计参数只能是无权限意义的 opaque 标识。

链接泄露者未登录或无权限时不能读取客户数据。

## 13. 渠道健康与管理接口

统一健康状态：

```text
healthy
degraded
offline
login_required
restricted
unsupported
```

监控：

- Gateway 和客户端进程；
- 最近心跳、最近成功发送时间；
- 登录和会话状态；
- 连续失败次数；
- 客户端/协议版本；
- 可领取队列数量和最老等待年龄；
- `result_unknown` 数量；
- 账号限制和限流状态；
- 按渠道的成功率、延迟和重试数。

后续可增加仅 admin、实时 `requireAdmin` 的只读 API：

```text
GET /api/admin/notification-channels
GET /api/admin/notification-deliveries
GET /api/admin/notification-deliveries/:id
```

响应不得包含 recipient external ID 原值、登录二维码、Cookie、token、会话文件
路径或完整错误。阶段五不开发前端管理页。

现有管理 API 的 v2 兼容契约：

- `GET /api/admin/notification-logs` 保留原 `status` 字段，并为 v2 追加
  `delivery_summary_status` 和 `effective_status`；`effective_status` 对 v2
  取摘要状态，对 legacy 取原 status；
- v2 状态筛选使用新增 `deliveryStatus`，不能把 `result_unknown` 隐藏成普通
  pending；
- `GET /api/admin/notification-logs/:id` 对 v2 返回脱敏 delivery 摘要，不返回
  外部 ID、消息全文或凭证；
- 现有 `POST /api/admin/notification-logs/:id/retry` 对
  `delivery_model_version=2` 返回 HTTP 409 /
  `DELIVERY_RETRY_REQUIRED`，不得直接改父表；
- 后续新增
  `POST /api/admin/notification-deliveries/:id/retry`，只允许对“明确未发送”的
  failed delivery 人工重试；要求规则启用、TTL有效、绑定版本仍匹配、渠道健康、
  `expected_version` 和原因；
- `sent/cancelled/result_unknown/blocked` 不允许用重试接口发送；blocked 在绑定
  修复后通过受控的新 generation 流程处理；
- 人工重试沿用原幂等键、增加 `manual_retry_count`，不能用随机键规避去重。

## 14. 已取消的历史降级策略

现行决定不设置真实渠道主、备用或 fallback；H5 站内通知继续使用，Mock 仅用于
测试/灰度。下列内容只保留为企业微信尚未取消时的历史方案：

```text
企业微信自建应用
→ 明确失败时保留站内通知并记录失败
```

iLink 当时不是正式渠道，也不是企业微信的自动 fallback；该历史方案也不存在从
iLink 自动切换到企业微信的投递链路。

站内通知保持现状，它是用户登录后的信息入口，但不能伪造成外部渠道 delivery。
历史方案中，企业微信明确失败时任务保留为 failed 并可诊断；现行无真实企业微信
投递任务。

未来若重新批准多渠道：

- 只有经过验证的“明确未发送”结果才允许 fallback；
- `result_unknown` 禁止自动 fallback；
- 成功但响应丢失时不得自动改发另一个渠道；
- 每个 fallback 创建独立 delivery；
- 任一渠道可信 sent 后，其余候选 delivery 取消；
- 人工重试继续使用原幂等键；
- 渠道恢复后不得补发 cancelled 或 result_unknown 旧任务。

## 15. 阶段五A关闭记录

阶段五A（OpenClaw daemon 与 Direct iLink）均为 No-Go，现已关闭。当前不批准：

- 新建或运行 `poc/direct-ilink-gateway`、Direct iLink Gateway 或 OpenClaw daemon；
- 登录、扫码、读取/交接凭据、入站轮询、固定握手、延迟发送或任何实况 PoC；
- 3 至 7 天功能观察、30 天稳定性观察、连接真实 outbox、生产投递或 fallback。

此前有关 iLink 的隔离 PoC、会话处理、握手、观察期和投递设计均为已废止历史或
未来参考；只有官方公开稳定 client/session、凭据交接和主动通知契约均解锁后，
才可重新审计，不能据此直接恢复实施。

## 16. 测试设计（已取消历史方案/未来多渠道参考）

当前不写、不运行真实渠道实现测试。以下测试项仅为已取消历史方案/未来多渠道
参考；企业微信不进行主体/自建应用/员工 UserID 核验，也不安排实现测试。未来只
能在本页顶部列明的重新审计条件满足并另获批准后，按届时渠道重新设计测试。

## 17. 部署、开关与后续顺序（现行口径）

默认开关保持关闭：

```text
WECHAT_CHANNEL_ENABLED=false
WECHAT_GATEWAY_ENABLED=false
WECOM_CHANNEL_ENABLED=false
```

当前后续顺序为：维持阶段三通知规则/outbox/租约/重试/TTL/审计 → H5 站内展示
→ Mock 测试/灰度验证；阶段四 DeepSeek 调度、`scheduled_follow_overdue`、
`daily_report`、AI 审计和模板降级仍只走该链路。禁止真实渠道投递、补发、
Gateway、企业微信门禁核验、迁移 `007` 和 delivery/binding 实现。仅当官方普通
微信出现独立 client/session 且支持主动通知，或用户批准公众号/服务号/其他合法
官方渠道后，才重新审计、重新设计并另行批准。

若未来实施，回滚仍不得执行破坏性 down migration；先关闭渠道规则与相关开关，
停止真实 delivery 领取，保留审计后再隔离代码和凭证。该规则是未来参考，不构成
当前部署任务。

## 18. 风险清单与生产阻塞项

| 级别 | 风险 | 当前处置 |
|---|---|---|
| P1 | OpenClaw daemon 无法证明零自动出站 | No-Go，阶段五A关闭 |
| P1 | Direct iLink 缺少公开稳定 client/session 与凭据交接 | No-Go，等待官方能力解锁后重新审计 |
| P1 | 企业微信自建应用已取消；所有真实外部渠道暂停 | 不核验外部门禁，不实施、不发送、不补发 |
| P1 | 真实渠道的迁移、投递模型和兼容策略已暂缓 | 不创建迁移 `007`，不实现 delivery/binding，不改造真实渠道 Worker |
| P2 | 凭证、隐私、结果未知与公网暴露 | 未来设计必须保留隔离、最小数据、fail-closed 和人工确认边界 |

Hook、RPA、逆向协议、Windows 客户端自动化均不作为替代路线；所有真实外部渠道
暂停期间，系统维持 H5 站内通知和 Mock 验证。

## 19. 已确认结论与暂停边界

已确认：

- OpenClaw daemon 与 Direct iLink 均 No-Go；阶段五A关闭；
- iLink 不进入实现、登录/轮询、固定握手、3 至 7 天 PoC、30 天观察、真实
  outbox、生产或 fallback；
- 企业微信自建应用由用户明确取消，不属于后续候选；
- 公众号/服务号和其他真实外部渠道均暂停，当前不做资格核验；
- 不建设 Windows 节点，不采用 Hook、RPA 或逆向协议；
- 迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 暂缓，
  不写代码、不迁移、不补发；
- H5 站内通知为唯一正式通知方式，Mock 仅用于测试/灰度，阶段四 AI 结果只写入
  通知基础设施→站内展示→Mock 验证。

## 20. 25 个必须回答的问题

1. **普通微信是否适合作为正式生产渠道？** 当前不适合。
2. **OpenClaw daemon 是否可实施？** 不可，No-Go。
3. **Direct iLink 是否可实施？** 不可，No-Go，阶段五A关闭。
4. **iLink 是否可登录、轮询或握手？** 当前均不批准。
5. **iLink 是否可做 3 至 7 天 PoC 或 30 天观察？** 当前不批准。
6. **iLink 是否可接真实 outbox、生产或 fallback？** 不可。
7. **iLink 何时可重新考虑？** 官方公开稳定 client/session、凭据交接和主动通知契约解锁后重新审计。
8. **企业微信应作为主渠道还是备用？** 两者都不是；用户明确取消。
9. **当前可否创建迁移007？** 不可。
10. **当前可否写企业微信代码？** 不可。
11. **当前可继续的通知工作是什么？** H5 站内展示与 Mock 测试/灰度验证；不做真实渠道核验。
12. **是否需要 Windows 节点？** 不需要，也不建设。
13. **是否采用 Hook、RPA 或逆向协议？** 不采用。
14. **离线 Gateway 的历史状态？** 曾实现且测试通过，但不获运行授权。
15. **OpenClaw 与插件是否曾安装？** 是；这是历史事实。
16. **是否曾使用专用账号扫码并持久化凭据？** 是；消息发送数为 0，daemon 未启动。
17. **Direct 审计是否完成？** 是，且最终结论为 No-Go。
18. **迁移 `007` 与投递/绑定表是否进入实现？** 否，全部暂缓。
19. **未来 Gateway 是否需隔离凭证？** 是，作为未来实施设计边界。
20. **如何处理发送结果未知？** 未来须 fail closed 并人工确认；当前无真实发送。
21. **是否允许接收微信业务指令？** 不允许。
22. **是否允许真实客户数据进入当前阶段？** 不允许。
23. **真实外部渠道暂停期间怎么办？** 继续使用 H5 站内通知和 Mock，不以 iLink、企业微信或逆向方案替代。
24. **当前是否存在可执行真实渠道任务？** 不存在。
25. **推荐后续顺序？** 通知基础设施 → H5 站内展示 → Mock 验证；符合重新审计条件后再报告并申请新设计授权。

## 21. 当前任务拆分

无。所有真实外部渠道暂停；企业微信已取消；当前不创建迁移 `007`、不实现
`notification_deliveries` 或 `notification_channel_bindings`、不启动渠道服务。
