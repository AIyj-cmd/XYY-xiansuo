# 阶段五A：iLink 实况 PoC 就绪补丁验收报告

> 验收日期：2026-08-01
> 分支：`fix/phase5a-ilink-live-readiness`
> 基线 HEAD：`7a382a7510eabede02e1648acf4482f2ce24072e`
> 验收范围：已批准的 Phase 5A 隔离 PoC 实况就绪补丁及唯一确认的 P2 测试夹具修复
> 结论：**离线就绪补丁验收通过；允许整理提交与合并。人工登录、二维码、扫码、真实发送、3--7 天实况 PoC及任何生产接入仍为 No-Go。**

## 1. 验收结论

本补丁满足冻结设计的“隔离 PoC 准备度”边界：Gateway 独立于业务系统，默认关闭 live，所有 OpenClaw 子进程使用仓库外隔离状态目录，实际版本、插件 metadata、兼容范围和公开 send capability 任一不满足即失败关闭。当前主机没有 OpenClaw，实际前置检查按设计返回 `NOT_READY / ILINK_OPENCLAW_NOT_INSTALLED`，没有进入插件、会话、登录或发送步骤。

独立测试报告中唯一未关闭项 P2-1 已按明确授权修复。修复只改测试时间夹具，未修改生产源码、TTL、人工重试条件或 HTTP 200 断言。最终验收范围内：

| 级别 | 未关闭数量 | 结论 |
|---|---:|---|
| P1 | 0 | 通过 |
| P2 | 0 | 通过 |
| P3 | 0 | 通过 |

上线建议分层如下：

- **Go**：提交、合并和部署默认关闭的离线 Gateway 就绪补丁；继续执行 fake/mock 验证。
- **No-Go**：本轮人工登录、二维码、扫码、真实测试消息和腾讯网络调用。必须由用户另行授权，并满足运行手册全部外部门禁。
- **No-Go**：iLink 接入业务 outbox、业务数据库、通知 Worker 或生产通知。阶段五冻结设计要求迁移 007、delivery/binding、实况能力证明和再次审批，本补丁均未包含。

## 2. 需求与设计符合性

| 验收项 | 结果 | 证据 |
|---|---|---|
| 默认关闭且失败关闭 | 通过 | `ILINK_POC_LIVE_ENABLED=false`；缺少 OpenClaw 返回 `NOT_READY` |
| 官方运行时为会话事实源 | 通过 | 删除自定义 `session.json` 读写；只调用公开 CLI 状态契约 |
| 隔离状态与配置 | 通过 | 强制绝对、非符号链接、`0700` state/session 目录；子进程覆盖 `OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH` |
| 固定合成消息和固定接收人 | 通过 | send CLI 不接受自定义正文或接收人；幂等键必须显式提供 |
| 发送结果保守分类 | 通过 | raw `ret=0` 或严格运行时确认才为 sent；不确定结果进入 `result_unknown` 且同键不重发 |
| 本地 Gateway 安全 | 通过 | 回环监听、HMAC、时间戳、nonce、防重放、16 KiB 限制、持久幂等 |
| 凭证与隐私 | 通过 | Gateway 不读取/保存 token、context token、二维码或 OpenClaw 私有会话；状态仅存哈希和安全分类 |
| 业务域隔离 | 通过 | 无 `server/src`、`app`、`scripts`、`deploy` 实现差异；无迁移 007、业务 DB/outbox/DeepSeek/Worker 接入 |
| 已确认 P2 修复 | 通过 | 人工重试夹具改为运行时 Asia/Shanghai 当前时间；生产 TTL 与断言未变 |

未发现漏实现、超出批准设计的新功能或无关业务修改。Gateway 的 OpenClaw CLI 包装仍只是未来受控实况 PoC 的入口，不构成主动定时通知能力或生产可用性证明。

## 3. 验收修复

文件：`server/test/phase3-independent-verifier.test.ts`。

原夹具固定在 `2026-07-30 19:00:00`，任务 TTL 为 1440 分钟；验收日已经过期，生产路由正确拒绝人工重试并导致测试期望 200 失败。修复后创建、领取和失败时间分别由运行时当前时刻前 2 秒、前 1 秒和当前时刻按 `Asia/Shanghai` 派生，任务在测试期间保持未过期。

该修复保留了：

- `ttl_minutes=1440`；
- 过期任务不得人工重试的生产门禁；
- admin/member 权限断言；
- 首次人工重试 200、重复重试 409 的原断言；
- 业务源码和迁移 001--006 完全不变。

## 4. 最终验证结果

| 验证 | 结果 |
|---|---|
| `poc/ilink-gateway: npm run build` | 通过 |
| `poc/ilink-gateway: npm test` | 28/28 通过，0 失败/跳过 |
| `poc/ilink-gateway: npm audit --omit=dev` | 通过，0 vulnerabilities |
| 受影响阶段三独立测试 | 19/19 通过，0 失败/跳过 |
| `server: npm run build` | 通过 |
| `server: npm test` | 121/121 通过，0 失败/跳过 |
| `app: npm run build:h5` | 通过 |
| `git diff --check` | 通过 |

实际安全前置检查（live=false、仓库外 `0700` 临时 state、未配置 session）：

```json
{"conclusion":"NOT_READY","code":"ILINK_OPENCLAW_NOT_INSTALLED","openclawInstalled":false,"pluginInstalled":false,"compatible":false}
```

实际官方会话状态投影：

```json
{"installed":false,"loggedIn":false,"sessionStatus":"unsupported","requiresHumanLogin":false,"code":"ILINK_OPENCLAW_NOT_INSTALLED"}
```

两个命令只验证缺失可执行文件时的安全失败；没有可被执行的 OpenClaw、插件或真实会话，也没有网络、登录、二维码和发送动作。

## 5. 数据、API、权限和安全边界

- `server/data` 验收前后 SHA-256 清单逐项一致：
  - `app.db`：`8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2`
  - `app.db-shm`：`fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`
  - `app.db-wal`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
  - `backups/app-before-admin-reset-20260731T081254882374624Z.db`：`bed2dc919701489749024b201cebcf28e41788f5e622eb76232c29f94c412f22`
  - 对应 backup `-shm`：`fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`
  - 对应 backup `-wal`、`leads.db`、`xiansuo.db`：均为 SHA-256 空文件哈希 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- 未打开、迁移或写入业务数据库；测试只使用 `/tmp` 独立数据库。
- 未新增业务 API、H5 权限入口、管理员接口或消息接收命令。
- 无迁移 007、`notification_deliveries`、`notification_channel_bindings` 或迁移 001--006 修改。
- 无业务 outbox、通知 Worker、DeepSeek、线索或跟进数据访问。
- 无 OpenClaw/iLink 安装、真实命令执行、插件调用、腾讯网络、账号登录、二维码、扫码或消息发送。

## 6. 部署、监控与回滚

本轮没有生产渠道部署，也没有数据库部署步骤。合并后应继续保持 `ILINK_POC_LIVE_ENABLED=false`，配置与 state/session 目录留在仓库外，Gateway 仅监听回环地址。未来得到单独授权后，严格按 `PHASE_5A_ILINK_POC_LIVE_RUNBOOK.md` 执行；前置检查不是 `READY` 时必须停止。

离线监控信号：Gateway 进程健康、`gatewayStatus`、`channelStatus=disabled`、`liveEnabled=false`、安全错误码、nonce/幂等 state 文件权限。未来实况阶段才监控 `sessionStatus`、连续失败、`result_unknown`、扫码次数、重启恢复与账号限制；不得记录接收人、正文、token、二维码或上游原始错误。

回滚为纯代码/配置回滚：保持 live=false，停止独立 Gateway，回退 Phase 5A 就绪补丁提交；不执行 down migration，不操作业务数据。若未来已单独执行实况 PoC，先停止 Gateway、撤销会话与仓库外凭证，再回退代码；`result_unknown` 记录不得重放。当前验收没有 OpenClaw、插件或会话可清理。

## 7. 已知问题与残余风险

以下均为冻结设计明确的外部门禁，不是本轮未修复的 P1/P2/P3 缺陷：

1. 当前主机未安装 OpenClaw 与官方插件，因此前置检查为 `NOT_READY`。
2. 专用测试 Bot/发送账号、测试接收账号、账号资格和当日官方条款尚未实况核验。
3. `context_token` 有效期、无近期互动时的主动发送、真实回执、重启恢复与二次验证尚未证明。
4. 3--7 天功能 PoC 和可选 30 天稳定性观察尚未执行。
5. iLink 仍未获批接入真实 outbox或成为生产渠道；PoC 成功也不会自动改变此结论。

## 8. 建议提交边界

本轮未创建 commit。建议按以下边界提交，便于独立审查和回滚：

1. `fix: prepare isolated iLink live PoC runtime gates`
   - `poc/ilink-gateway/.env.example`
   - `poc/ilink-gateway/package.json`
   - `poc/ilink-gateway/src/**`
   - `poc/ilink-gateway/test/gateway.test.ts`
2. `test: use current Shanghai time in notification retry fixture`
   - `server/test/phase3-independent-verifier.test.ts`
3. `docs: record Phase 5A live-readiness validation`
   - `docs/01-审计与设计/PHASE_5A_ILINK_OFFICIAL_COMPATIBILITY_REVIEW.md`
   - `docs/02-开发实现/PHASE_5A_ILINK_LIVE_READINESS_PATCH.md`
   - `docs/02-开发实现/CHANGELOG.md`
   - `docs/03-测试验证/PHASE_5A_ILINK_LIVE_READINESS_TEST_REPORT.md`
   - `docs/04-验收交付/PHASE_5A_ILINK_POC_LIVE_RUNBOOK.md`
   - 本验收报告

不得把 `/tmp` 验收目录、任何仓库外配置、state/session、凭证、二维码或日志加入提交。
