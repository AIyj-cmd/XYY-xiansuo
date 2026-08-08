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
