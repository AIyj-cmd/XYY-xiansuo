# 阶段五A：iLink 隔离 PoC Gateway 独立测试报告

> 测试日期：2026-07-31
> 测试角色：`test_verifier`（独立验证，未修改 PoC 或业务源码）
> 结论：**不允许进入验收阶段；存在 4 个 P1 与 3 个 P2，须在批准范围内修复并由本测试角色复测。**

## 1. 测试基线与差异归因

测试前基线：

```text
branch = poc/phase5a-ilink-gateway
HEAD   = eee7accf5ece3163eae5b3806cdb44685db54c0f
```

测试开始前已存在且归属于实施阶段的未提交差异：

- `poc/ilink-gateway/**`（独立 Gateway、测试与独立依赖）；
- `docs/01-审计与设计/PHASE_5A_ILINK_OFFICIAL_COMPATIBILITY_REVIEW.md`；
- `docs/02-开发实现/PHASE_5A_ILINK_POC_GATEWAY_IMPLEMENTATION.md`；
- `docs/04-验收交付/PHASE_5A_ILINK_POC_LIVE_RUNBOOK.md`；
- `docs/02-开发实现/CHANGELOG.md`。

本测试阶段只新增本报告，没有恢复、覆盖或清理上述差异。测试前后 `git diff --check` 均通过。

`server/data` 完整文件哈希在测试前后相同：

```text
app.db      c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3
app.db-shm  fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb
app.db-wal  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
leads.db    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
xiansuo.db  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

没有运行 iLink live、`gateway:send-synthetic` 的 iLink 路径、登录、二维码、扫码或真实消息发送；没有访问真实 iLink API。

## 2. 测试计划与覆盖范围

独立检查覆盖：HMAC 规范与签名、签名失败不污染 nonce、时钟窗口、防重放、速率限制、严格请求 schema、16 KiB 限制、固定合成消息策略、持久化幂等、Fake Adapter、live 默认关闭、业务隔离、健康/CLI 边界、官方 API 路径核验、配置解析和会话清理路径。

未覆盖且仍禁止：真实 iLink 登录、二维码、`to_user_id`/`context_token` 获取、外网发送、实际会话恢复及真实投递回执。这些属于后续独立实况 PoC 门禁，不是本轮测试失败的替代项。

## 3. 已执行命令与通过结果

| 命令/检查 | 结果 |
|---|---|
| `cd poc/ilink-gateway && npm run build` | 通过 |
| `cd poc/ilink-gateway && npm test` | 11/11 通过 |
| `cd poc/ilink-gateway && npm audit --omit=dev` | 0 vulnerabilities |
| 独立 HTTP 临时状态库检查：无效签名、未来时间、有效签名、速率限制 | 通过：401、401、200、429；无效签名后 nonce 行数为 0 |
| 独立持久化幂等/超时检查 | 发现 P2（见下） |
| 官方源码核验：`Tencent/openclaw-weixin/src/api/api.ts` | 发现 P1（端点与请求体不一致） |
| `cd server && npm run build && npm test` | 通过，121/121 |
| `cd app && npm run build:h5` | 通过 |
| 静态隔离检索（业务 DB、Worker、leads/follow-ups/AI、Hook/RPA/逆向依赖、迁移） | 未发现 PoC 工程对业务模块、`server/data`、迁移或被排除方案的引用 |
| `git diff --check` | 通过 |

PoC 当前 11 个自动化测试覆盖了部分基础路径，但未覆盖下列实际缺陷；不能仅以 11/11 作为放行依据。

## 4. 通过的安全与隔离项

- 请求签名 canonical 结构为 `METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nBODY_SHA256`；签名使用 `timingSafeEqual`。
- 无效 HMAC 在写入 nonce 前被拒绝：独立 SQLite 检查确认 `used_nonces` 仍为 0。
- 未来时间戳、重放 nonce、篡改 body、超大（17 KiB）请求和超速请求被拒绝。
- 严格 Zod schema 拒绝额外字段，单接收人和固定合成消息策略在 Adapter 前执行。
- 独立 SQLite state 保存接收人哈希而非明文；Gateway 默认仅允许 `127.0.0.1` 或 `::1`。
- iLink Adapter 在 `ILINK_POC_LIVE_ENABLED=false` 时未调用注入的 `fetch`，并返回 `ILINK_LIVE_DISABLED`；没有二维码或登录代码路径被执行。
- PoC 未导入业务 Worker、线索、跟进、AI 或业务数据库，未创建迁移 `007`，后端 121 项与 H5 构建无回归。

## 5. 阻断缺陷

### P1-1：真实运行环境的 `loadConfig()` 无法启动

**证据位置**：`poc/ilink-gateway/src/config.ts`。`configSchema` 使用 `.strict()` 并直接解析 `process.env`。

**最小复现**：

```bash
cd poc/ilink-gateway
node --input-type=module -e "import {loadConfig} from './dist/config.js'; loadConfig()"
```

**实际结果**：拒绝 `PATH`、`HOME` 等正常无关环境变量，报 `Unrecognized keys`。即使补齐 Gateway 的必需变量，正常进程环境仍包含这些键，`npm run start` 和 CLI 无法运行。

**预期结果**：仅提取/校验 `ILINK_*` 配置键；其他进程环境变量不得影响 Gateway 启动。

**建议修复**：先从 `process.env` 显式投影允许的 `ILINK_*` 键，再用严格 schema 校验该投影；保留对非法受管配置值的拒绝。

### P1-2：iLink live 端点和请求契约不符合当前官方源码

**证据位置**：`poc/ilink-gateway/src/adapters/ilink-adapter.ts`；官方 `Tencent/openclaw-weixin/src/api/api.ts` 的 `sendMessage`。

**实际结果**：实现请求 `new URL('sendmessage', baseUrl)`，官方端点为 `ilink/bot/sendmessage`。实现也未带官方 `base_info`，未提供官方 `iLink-App-Id` 和 `iLink-App-ClientVersion` 头。

**预期结果**：live 模式仅在实况门禁开启后，以官方当前协议精确构造 `POST ilink/bot/sendmessage`，包括官方要求的 `base_info` 与公共头；不猜测字段。

**影响**：即使未来授权 live，当前 Gateway 将打到错误路径或以不完整协议调用，不能用作受控 PoC。

### P1-3：`gateway:clear-session` 可删除 state 目录外的任意配置路径

**证据位置**：`poc/ilink-gateway/src/cli/clear-session.ts`。

**实际结果**：该 CLI 仅 `loadConfig()` 后对 `ILINK_POC_SESSION_FILE` 直接 `unlinkSync`，未调用 `ensurePrivateStateDirectory()`，不校验文件权限、常规文件类型、会话目录或是否位于受控 session/state 根目录。

**预期结果**：只允许删除受控 session 目录内、经 0600/常规文件/真实路径验证的会话文件；拒绝 state 根目录外、符号链接和任意配置路径。

**影响**：配置被误填或被低权限环境篡改时，维护命令可成为任意文件删除入口。

### P1-4：live 会话抽象不能由 session 文件独立工作

**证据位置**：`poc/ilink-gateway/src/config.ts`、`src/adapters/ilink-adapter.ts`。

**实际结果**：live 配置在构造 Adapter 前强制要求 `ILINK_POC_BOT_TOKEN` 和 `ILINK_POC_CONTEXT_TOKEN`，即使会话文件含 `botToken/contextToken` 也不能启动；这与“会话目录、加载与重启恢复边界”的实现目标冲突。

**预期结果**：明确选择一种受控来源（经权限检查的会话文件或单独 secret 注入），并仅在真正缺失时拒绝；不能同时宣称 session 可恢复又强制绕过它。

**影响**：后续实况 PoC 无法可靠验证会话持久化/重启行为。

### P2-1：Fake `duplicate` 结果被错误转成 `result_unknown`

**最小复现**：以 `GatewayService + FakeAdapter('duplicate')` 投递固定合成请求。

**实际结果**：`IdempotencyStore.finalize()` 将 `deduplicated` 写入 `deliveries.status`，但 SQLite CHECK 不允许该状态，异常随后被 `GatewayService` catch，返回 `result_unknown/ILINK_SEND_RESULT_UNKNOWN`。

**预期结果**：Fake duplicate 应以批准语义返回 `deduplicated`，且不得污染幂等记录或改写为结果未知。

### P2-2：Gateway 超时被错误转成 `result_unknown`

**最小复现**：`ILINK_POC_TIMEOUT_MS=1000`，`FakeAdapter('delay', 1200)`。

**实际结果**：Adapter 因 Abort 抛异常后，`GatewayService` 的宽泛 catch 返回 `result_unknown/ILINK_SEND_RESULT_UNKNOWN`。

**预期结果**：受控超时应为 `retryable_failure/ILINK_SEND_TIMEOUT`；仅发送已发出且结果无法确定时才可进入 `result_unknown`。

### P2-3：健康状态是固定占位值，不能用于实况门禁

**证据位置**：`poc/ilink-gateway/src/gateway-service.ts`。

**实际结果**：`recentSuccessAt` 始终为 `null`，`consecutiveFailureCount` 始终为 `0`，没有从持久状态或投递结果维护。

**预期结果**：健康与 session 状态应投影真实的最近成功时间和连续失败数（仍不暴露接收人、正文或凭证）。

### P2-4：官方随机 UIN 使用了 `Math.random()`，而非官方安全随机方式

**证据位置**：`poc/ilink-gateway/src/adapters/ilink-adapter.ts`。

**实际结果**：`X-WECHAT-UIN` 通过 `Math.random()` 生成。当前官方源码使用 `crypto.randomBytes(4).readUInt32BE(0)` 后再 base64。

**预期结果**：若该头保留，必须复用当前官方格式/密码学随机方式，并将其与官方协议复核记录一致。

## 6. 缺失自动化覆盖

需要在修复时新增或加强的测试：

- 用包含 `PATH`、`HOME` 等真实进程环境的 `loadConfig()` 启动测试；
- live 请求 mock fetch 的精确 URL、headers、`base_info` 与安全随机 UIN；
- session 文件唯一来源、权限、路径穿越/符号链接以及 `clear-session` 的目录约束；
- Gateway 层 Fake `duplicate`、超时、所有故障状态的持久化与 HTTP 映射；
- `recentSuccessAt` 与连续失败数跨 Gateway 重启的更新/安全投影；
- `ILINK_POC_LIVE_ENABLED=false` 时会话文件不被读取、无网络、无二维码的完整 CLI 覆盖。

## 7. 放行结论

**不允许进入 `acceptance_optimizer` 的无条件验收，也不允许进入真实账号实况 PoC。**

修复 P1-1 至 P1-4、P2-1 至 P2-4，并由独立测试复测 PoC 构建/测试、后端 121 项、H5 构建、依赖审计、`server/data` 哈希和禁止实况操作后，才可进入最终验收。当前 P3：0；当前 P2：4；当前 P1：4。

---

## 8. 修复后独立复测（2026-07-31）

实施方完成修复后，本测试角色未修改源码，仅重新读取差异、审查关键实现并独立执行复测。

### 8.1 原缺陷关闭结果

| 原问题 | 复测证据 | 结果 |
|---|---|---|
| P1-1 `process.env` 被 `.strict()` 拒绝 | `loadConfig()` 现只投影已知 `ILINK_*` 键；带 `PATH`/`HOME` 的真实进程环境并补齐必需 PoC 配置可启动；未知 `ILINK_UNSUPPORTED` 仍拒绝 | 已关闭 |
| P1-2 官方 live 请求契约 | mock fetch 断言精确 URL 为 `.../ilink/bot/sendmessage`；带 `base_info`、`iLink-App-Id`、`iLink-App-ClientVersion`、`AuthorizationType`、Bearer token 与密码学随机 UIN | 已关闭 |
| P1-3 `clear-session` 越界删除 | 会话固定为受控 `stateDir/session.json`；检查非符号链接目录、常规文件、0600 与真实路径；外部文件软链测试被拒绝且外部文件仍存在 | 已关闭 |
| P1-4 会话恢复语义冲突 | live 配置仅要求 API base URL 与 App ID；token/context/接收人只从受控、严格 schema 的 `session.json` 读取，缺失/过期正确映射到登录状态 | 已关闭 |
| P2-1 Fake duplicate 误变 `result_unknown` | `deduplicated` 在本地持久化时映射为安全的 `sent`，两次调用均返回 `deduplicated` | 已关闭 |
| P2-2 Abort timeout 误变 `result_unknown` | `FakeAdapter('delay', 1200)` 配合 1000 ms Gateway 超时，结果为 `retryable_failure/ILINK_SEND_TIMEOUT` | 已关闭 |
| P2-3 健康统计为占位值 | `recentSuccessAt` 与连续失败数已保存至独立 Gateway state；成功后有时间戳，离线失败后计数为 1；健康响应未暴露接收人或正文 | 已关闭 |
| P2-4 非安全 UIN 随机源 | 使用 `crypto.randomBytes(4).readUInt32BE(0)` 再 base64，与当前官方源码实现一致 | 已关闭 |

### 8.2 本次复测命令与结果

| 命令/检查 | 结果 |
|---|---|
| `cd poc/ilink-gateway && npm run build` | 通过 |
| `cd poc/ilink-gateway && npm test` | 21/21 通过（含配置、会话路径/软链/0600、官方请求 mock、duplicate、Abort timeout、健康计数新增覆盖） |
| `cd poc/ilink-gateway && npm audit --omit=dev` | 0 vulnerabilities |
| 带真实 `PATH`/`HOME` 的 `loadConfig()` 默认 `process.env` 调用 | 通过；无外网调用 |
| `gateway:health`、`gateway:session-status`（Fake 或 live=false） | 通过；仅临时独立 state，未调用 iLink 网络、未读真实凭证、未生成二维码 |
| `cd server && npm run build && npm test` | 通过，121/121 |
| `cd app && npm run build:h5` | 通过 |
| `git diff --check` | 通过 |
| 静态检索 | 未发现业务 DB、业务 Worker、DeepSeek、迁移、Hook/RPA/逆向依赖；唯一 `fetch` live 路径由 `ILINK_POC_LIVE_ENABLED=false` 默认拒绝，测试使用 mock 或 loopback HTTP |

`server/data` 的 `app.db`、`app.db-shm`、`app.db-wal`、`leads.db`、`xiansuo.db` SHA-256 在复测前后完全一致，未触及业务数据库。

### 8.3 复测限制与放行

本次仍没有进行 iLink live、登录、二维码、扫码、真实账号、真实消息或外网调用；这些继续是后续单独授权的实况 PoC 门禁，而非本阶段的遗漏。

**复测结论：允许进入 `acceptance_optimizer` 最终验收。当前 P1：0；P2：0；P3：0。**
