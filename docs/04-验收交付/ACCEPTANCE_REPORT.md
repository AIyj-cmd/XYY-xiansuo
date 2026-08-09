# 当前版本离线收尾验收报告

日期：2026-08-02

基线：`75f29bc`

结论：**单账号/单接收人发布冻结通过，可形成本地提交；生产上线仍为 CONDITIONAL GO，不授权任何生产操作。多账号定向发送为 NO-GO。**

## 1. 验收边界

- 原始目标是收口 H5 锁文件、完整回归、当前全部迁移、首版生产配置与同事绑定准备，不再重新设计已真实验证的 OpenClaw 通道能力。
- 依据为用户当前指令、根 `AGENTS.md`、实际代码与 [`TEST_REPORT.md`](../03-测试验证/TEST_REPORT.md) 第 29 节（第 28 节为上一次离线收尾）。早期设计文档仅作历史上下文，不覆盖当前已确认范围。
- 提交祖先关系为线性且可追溯：`e0242dd` 是 `9542513`、`8db1f27`、`d140826`、`82a40a3` 与当前 `75f29bc` 的祖先；本轮真实未提交差异未包含迁移、H5 业务源码或依赖文件变更。
- 本轮没有启动 OpenClaw、Gateway、Worker、AI Scheduler 或 DeepSeek，没有发送微信，没有访问生产数据库，没有构建小程序。
- 发布范围冻结为单账号、单启用接收人；账号 B 仅 `experimental/disabled` 预配置，不删除凭据且不生产使用，其他同事使用 H5。DeepSeek 与 AI Scheduler 继续默认关闭。既有自动化已覆盖 `owner_changed` 固定详情与脱敏、`openclaw-weixin` 入站静默；本轮未扩大这些边界。

## 2. 验收结果

| 范围 | 结果 | 验收证据 |
| --- | --- | --- |
| H5 锁文件 | 通过 | `app/package.json` 未改，未升级直接依赖、未恢复小程序依赖；两个全新临时副本及仓库目录均用普通 `npm ci && npm run build:h5` 成功，未使用 `--force`/`--legacy-peer-deps`。 |
| Server | 通过 | `npm ci`、build 和 `146/146` 测试通过；仅使用测试临时库。 |
| Gateway | 通过 | build 和 `53/53` 测试通过；仅 Fake Adapter/离线 fixture。 |
| 迁移 | 通过 | 当前实际版本为 `001`–`007`；空库顺序执行、重复执行、`006` 升级、checksum 冲突、失败回滚、历史通知保留、默认规则关闭均有自动化证据；`integrity_check=ok`、`foreign_key_check=[]`。 |
| 部署配置 | 通过 | API/Worker/Gateway 的 PM2 单实例模板、Nginx HTTPS 占位模板、仓库外配置/Secret/映射/会话目录、日志轮转、启停顺序和回滚文档已收口。PM2 cwd 缺失或不是绝对路径时 fail-closed；部署包含 Gateway 制品但不会自动启动真实渠道。 |
| 单接收人发布门禁 | 通过 | 仓库外 `0600` 映射在离线 CLI 与 live Gateway 启动时均要求恰好一个 `enabled=true`；CLI 仅在 SAFE 时输出聚合计数，零个/多个启用项非零失败且不输出用户 ID 或 target。未绑定无回退。 |
| 文档敏感信息 | 通过 | 对本次发布文档扫描未发现真实账号 ID、具体 target、Secret/会话凭据或完整手机号；仅保留占位符、环境变量名和安全操作要求。 |
| 数据隔离 | 通过 | `server/data` 目录聚合 SHA-256 前后一致；未操作生产 DB。 |

## 3. 迁移冻结值

| 版本 | SHA-256 checksum |
| --- | --- |
| 001 | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` |
| 002 | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` |
| 003 | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |
| 004 | `61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75` |
| 005 | `8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346` |
| 006 | `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a` |
| 007 | `c09175e80d010ea056c3e93e5f4fdfc61c4b2f4c08c885d0a6b4e96b1f5242da` |

## 4. Vite audit 适用性复判

`npm audit --omit=dev` 因 npm v11 对 uni-app peer 树的标记方式，仍将直接 devDependency `vite@5.2.8` 报为 1 high。该总体级别不能不加区分地等同于当前静态发布运行漏洞：

- high 与多个 moderate 条目主要要求对网络暴露 Vite 开发服务器，部分还只影响 Windows；例如 [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) 明确要求对网络暴露 dev server。本项目生产只发布 H5 静态制品，不启动 Vite 服务。
- [GHSA-64vr-g452-qvp3](https://github.com/advisories/GHSA-64vr-g452-qvp3) 的 DOM clobbering 条目影响 Vite 构建的 `cjs`/`iife`/`umd` 产物。本次实际 H5 `index.html` 使用 `type="module"` 的 ES module 入口，不符合该适用条件。
- 用户明确禁止本轮升级直接依赖，而 uni-app 当前锁定该 Vite 系列。本轮不运行 `audit fix`、`--force` 或不兼容升级是正确的范围控制。

因此验收将其归类为**已知工具链升级债务和后续依赖升级门禁**，不是当前静态 H5 发布的未解决 P2。运行边界必须继续为：禁止对不可信网络启动 Vite dev server，生产制品只同步 `app/dist/build/h5/`；后续升级必须同时验证 uni-app 兼容性。

## 5. 验收优化

测试报告后的验收发现均属于已批准的部署收口范围，已完成小范围修复：

1. PM2 模板原先在 cwd 未设置时可能回退至调用目录；现在缺失或相对的 `XIANSUO_SERVER_DIR`/`XIANSUO_ILINK_GATEWAY_DIR` 会拒绝加载。
2. 生产环境示例的 `NODE_ENV` 由 `development` 修正为 `production`。
3. `setup.sh` 原先会直接复制含占位证书路径的 Nginx 模板；现在先校验域名，再在受控机上渲染域名和 Let's Encrypt 路径，并以 `nginx -t` 作切换前门禁。
4. 部署包原先未包含 Gateway 源码/锁文件和运行模板；现在会构建 Gateway 制品、复制 Worker/Gateway PM2 模板，但只更新 API，保持真实渠道停止。
5. 映射检查原脚本使用 devDependency `tsx`，不适用于 `npm prune --omit=dev` 后的制品；现在改为执行已编译 CLI。

## 6. 分级、残余风险与建议

- 未解决产品/实现缺陷：**P1=0、P2=0、P3=0**。
- 仓库内离线收尾：**GO，可提交**。
- 正式生产部署：**CONDITIONAL GO**。下列为外部/人工门禁，不是本轮代码 P 级缺陷：
  1. 集中提供生产项目目录、绝对 DB 路径、H5/Nginx/PM2 路径、备份/恢复目录、上一版制品，并授权只读一致性备份。
  2. 在生产副本完成当前 `001`–`007` 迁移与恢复演练，不得把生产主库作首次试跑目标。
  3. 明确维护窗口、回滚负责人，并另行授权 H5 覆盖、PM2/Nginx 操作及 OpenClaw/Gateway/Worker 启动。
  4. 仅对唯一指定内部接收人完成人工身份/映射核对；账号 B 保持 `experimental/disabled` 且不删除凭据，其他同事使用 H5。任何新真实发送仍需一次明确授权。

本结论不允许推送、合并、生产数据库操作、覆盖 H5、PM2/Nginx 重启或真实微信发送。

## 7. Hermes Weixin v2026.8.3 纯离线 PoC 验收（2026-08-08）

### 验收范围与实现一致性

- 交付仅包含 `poc/hermes-weixin-offline/{README.md,run-offline-poc.sh,test_offline_poc.py}` 及本次追加文档；未修改产品源码、数据库、服务配置、部署脚本或依赖。
- 上游来源固定为 `https://github.com/NousResearch/hermes-agent.git` 的 tag `v2026.8.3`、commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、包版本 `0.20.0`、MIT；测试同时断言目录、Git HEAD/tag 和包元数据。
- 9 项测试覆盖双 peer/session、account+peer token 隔离与恢复、`disabled/pairing/allowlist` intake、Gateway 未授权早退及授权进入 Agent 链记录桩、公开 `cmd_send` fake transport、单 peer payload 和当前失败语义。
- 所有外部发送路径均为 fake；未访问网络、未登录或扫码、未真实投递、未读取默认 Hermes 状态、未启动 Hermes/OpenClaw/Worker/AI 服务、未改动 `server/data`。

### 最终验证

| 检查 | 结果 |
| --- | --- |
| Hermes 离线脚本 | 验收阶段连续两轮 **9/9**，均通过。 |
| 后端 | `npm run build` 通过；`npm test` **146/146**。 |
| 前端 H5 | `npm run build:h5` 通过；仅未配置 uni Appid 的统计提示。 |
| 数据/临时状态 | 三个活动数据库文件验收前后哈希一致；最终 8 文件清单聚合 SHA-256 为 `7cfa8026040a7f5b5915322fbfed619a745d76e5970724bb6519035b94c6cf10`；无 PoC 临时目录。 |
| 历史保护 | `TEST_REPORT.md` 的 `HEAD` 原有 630 行保持逐字一致，Hermes 结果仅作为第 30 节追加。 |

### 分级与放行

- **P1=1（真实外发阻断）**：timeout、HTTP 400、HTTP 503 与坏 JSON 均默认尝试 1+4 次；相同业务消息跨独立调用生成新 `client_id`，不存在跨调用业务幂等。
- **P2=0**：本次批准范围内未发现中等级漏实现或越界改动。
- **P3=1（范围限制）**：全 fake 离线测试不能证明扫码、会话恢复、context token 有效期、限流、用户端回执或真实送达。
- **离线 PoC：PASS，允许形成仅包含上述 PoC 与追加文档的本地提交。**
- **真实 Pilot、真实发送、生产接入或部署：NO-GO。** 关闭 P1、完成独立实况设计与验证并重新取得明确授权前，不得进入这些阶段。

## 8. Hermes Weixin v2026.8.3 transport-only overlay 最终验收（2026-08-08）

### 结论

**离线 transport-only overlay：PASS；本地提交：GO；真实登录、扫码、联网、微信发送、真实 Pilot 与生产部署：NO-GO。**

本节验收的是后续新增的 `poc/hermes-weixin-transport/` 本地 overlay 与 `poc/ilink-gateway` 显式 Hermes adapter，不改写第 7 节对“直接使用上游默认 Weixin send”的历史 P1 结论。overlay 绕开上游默认 1+4 重试路径，并以 Gateway 持久账本、单次调用和未知结果烧毁门禁关闭了该风险；本轮仍没有证明真实协议或用户端送达。

### 需求与范围核对

| 验收目标 | 结果 | 证据摘要 |
| --- | --- | --- |
| 固定上游与 fail-closed gate | 通过 | 固定 `NousResearch/hermes-agent` tag `v2026.8.3`、commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、tree `b217767ccb994605dad522e693fa1b4cdbc2f352`、包版本 `0.20.0`、MIT；remote/tag/commit/tree/clean 与受控文件 SHA-256 均在读取配置、状态和导入 Hermes 前核验。 |
| capture-only 边界 | 通过 | 只接受 1–10 项静态 allowlist 中、发给配置账号的非群非自身 DM，并只捕获 context token；ignored 输入不创建状态，不读取正文、媒体或消息 ID，不触发 Agent、Provider、AI、工具或回复。 |
| 最小加密状态 | 通过 | schema 2 仅保存 HMAC reference、随机 nonce、密文、entry MAC 与集合 MAC；原始 account、peer、token、正文、媒体、message ID 不落盘。配置/映射/Secret/状态严格仓库外，文件 `0600`、目录 `0700`、当前 UID、单硬链接、无 final/ancestor symlink。 |
| 单次确定性发送 | 通过 | `client_id` 由 account、peer、业务幂等键确定；只允许一次纯文本 `ilink/bot/sendmessage`，无 token 时零调用，无 retry、chunk、typing、media、fallback；4xx/非零 ret 为明确失败，timeout/断线/5xx/坏 JSON 为 `result_unknown`。 |
| Gateway 默认关闭与隔离 | 通过 | 默认 transport 仍为 `openclaw`；Hermes 必须同时显式选择 transport 与 enable flag，live 仍默认关闭；HTTP schema 不接收 peer/token/自由正文，peer 只来自仓库外严格映射，Gateway ledger 同样位于仓库外。 |
| 幂等、超时与进程回收 | 通过 | 同 key 并发、重启、历史 retryable/unknown 均不会再次调用 adapter；非法输出、spawn、timeout/abort 均烧毁为未知结果。runner 先 SIGTERM，250ms 后 SIGKILL，并等待 `close` 后返回，受控忽略 SIGTERM 子进程已验证 reap。 |
| 无关范围与数据保护 | 通过 | 未修改 `app/src`、`server/src`、数据库迁移、依赖清单或部署脚本；未访问生产数据库。`server/data` 8 个普通文件验收前后逐文件 SHA-256 一致。 |

### 最终测试结果

| 检查 | 结果 |
| --- | --- |
| overlay 压力回归 | 连续 5 轮，每轮 12/12，共 **60/60**；每轮包含 10 个 12-thread 冷启动 capture 回合。 |
| 上游旧行为离线对照 | **9/9**；全部为 fake transport 与 DNS/socket 失败桩，预期复现上游默认重试风险，不发生真实发送。 |
| Gateway build/test | build 通过，**58/58**。 |
| Server build/test | build 通过，**146/146**。 |
| H5 build | `npm run build:h5` 通过；只有未配置 Appid 的统计提示。 |
| 合计 | **273/273 自动化测试通过**，另有 3 项构建通过（Gateway、Server、H5）。 |
| 完整性与运行边界 | `git diff --check` 通过；敏感凭据模式扫描无命中；无 Hermes/OpenClaw/Gateway/Worker/DeepSeek/AI Scheduler 服务进程。 |

### 分级、已知问题与放行建议

- **P1=0、P2=0、P3=1**。P3 是自定义 HMAC-SHA256 keystream + Encrypt-then-MAC 状态格式的长期维护风险；当前 nonce、域分离、entry MAC、集合 MAC 与篡改失败关闭已满足本轮离线边界。未来如在已批准依赖内迁移成熟 AEAD，必须版本化、兼容验证，不能原地削弱现有保护。
- 未执行且不能宣称通过：真实登录/扫码、session 恢复、真实 context token 有效期、网络故障、限流、provider 回执、用户端送达或生产运行。
- 适合形成一个边界清晰的**本地提交**，提交范围应只含 overlay、Gateway Hermes adapter/门禁/测试、`TEST_REPORT.md` 与本次四份文档追加。不得把 `/tmp/hermes-agent-v2026.8.3`、仓库外配置/Secret/映射/状态或构建产物纳入提交。
- 本结论不授权 push、merge、生产 DB、真实账号、网络、登录、扫码、发送、PM2/systemd/Nginx 变更或生产部署。

## 9. Hermes 成功响应分类修复最终验收（2026-08-08）

### 结论

**PASS（仅离线实现）；P1=0、P2=0、P3=0；适合形成范围清晰的本地提交。** 真实登录、扫码、网络调用、微信发送、Worker 接入与生产部署仍为 **NO-GO**，本结论不授权 push、merge 或外发。

上一轮真实 Pilot 的历史事实保持不变：指定接收人实际收到 **1 条**，接收人正确，自动重试 **0**，其他渠道发送 **0**；旧 overlay 当时记录的技术结果为 `permanent_failure / ILINK_PROVIDER_REJECTED`，人工事实为 `manually_confirmed_received`。本次只修正后续响应分类，不回写、删除或伪装该历史技术误判。

### 验收标准与证据

| 验收项 | 结果 | 证据摘要 |
| --- | --- | --- |
| 已知成功形态 | 通过 | 精确空对象 `{}` 映射为 `sent / ILINK_SENT / empty_object`；真正整数 `ret=0`（可带真正整数 `errcode=0`）映射为 `sent`。 |
| 明确失败与未知结果 | 通过 | 不冲突的真正整数非零 `ret`/`errcode` 为 `permanent_failure`；0/非零冲突、单独 `errcode=0`、bool/string/null/float、未知对象与非对象均失败关闭为 `result_unknown`。 |
| 最小响应与脱敏 | 通过 | overlay stdout 恰好为 `status`、`code`、固定枚举 `responseShape`、`idempotencyKey` 四字段；不回显原始响应、未知字段和值、正文、token、context token 或 peer。对抗 canary 只存在于测试 fixture。 |
| 单次调用 | 通过 | 每个 fake provider 用例断言 `post_once` 调用恰好一次；无 retry、fallback、chunk、typing 或 media 路径，无 context token 时零调用。 |
| Gateway 严格消费 | 通过 | 旧三字段、额外字段、未知 shape、status/shape 或退出码不匹配均收敛为 `result_unknown`；Hermes adapter 保持 `single_attempt`，永不返回 `retryable_failure`。 |
| Gateway 幂等 | 通过 | 同 key 并发共享一个在途 promise；持久账本在首次 acquire 时先写 unknown 并加锁，sent、permanent、unknown、重启后命中和历史 retryable 烧毁均不会产生第二次 adapter 调用。 |
| 范围与兼容性 | 通过 | 仅修改 overlay、Gateway Hermes adapter、测试/fixture、README 与追加报告；未改 API、数据库 schema、`server/src`、`app/src`、依赖或部署脚本。 |

### 验收阶段复验

- overlay 离线脚本连续两轮：每轮 **13/13**，合计 **26/26**。
- Gateway：build 通过，测试 **59/59**。
- Server：build 通过，测试 **146/146**。
- H5：`npm run build:h5` 通过；仅有既有 Appid/可选版本提示。
- `git diff --check` 通过；`server/data/app.db`、`app.db-shm`、`app.db-wal` 验收前后 SHA-256 分别保持 `8b8bc326…`、`42a2baf3…`、`194c0753…`。
- 未发现 Hermes、OpenClaw、iLink Gateway、notification-worker 或 Weixin 常驻进程；未执行真实登录、扫码、网络调用或发送。

第 8 节记录的自定义 HMAC 状态格式长期维护风险继续作为既有范围风险保留，但不是本次响应分类修复新增或未关闭的 P3。本轮没有测试报告已确认且仍可复现的问题，因此验收阶段未修改业务源码。

### 下一次真实单条门禁

只有取得新的、明确的一次性授权后，才可做一条新 Pilot；授权需冻结账号、唯一接收人、固定正文、新幂等键、执行窗口、人工观察人和停止条件。执行时必须证明 adapter 调用 **1 次**、技术状态 `sent`、用户端实际收到 **1 条**、自动重试 **0**、其他渠道发送 **0**。任何 `result_unknown`、超时、断连、非法响应或技术/人工结果不一致都立即停止，不换 key、不重发、不 fallback，并保留账本与人工事实供核对。该门禁通过前不得接入 Worker 或生产。

## 10. Hermes 1–10 用户网站绑定与 `owner_changed` 定向通知验收（2026-08-08）

### 结论

**离线实现 PASS：P1=0、P2=0、P3=0。真实 Pilot 与生产上线未授权，结论为 NO-GO。** 本结论不授权提交、推送、部署、生产数据库迁移、登录、扫码、联网、微信发送或后台进程启动。

本节以主代理明确批准的当前目标覆盖早期文档中的单接收人冻结历史，但只覆盖离线实现验收；早期真实渠道限制不会因此自动解除。

### 需求与实现核对

| 验收目标 | 结果 | 证据摘要 |
| --- | --- | --- |
| H5 登录用户一次性绑定码 | 通过 | JWT 鉴权接口生成 `XYY-[A-Z2-7]{26}` 格式的 128-bit 随机码，10 分钟有效、60 秒发码间隔、提交后清除；H5 展示精确 `绑定 <code>` 命令，所有请求走统一 request 工具。 |
| 同一 Hermes 账号 capture-only | 通过 | daemon 只轮询固定账号；群聊先拒绝，未知 peer 只为精确绑定命令提取文本，已绑定 peer 只刷新 token；源码与测试桩无 Agent、AI、reply、typing、media 能力。 |
| 数据最小化和隔离 | 通过 | 业务库不含 raw peer/context token/cursor/raw nonce/入站正文，只含不透明指纹、状态/代次、挑战控制、prepared 激活凭证、active activationId 派生哈希及 nonce 派生哈希；raw peer/token/cursor 仅进入仓库外 `0700/0600` 加密 vault。公开 API 不返回指纹或秘密。 |
| 1–10 容量与跨进程互斥 | 通过 | Server 在 `BEGIN IMMEDIATE` 下限制 active + prepared 最多 10；vault 所有公开读写经同一 `fcntl.flock`，容量和 peer 冲突在锁内失败关闭。独立 11 进程结果为 10 成功/1 拒绝，同 peer 仅 1 成功。 |
| 精确代次路由与崩溃恢复 | 通过 | outbox 固化 `recipient_binding_generation`，Worker 发送前复核；Gateway 无 raw peer map，overlay 只在 vault 精确 active 代次时调用上游。prepared→commit 后崩溃可用原 activationId 恢复；错误 activationId 重放被拒绝。 |
| 持久重放防护与事务停用 | 通过 | 内部 nonce 只以派生哈希持久化，跨重启拒绝重放，10,000 容量且 65 秒到期清理；用户停用和 internal disable 均原子更新绑定并取消 pending/retry_wait/sending Hermes 任务，注入失败时完整回滚。 |
| 无 fallback/未知结果不重试 | 通过 | 管理规则仍限定单渠道；Hermes Adapter `single_attempt`，Gateway 持久账本烧毁 unknown key，Worker 将 Hermes `result_unknown` 终结为不可重试。 |
| 默认关闭和兼容性 | 通过 | Binding、channel、Gateway transport/live 及通知规则默认关闭；OpenClaw/Mock、既有迁移和 H5 回归通过，无依赖或技术栈变化。 |

### 验收阶段复测

| 命令 | 最终结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS，`156/156`。 |
| `cd poc/ilink-gateway && npm run build && npm test` | PASS，`59/59`。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | PASS，`18/18`。 |
| `cd app && npm run build:h5` | PASS；仅有未配置 Appid/可选版本提示。 |

测试报告 34.1 的 P1（active 重放未校验 activationId）和 P2（internal disable 非原子）均已按 34.2 修复，并在验收复跑中以正确/错误 activationId 双断言及注入失败回滚关闭；早期 P1-1～P1-4 与 P3 也保持关闭。本阶段没有仍可复现且获确认的范围内问题，因此没有修改业务源码。未执行真实微信登录、扫码、session/context token 时效、真实网络异常、供应商回执、用户端送达、生产副本迁移或恢复演练，不能把这些项目写成通过。

### 残余风险与上线建议

- 当前代码具备离线可验证性，但缺少真实运行授权、生产副本迁移/恢复演练、真实 session 与送达证据、运行监控和操作责任人；这些是外部上线门禁，不计为本轮离线代码 P 项。
- 迁移 `008` 是前向表重建且无降级迁移，最终 checksum 为 `f26b25fe25e8cb5f21da92f06eb9f0303f27d8649299be4b35697ea2af17005a`。fresh、007→008、重复执行、checksum 冲突与失败回滚均通过；生产应用前仍必须备份并在一致性副本完成升级/恢复演练。
- capture daemon/vault/Gateway 必须保持单实例、仓库外私有路径与默认关闭。只允许批准的 `owner_changed` Hermes 规则；任何范围扩展需重新审计。
- **上线建议：离线交付可进入本地评审收口；真实 Pilot 和生产上线均 NO-GO，待用户另行明确授权并完成部署门禁后重新验收。**

## 11. Hermes 两步式 H5 自助绑定页验收（2026-08-09）

### 验收结论

**离线页面能力 PASS；验收发现的 active 重绑 P2 已修复并关闭，最终 P1=0、P2=0、P3=0。**
当前只完成代码、构建和离线浏览器验证；未提供/人工核验真实长期公开联系人入口，未部署、未登录或扫码、未联网收发、未发送消息。

| 验收标准 | 结果 | 证据摘要 |
| --- | --- | --- |
| 两步式而非登录二维码 | 通过 | 登录用户调用既有发码/状态 API，复制精确 `绑定 XYY-…` 命令；页面与无配置制品均不生成、不展示 Hermes/iLink 登录二维码。 |
| 时限、成功与生命周期 | 通过 | 显示 10 分钟剩余时间/过期状态，2 秒轮询成功；过期、成功、Vue 卸载、uni `onUnload` 和 H5 `popstate` 都会停止，已发请求返回后不会重排。 |
| active 用户重绑 | 修复后通过 | 原实现把旧 active 状态误当新码成功；现以 active 且本次 `expires_at=null` 确认 commit。回归覆盖新命令可见、下一代 prepare/commit 和再次轮询成功。 |
| 长期公开联系人入口 | 代码通过，外部门禁未完成 | 只接受无 userinfo 的 HTTPS 构建变量；经测试的合法入口可显示/复制，HTTP 或带 userinfo 的值失败关闭，缺失时只显示人工索取提示。真实入口尚未提供和核验。 |
| 范围、权限与数据隔离 | 通过 | 页面请求继续统一经 `request.ts`，只使用登录 JWT 定位当前用户；无新 API、迁移、生产依赖或 Server 改动，公开页面/响应不显示 peer、token、session 或 cursor。 |

### 最终复测和交付建议

- `cd app && npm run test:h5`：PASS，内含 H5 build 与 Playwright **11/11**；仅有既有 Appid/可选版本提示。
- `git diff --check` PASS；package/lockfile 与 Server 源码无差异，无配置 H5 制品的入口 fixture/测试凭据/登录二维码路径扫描无命中，无测试临时目录遗留。
- 本轮不涉及 Server、Gateway、overlay、数据库或依赖变更；第 10 节的完整 Hermes 离线基线仍保留，但不被冒充为本次真实运行证据。
- **上线建议：离线代码可进入本地提交/评审（GO）；生产部署、开启 Hermes 绑定、真实 Pilot 和任何发送仍为 NO-GO。** 放行前必须先人工核验真实入口归属/长期性/HTTPS 证书/公开内容，确认非登录二维码且不含凭据，再获得单独部署与实况授权。

## 12. 每网站用户独立 Hermes 账号与串行 QR 绑定最终验收（2026-08-09）

### 结论

**离线代码与自动化验收：GO，可形成范围清晰的本地提交；P1=0、P2=0、P3=0。**
**真实双人扫码/确认命令/owner_changed 发送及生产部署：NO-GO。** 本轮没有登录、扫码、
联网、轮询真实 provider、发送微信消息、操作生产数据库或启动生产进程。

### 原始目标与实现核对

| 验收目标 | 结果 | 最终证据 |
| --- | --- | --- |
| 每网站用户独立账号 | 通过 | Server 只持久化 opaque `accountRef`；manager vault 以 `userId + generation + accountRef` 保存独立 provider account/target/context/cursor；Gateway、Worker、adapter 和 send overlay 全程使用同一精确三元组。 |
| H5 直接串行展示官方登录 QR | 通过（离线） | 全局唯一 live attempt；owner-only create/get/delete；5 分钟 TTL；响应 `Cache-Control: no-store`；data PNG、倒计时、状态、确认命令、取消和卸载停止轮询均通过真实浏览器回归。QR token/payload 只驻留 manager 进程内存，未写 vault、SQLite、日志或 H5 静态制品。 |
| 扫码后仍需新会话精确确认 | 通过（fake provider） | scan 只进入 `prepared/awaiting_context`；只有精确账号收到精确 `确认 <activationId>` 且取得非空 target/context 后才回调 active。错误账号、target、命令、accountRef、generation、activationId 均拒绝或零网络。 |
| 重绑安全切换 | 通过 | 新 active 前旧 binding/任务不变；Server active commit 与旧任务取消同一 SQLite 事务；manager 在单次 flock/原子 vault 替换中激活新账号并清空、退役同用户其他 live 账号。回调丢响应后会使用已持久 context 自动重试同一 activation，不要求重新发送命令。 |
| 停用、重启与崩溃 | 通过（离线） | 用户停用事务先禁用 binding、取消 live attempt/待发任务，再同步尝试 manager 退役；manager 对 active 账号每 60 秒用精确 activation 合同复核，Server 拒绝已停用/错代账号后本地退役。prepared 过期会清空 provider 凭据；重启恢复 prepared/active poll，丢失的内存 QR 失败关闭。 |
| owner_changed 精确隔离 | 通过 | outbox 固化 `recipient_user_id + recipient_binding_generation + recipient_account_ref`；领取前再与 active binding 精确比较；Gateway 无 Hermes peer map、default/legacy account、tokenless、fallback 或 retry；unknown 保持单次终态。 |
| 迁移与兼容 | 通过 | 仅新增 `009`，未改 `001`–`008`；fresh、008→009、重复、checksum 冲突、故障回滚、trigger 实际执行、完整性和外键均通过。legacy active/pending 数据保持原状，公开状态为 `rebind_required`；新 active 前不切换。 |
| 默认关闭与运行边界 | 通过 | Server binding/channel、Gateway Hermes transport/live 和通知规则默认关闭；旧 H5 入口配置已删除，旧 binding-code API 返回 409，旧 Hermes recipient-map 环境变量被严格配置 schema 拒绝。manager 未加入自动 PM2 启动链。 |

### 验收阶段确认并修复的问题

1. QR token/payload 原先进入加密 vault，仍不满足“QR 不落盘”；现改为仅进程内存，重启时失败关闭。
2. prepared attempt 原先可超过 Server TTL 持续 poll；现按同一 `expiresAt` 自动退役并清空 token、target、context 和 cursor。
3. active 重绑原先只切换业务库，旧 manager account 可继续占用 slot/poll；现同用户旧 live account 与新 active 在同一 vault 锁和原子替换中完成退役/激活。
4. active activation 重放原先未重新核验 activationId/target；现必须同时匹配 activationId 派生哈希、target fingerprint、generation 和 accountRef。
5. 用户停用的 manager 退役原先为未等待的 best-effort；现请求返回前完成一次受控退役尝试，并以 manager 周期性授权复核覆盖进程崩溃/暂时不可达窗口。
6. manager 原先按内部别名读取确认结果，未匹配固定上游真实字段 `bot_token/baseurl`，真实确认后无法进入 prepared；现用精确上游字段归一化，并对缺失凭据、未知状态和非固定 redirect/base host 失败关闭。二维码渲染也前置到 vault 写入前，`qrcode` 缺失时不留下孤儿 attempt。

### 最终验证

| 命令 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS，**160/160**。 |
| `cd poc/ilink-gateway && npm run build && npm test` | PASS，**59/59**。 |
| `cd poc/hermes-weixin-transport && ./run-tests.sh` | PASS，**29/29**；包含固定上游字段 fixture、扫码状态、redirect host 与 `qrcode` 缺失失败关闭。 |
| `cd app && npm run test:h5` | PASS，H5 build + Playwright **10/10**。 |
| `git diff --check`、敏感内容与制品扫描 | PASS；未发现真实 QR、provider credential、target/context/cursor、Secret 或测试图片进入 Git。 |

### 残余风险与下一人工门禁

- `R-1`：server/app 既有生产依赖审计仍有 high 项；本轮 package/lockfile 未变化，不在验收中擅自升级。必须按既有风险登记和 uni-app 兼容升级计划处理。
- 自定义 HMAC-SHA256 keystream + Encrypt-then-MAC vault 格式仍是既有长期维护风险；本轮确认随机 256-bit nonce、entry MAC、随机 key、0600/0700、flock、原子替换与篡改失败关闭，未新增依赖或更换批准设计。
- 固定上游代码静态核对和 `qrcode==7.4.2` 导入通过，但离线 fake provider 不能证明真实 QR 内容、扫码状态、iLink 账号生命周期、context 有效期、限流、用户端送达或 provider 回执；生产副本迁移/恢复也未执行。
- 下一门禁必须由人工冻结两名测试用户、两套独立账号、唯一接收人、固定消息、窗口和停止条件；依次完成串行 QR、精确确认、重启/停用/重绑、两账号交叉交换零网络、各一条 owner_changed 单次发送与人工收件核对。任何 unknown、错投、重复、fallback、重试或账本不一致立即停止。

因此，本工作区**可以提交但不应部署**；真实双人扫码/发送和生产部署在完成上述人工门禁前保持 **NO-GO**。
