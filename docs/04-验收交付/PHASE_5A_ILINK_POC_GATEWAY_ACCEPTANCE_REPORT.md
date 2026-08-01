# 阶段五A：iLink 隔离 PoC Gateway 验收报告

> **后续决策覆盖说明（2026-08-01）：** 本报告保留当时的历史验收事实、测试数字和“0 发送”证据，但其“企业微信正式生产首选”、企业微信接入、迁移 `007` 或任何真实渠道下一阶段的旧结论已失效。用户已取消企业微信自建应用并暂停所有真实外部消息渠道；OpenClaw daemon 与 Direct iLink 为 No-Go，Hook/RPA/逆向/Windows 自动化继续禁止。现行正式通知仅为 H5 站内通知，Mock 仅用于测试/灰度；迁移 `007`、`notification_deliveries`、`notification_channel_bindings` 暂缓，不进入实现，不补发。未来仅在官方普通微信提供独立 client/session 且支持主动通知，或用户重新批准合法官方渠道后，才重新审计。

> 验收日期：2026-07-31
> 验收基线：`poc/phase5a-ilink-gateway` /
> `eee7accf5ece3163eae5b3806cdb44685db54c0f`
> 结论：**离线 Gateway 代码验收通过；不批准实况 PoC、账号登录、二维码或生产使用。**

## 1. 验收范围

本次对照用户阶段五A要求、冻结设计
`PHASE_5_WECHAT_CHANNEL_AUDIT_AND_DESIGN.md`、官方兼容性复核、实际实现和独立
测试报告验收：

- 独立 `poc/ilink-gateway` 工程；
- HMAC、时间戳、nonce、防重放、Secret 轮换、16 KiB 限制和频率限制；
- 严格最小请求 schema、固定合成消息和单测试接收人；
- 独立本地 state、持久幂等和 `result_unknown` 保守语义；
- Fake Adapter、默认关闭的 iLink Adapter、健康与会话边界；
- CLI、隔离性、依赖安全和完整项目回归；
- 官方兼容性、实现、测试和后续实况 PoC 运行手册。

未执行且继续禁止：安装 OpenClaw/iLink、微信登录、二维码生成、扫码、设备确认、
真实凭证导入、真实 iLink 网络调用、消息发送、业务数据库/outbox/Worker/DeepSeek
接入、迁移007、企业微信接入和部署。

## 2. 官方兼容性结论

腾讯官方 `openclaw-weixin` 当前源码存在可维护的 HTTP JSON
`POST ilink/bot/sendmessage` 边界，请求需要 `to_user_id`、`context_token`、
`item_list`、`base_info` 及官方公共头。当前实现的 live Adapter 使用精确端点、
字段和头部；未稳定公开的 API base URL、App ID、版本和本项目 PoC 会话文件均
通过仓库外配置或人工导入，不在源码中猜测。

公开资料仍不能证明无近期入站会话时的定时主动通知、`context_token` 有效期、
最终投递回执或本项目自定义会话文件的无人值守恢复能力。因此官方兼容性结论
只支持离线 Gateway，不支持生产或实况放行。

## 3. 架构与隔离验收

通过项：

1. Gateway 位于独立目录、独立依赖和独立状态目录，未导入 `server`、
   notification Worker、线索、跟进、AI Scheduler 或 H5 模块。
2. 仅使用 PoC 独立 `node:sqlite` state；源码没有业务 `DB_PATH` 或
   `server/data` 访问。
3. 未修改迁移001至006，未创建迁移007，未修改业务 API、Worker、AI 或前端。
4. 默认监听仅允许 `127.0.0.1` / `::1`，显式拒绝 `0.0.0.0`。
5. iLink live 默认关闭；关闭时 Adapter 不读取 `session.json`、不调用 fetch、
   不登录、不生成二维码。
6. Gateway 运行路径的网络验证仅为自动化测试中的本机 loopback HTTP 和注入的
   mock fetch；依赖审计只查询包元数据，没有任何真实 iLink 或其他渠道请求。

## 4. 安全协议与消息边界

- 签名串固定为
  `HTTP_METHOD\nREQUEST_PATH\nTIMESTAMP\nNONCE\nBODY_SHA256`；
- 使用 HMAC-SHA256 和 `timingSafeEqual`，支持当前/前序 Secret 的受控轮换；
- 无效签名不会污染 nonce 存储；时间窗、未来时间、重放和请求体篡改均拒绝；
- nonce 跨 Gateway 重启仍有效，过期记录小批量清理；
- `POST /deliveries` 请求上限为 16 KiB，严格 schema 拒绝额外/缺失字段；
- title、body 和 detail URL 均有限制，消息必须精确匹配固定合成模板；
- 请求接收人必须精确匹配仓库外单测试接收人配置；
- state 只保存接收人和消息哈希、安全状态及回执元数据，不保存消息正文；
- 健康接口不返回 Secret、token、二维码、接收人全文或消息正文。

## 5. 幂等、错误和会话验收

同幂等键、同接收人、同消息的成功记录返回 `deduplicated`；同键内容冲突永久
拒绝。Gateway 重启后记录仍有效。`result_unknown` 不会自动重发、改判成功或
切换其他渠道；实现没有宣称 exactly-once。

Fake Adapter 覆盖 success、duplicate、timeout、retryable/permanent failure、
result unknown、offline、login required 和 delay。受控 Gateway 超时映射为
`retryable_failure/ILINK_SEND_TIMEOUT`，不会错误改为结果未知。

`state/session.json` 固定在 0700 state 目录内，要求 0600 常规文件并拒绝符号
链接、越界路径、过期和未知字段。清理 CLI 只能删除该受控路径。会话是本项目
PoC 的人工导入抽象，不冒充腾讯官方稳定凭证格式。

## 6. 验收修复

验收复现一个安全错误边界遗漏：畸形 `session.json` 的 `JSON.parse` 异常原先
可能作为任意错误文本进入 Adapter/健康状态。已在批准范围内修复：

- 捕获读取/JSON 解析失败；
- 统一返回 `ILINK_SESSION_INVALID`；
- 增加畸形 JSON 回归断言；
- 不记录或回显会话原文。

修复后重新执行 PoC build/test，21/21 通过。

## 7. 独立测试与回归

| 验证 | 结果 |
|---|---|
| `poc/ilink-gateway: npm run build` | 通过 |
| `poc/ilink-gateway: npm test` | 21/21 通过 |
| `poc/ilink-gateway: npm audit --omit=dev` | 0 vulnerabilities |
| `server: npm run build` | 通过 |
| `server: npm test` | 121/121 通过 |
| `app: npm run build:h5` | 通过 |
| `git diff --check` | 通过 |
| 微信小程序构建 | 未执行，项目已为 H5-only |

自动化测试共 142 项通过（Gateway 21 + 后端 121）。没有测试真实 iLink、
OpenClaw、微信账号、二维码或外部消息渠道。

`server/data` 验收前后 SHA-256 完全一致：

```text
app.db      c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3
app.db-shm  fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb
app.db-wal  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
leads.db    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
xiansuo.db  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## 8. 风险分级与门禁

当前未解决缺陷：

```text
P1 = 0
P2 = 0
P3 = 0
```

不属于离线代码缺陷、但阻断实况/生产的残余风险：

1. `context_token` 的有效期和无近期用户互动时的主动发送能力未实证；
2. 官方接口接受不等于最终送达，当前 live Adapter故意保守返回
   `result_unknown`；
3. 普通微信无法承诺 exactly-once，响应丢失时禁止自动重发；
4. 扫码、设备确认、登录失效、重启恢复和账号限制均未验证；
5. 当前只允许 loopback；未来跨节点协议、mTLS 和生产身份绑定不在阶段五A；
6. 当时结论（现已失效）：iLink 仅为普通微信隔离 PoC 候选，企业微信自建应用
   曾被列为正式生产首选；现行决定以文首覆盖说明为准。

## 9. 上线、实况 PoC与回滚建议

**不上线建议**：不得部署为生产渠道，不得连接真实 outbox，不得登录微信或发送
消息。当前只允许将代码和脱敏文档形成本地可追溯提交，然后停止并等待用户对
实况 PoC 的单独批准。

若后续获批实况 PoC，应严格执行
`PHASE_5A_ILINK_POC_LIVE_RUNBOOK.md`，使用专用测试账号、合成消息和仓库外
0600 配置，先完成3至7天功能验证；其成功仍不等于生产批准。

由于本轮没有部署、迁移或业务数据变更，回滚只需停止独立 Gateway、撤销仓库外
配置并在人工确认后清理 PoC 独立 state/session。不得删除业务数据库、通知日志
或迁移记录。

## 10. 建议提交边界

建议保持两个本地提交：

1. `feat: add isolated iLink PoC gateway`：仅
   `poc/ilink-gateway/**`（排除 `node_modules`、`dist`、state、环境文件和日志）；
2. `docs: add iLink PoC gateway delivery reports`：官方兼容性、实现、独立测试、
   本验收报告、未执行的 live runbook 和 CHANGELOG。

验收结论：**阶段五A离线 Gateway满足本轮验收标准；必须停在离线边界，等待
单独授权，不能自动进入真实 iLink 实况 PoC。**
