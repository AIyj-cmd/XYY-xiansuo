# 阶段五A：iLink 实况 PoC 就绪补丁独立测试报告（第四次复测）

> 复测日期：2026-08-01
> 结论：**P1 已关闭；仅允许针对既有后端测试时间夹具的受限 acceptance。人工扫码门禁仍不允许进入。**

## 基线与范围

- 分支：`fix/phase5a-ilink-live-readiness`；HEAD：`7a382a7510eabede02e1648acf4482f2ce24072e`。
- 测试开始前已有 PoC 实现、测试和文档差异；本测试阶段未覆盖、回滚或清理它们。本报告是测试阶段唯一可写的仓库文件。
- 测试前后 `server/data` SHA-256 清单一致，`git diff --check` 通过；无 `server/`、`app/`、`scripts/`、`deploy/` 实现差异或迁移 001--006 改动。
- 复测只使用 fake command runner/mock transport、静态审查和本机 live=false 前置检查。未安装 OpenClaw/插件，未调用真实 OpenClaw、腾讯网络、真实会话、二维码、登录或消息发送；未连接业务数据库、真实 outbox、DeepSeek 或 notification-worker。

## 已执行命令

| 命令/检查 | 结果 |
|---|---|
| `cd poc/ilink-gateway && npm run build` | 通过 |
| `cd poc/ilink-gateway && npm test` | 28/28 通过；均为 fake/mocks，含 provider `channelId` 成功 envelope |
| `cd poc/ilink-gateway && npm audit --omit=dev` | 通过，0 vulnerabilities |
| live=false、未设置 sessionDir 下 `gateway:prereq-check` | `NOT_READY / ILINK_OPENCLAW_NOT_INSTALLED`；使用仓库外派生离线目录，无安装 |
| 同条件 `gateway:official-session-status` | `unsupported / ILINK_OPENCLAW_NOT_INSTALLED`，未读取会话 |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | **失败**：121 项中 120 通过、1 项失败，P2-1 |
| `cd app && npm run build:h5` | 通过 |

## 已关闭项

- 每个 OpenClaw 子进程均覆盖继承的 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 到仓库外 `ILINK_POC_SESSION_DIR`；fake runner 验证 version、metadata、capabilities、status、login 和 send 均使用隔离值。
- `ret=0` 为 sent，非零 exit 但 stdout 带 raw 数值 `ret` 仍按明确错误分类；其他不可解释输出保持 unknown 并由同键幂等阻止再次发送。
- `ILINK_CONNECT_TIMEOUT_MS` 已移除，不再留下无效运维配置。
- 真实 Tencent metadata 常见 `minHostVersion: ">=2026.3.22"` 已在 fake runner 覆盖并正确 `READY`；歧义/冲突范围仍失败关闭。
- live=false 且缺少 `ILINK_POC_SESSION_DIR` 时，prereq 使用 `ILINK_POC_STATE_DIR/openclaw-offline` 的 0700、非符号链接派生目录，并覆盖父进程 OpenClaw 路径；本机无 OpenClaw 时正确报告 `ILINK_OPENCLAW_NOT_INSTALLED`。
- 现有离线覆盖继续包含登录显式确认、固定接收人/合成正文、显式幂等键、HMAC/nonce、目录权限、健康状态、deduplicated 与 unknown 抑制。
- `parseRuntimeConfirmation()` 现只把实际的 `channel` 字段作为插件标识校验；`channelId` 仅作 provider 目标标识的安全格式校验，不再要求等于 `openclaw-weixin`。复测 fixture `{ ok: true, result: { messageId: 'stable-provider-id', channelId: 'provider-target-id' } }` 得到 `sent`；错误 `channel` 和无/非法 `messageId` 仍失败关闭。因此此前 P1-1 已关闭。

## 阻塞项

### P2-1：后端回归的固定日期 TTL 夹具过期（不属于 PoC diff）

失败用例：`server/test/phase3-independent-verifier.test.ts:328`。夹具在 `2026-07-30 19:00:00` 创建任务，规则 `ttl_minutes=1440`，到期约为 `2026-07-31 19:00:00`；当前日期 2026-08-01。重试路由以真实 `nowDatetime()` 检查 `row.expires_at <= now`（[notification-admin.ts](../../server/src/routes/notification-admin.ts:99)），正确返回 409，因此 371 行原断言 200 失败。

**可由 acceptance 修复：可以。** 用户已明确限定为“不改业务源码/断言”的测试夹具处理；验收代理可仅在该测试中以当前 Asia/Shanghai 时钟派生 `updatedAt/claim/finish`，或通过现有测试注入点使用可控 clock。必须保留“过期任务不得人工重试”的生产门禁和断言，随后复跑单测及全量 121/121。不得修改 `server/src`、放宽 HTTP 200 断言或改变 TTL 业务规则。

## Acceptance gate

**允许进入受限 acceptance**，授权范围仅包括：

1. 修复 P2-1 的 `server/test/phase3-independent-verifier.test.ts` 时间夹具；不修改业务源码、生产配置、断言语义或迁移。
2. 重跑 PoC build/test/audit、后端单测与全量 121/121、H5 build、`server/data` 哈希和 `git diff --check`。
3. 继续禁止安装、登录、二维码、扫码、真实消息、真实 outbox/业务数据库/DeepSeek/Worker 接入。

完成后需达到 P1/P2/P3 均为 0，才可验收通过；人工扫码仍须单独授权。

## 验收复测补记（2026-08-01）

验收代理按上述唯一授权修复了固定日期夹具，未修改业务源码、TTL 规则或断言。受影响独立用例 19/19、后端全量 121/121、Gateway 28/28 均通过，Gateway 与后端构建、H5 构建通过，Gateway `npm audit --omit=dev` 为 0 vulnerabilities。`server/data` 前后 SHA-256 清单一致，`git diff --check` 通过。

本机 live=false 实际前置检查返回 `NOT_READY / ILINK_OPENCLAW_NOT_INSTALLED`，官方会话状态返回 `unsupported / ILINK_OPENCLAW_NOT_INSTALLED`。未安装或调用真实 OpenClaw、未访问腾讯网络、未登录、未生成二维码、未扫码、未发送消息，未连接业务数据库、outbox、DeepSeek 或 Worker。原 P2-1 已关闭；最终验收范围内 P1/P2/P3 均为 0。人工扫码、实况 PoC 和生产使用仍未获授权。
