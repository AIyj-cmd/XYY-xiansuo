# 技术债整改记录

日期：2026-08-02。范围仅为代码健康整改与隔离验证；**不构成生产发布授权**。

## 当前口径

| 范围 | 状态 | 口径 |
| --- | --- | --- |
| H5 | CURRENT | 唯一构建、发布和验收目标；深链刷新由后端 SPA fallback 托管。 |
| 单账号 OpenClaw | CURRENT RELEASE CANDIDATE，默认关闭 | 已完成真实验证；发布前仍须逐项通过既有生产门禁，不得自行启用。 |
| OpenClaw 多人绑定 / Direct iLink | NO-GO / RESEARCH ONLY | 仅失败 fork 与历史门禁研究；真实试点、发送和发布均未授权。 |
| DeepSeek / AI Scheduler | CANDIDATE，默认关闭 | 代码和离线配置存在，不得在无单独授权时启用或发送外部消息。 |
| 服务号候选 | CANDIDATE，未合入 | 独立候选分支，不属于当前制品；不含实现、凭据、二维码或发送授权。 |
| 企业微信、Hook、RPA、逆向、Windows 自动化 | NO-GO | 已取消或明确禁止，不是后续实现路径。 |
| Hermes | NOT STARTED / FUTURE | 未开始，未纳入本项目运行、部署或验收范围。 |

## 配置清单

敏感值只允许出现在仓库外私有文件或受控环境；表中不记录值。`required` 为进程实际启动所需条件，而非“建议”。

| name | process | default | sensitive | required | relation | enabled |
| --- | --- | --- | --- | --- | --- | --- |
| `JWT_SECRET` | API | 无 | 是 | 是 | API JWT；至少 32 字节 | CURRENT |
| `DB_PATH` | API / Worker / AI | 本地开发默认 | 是（数据） | 生产是 | 三进程必须指向同一受控数据库 | CURRENT |
| `ADMIN_INITIAL_*` | API | 用户名 `admin`、姓名“管理员” | 密码是 | 空生产库需要密码 | 仅 users 为空时读取 | CURRENT |
| `LEAD_POOL_CLAIM_ENABLED` | API / Worker | `false` | 否 | 否 | 服务端为公海认领唯一安全边界 | CURRENT / 默认关闭 |
| `NOTIFICATION_*_ENABLED` | API / Worker / AI | `false` | 否 | 否 | capture、worker、mock、scheduler 各自显式开关 | CURRENT / 默认关闭 |
| `DEEPSEEK_*`、`AI_*` | AI Scheduler | `DEEPSEEK_ENABLED=false` | API key 是 | 仅启用 Provider 时 | API/Worker 不传递 DeepSeek key | CANDIDATE / 默认关闭 |
| `OPENCLAW_CHANNEL_ENABLED` | API / Worker / AI | `false` | 否 | 否 | 还须通过单账号及 Gateway 门禁 | CURRENT RELEASE CANDIDATE / 默认关闭 |
| `OPENCLAW_GATEWAY_*` | Worker / AI | 本地回环、受限超时 | secret file 是 | 仅单账号 OpenClaw 候选启用时 | Worker 完整窗口大于 Gateway 窗口 | CURRENT RELEASE CANDIDATE / 默认关闭 |
| `ILINK_*`、`OPENCLAW_*_DIR/FILE` | Gateway | 回环、`ILINK_POC_LIVE_ENABLED=false` | state、map、secret 是 | 仅受控研究时 | 必须仓库外私有目录/文件 | RESEARCH ONLY / 默认关闭 |
| 服务号候选配置 | 无运行进程 | 无 | 是 | 否 | 尚未接入 API、Worker 或 Gateway | CANDIDATE / 未实现 |

私密文件校验仍以各启动路径的属主、普通文件、非链接与权限检查为准。跨包共享私密状态（例如 Gateway secret、OpenClaw state）尚不安全地自动化；后续如需共享，必须先形成单一受控运行时目录和最小权限设计，不能复制私密文件。

## 本轮结果与剩余风险

- H5 新增 Chromium 运行烟测：登录、列表、详情深链刷新、管理员转负责人、member UI/API 越权、关闭公海、401 清会话、403 保会话。
- Vite 保持 `5.2.8`：`@dcloudio/vite-plugin-uni` 对此版本有精确 peer 约束；审计修复要求不兼容的 Vite major，未使用 force、legacy peer deps 或 uni-app 大版本升级。开发服务器只监听 `127.0.0.1`，生产仅托管静态 H5；在兼容版 uni-app 升级设计获批前，**不得公网暴露开发服务器**。
- `npm audit --omit=dev` 仍报告 Vite 生产依赖链 high。CI 以临时、限期的 `--audit-level=critical` 风险门禁阻断 critical，同时完整输出 high；这不是“无风险”结论。该已接受的残余风险须在兼容版 uni-app/Vite 升级后取消豁免，最终风险级别由验收阶段裁定。
- 未改动迁移 `001`–`007`、数据库结构、公开 API、权限口径、Worker/Gateway/JWT 或 OpenClaw 单账号路径。

---

## 独立测试验证补充（2026-08-02）

### 结论

**修复后待复测：P2-2 已关闭；P2-1 已降为明确接受的残余依赖风险，最终级别交由验收阶段裁定。**

业务回归、H5 运行烟测、数据库迁移和 Gateway 离线回归均通过，且本轮整改未越过冻结的 OpenClaw/通知/权限边界。原始条件 FAIL 的 CI 空白检查缺失已修复；Vite high 因精确 peer 约束转为有期限、可见且 critical 仍阻断的风险门禁，不能误记为“无风险”或永久豁免。

整改后计数：**P1 = 0，未关闭 P2 = 0，接受的残余依赖风险 = 1**。

### 环境、范围与测试前基线

- 验证 worktree：`/tmp/xiansuo-project-health`，分支 `chore/project-health-remediation-v1`，开始/结束提交均为 `a6a38a35ce30cd0ea8d96813a5d07987dc0a6171`；比较基线 `b4a28c4`，整改提交为 `070223b`、`5926dcb`、`8df9134`、`a6a38a3`。
- 归档审查对象：主 worktree 提交 `archive/openclaw-multi-peer-research-20260802@20f4e5e`。
- 开始前 `git status --short`、`git diff --name-only` 均为空；未恢复、覆盖或清理任何既有用户改动。
- 仅验证 H5；未构建微信小程序，未访问生产数据库，未启动 OpenClaw/DeepSeek、未发送微信、未推送/合并/部署。
- 测试计划：归档与敏感内容静态审查；整改边界与数据库对象哈希比对；三端全新安装、构建和测试；Playwright 实际 H5/API 权限烟测；CI、依赖审计、临时文件与进程复查。

### 已执行命令与结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `git diff --exit-code b4a28c4..HEAD -- server/src/db.ts` | PASS；退出码 0 | 基线与当前 SHA-256 均为 `903767a7daaa99877cba85d4ee13ef0ec4e1480814c2584a0b8cb96fc666ba19`；`MIGRATIONS` 中 001–007 均在该同一字节对象内。 |
| 稳定边界 `git diff --exit-code`（Worker、Gateway、通知、auth、通知路由） | PASS；退出码 0 | `server/src/notification-worker.ts`、`server/src/notifications/**`、`server/src/services/openclaw-notification-channel.ts`、`poc/ilink-gateway/**`、认证/通知路由未变。 |
| `cd server && npm ci && npm run build && npm test` | PASS | 全新安装 179 包；构建通过；**146/146** 通过、0 failed/skipped。 |
| `cd poc/ilink-gateway && npm ci && npm run build && npm test` | PASS | 全新安装 7 包；构建通过；**53/53** 通过、0 failed/skipped。 |
| `cd app && npm ci && npm run build:h5 && npm run test:h5 && npm run test:e2e` | PASS | 全新安装 468 包；H5 构建通过（执行两次：单独构建及 `test:h5`）；Playwright **3/3** 通过。 |
| `git diff --check b4a28c4..HEAD` 及 worktree `git diff --check` | PASS；退出码 0 | 无空白错误。 |
| `npm audit --omit=dev`（server/gateway） | PASS | 两处均为 `found 0 vulnerabilities`。 |
| `cd app && npm audit --omit=dev` | FAIL，见 P2-1 | 1 个 Vite 高危项；普通 `npm ci` 还报告总计 1 moderate + 1 high。 |

### 功能、权限与恢复路径

- H5 真实 Chromium 运行测试通过（证据：[app/test/h5-runtime.spec.ts](../../app/test/h5-runtime.spec.ts)）：管理员登录、列表显示、详情深链刷新（SPA fallback）、负责人转移；member 无管理员 UI、直接请求管理员 API 得到 403 且本地会话不丢失、负责人转移入口隐藏、公海待认领关闭；非法 token 得到 401、清 token 并返回登录页。
- 端口由 `net.listen(0)` 动态获取，SQLite 位于 `mkdtemp('/tmp/xiansuo-h5-runtime-*')` 的全新目录；使用 `expect.poll`，未发现 `sleep`、`waitForTimeout` 或固定延时。测试的 `afterAll` 发送 SIGTERM 并递归删除该临时目录。复跑后未发现匹配临时目录或测试服务进程。
- Server 现有集成测试额外覆盖缺失/错误/过期 token 的 401、member 访问管理员接口的 403、角色即时升降级和停用、负责人单条/批量变更的全有或全无、公海重复认领幂等、迁移校验和/事务回滚、outbox 的 channel 范围和 `result_unknown` 终态。
- `routes/leads.ts` 的查询/详情 SQL 被移动到 [server/src/services/lead-query-service.ts](../../server/src/services/lead-query-service.ts)，静态逐项比对确认筛选、排序、分页、favorite 和详情投影不变；负责人及跟进派生仅为对既有原子实现的再导出。前端分页重置、追加列表和 `hasMore` 逻辑也保持原行为；未发现此次重构引入新的去重分支。

### 归档、边界与安全审查

- `20f4e5e` 新增/修改内容为源码、测试、锁文件/配置样例和脱敏文档；未发现新增 `.db`/SQLite、状态库、会话、日志、二维码/图片、私钥/证书或真实 `.env` 文件。树内静态 PNG 是基线已有文件，非归档提交新增内容。
- 关键词扫描会命中 `context_token`、`target`、`secret` 等**字段名**，但均在第三方源码、测试固定假值或文档 `<...>` 占位符中；未发现可用 token、OpenID、完整 target、密钥或状态记录。这个结论是仓库静态扫描结论，不替代外部凭据轮换与历史 Git 托管平台扫描。
- [OPENCLAW_MULTI_PEER_FORK_RUNBOOK.md](../04-验收交付/OPENCLAW_MULTI_PEER_FORK_RUNBOOK.md) 第 3 行明确标记 `RESEARCH ONLY / REAL PILOT NO-GO / NOT FOR RELEASE`。
- 整改差异共 18 个文件，未含服务号候选、多人 fork、OpenClaw/iLink/Gateway/recipient/binding 改动。数据库、API 认证授权、通知事务/outbox、Worker 与 Gateway 的稳定边界均保持基线字节或无差异。
- [app/vite.config.ts](../../app/vite.config.ts) 保持 Vite `host: 127.0.0.1`、`strictPort: true`、`cors: false`；生产由 [server/src/index.ts](../../server/src/index.ts) 托管静态 H5，并非 Vite dev server。未升级 Vite：`@dcloudio/vite-plugin-uni` 对 `5.2.8` 有精确 peer 约束；未经批准不使用 force、legacy peer deps 或 uni-app 大版本升级。

### 失败项、严重级别与最小复现

| ID | 级别 | 最小复现 | 预期 / 实际 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | 已接受残余风险 | `cd app && npm audit --omit=dev` | Vite `<=6.4.2` 的 **1 high** 仍可见；CI 先输出完整审计，再以 `npm audit --omit=dev --audit-level=critical` 阻断 critical。豁免只限当前精确 peer 约束，不能宣称无风险。 | 在兼容版 uni-app/Vite 升级设计获批后移除豁免并复验；此前 dev server 仅限 `127.0.0.1`，不得公网暴露。 |
| P2-2 | 已关闭 | 审阅 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | CI 已增加 `git diff --check`。 | 保持该检查并由 CI 实况复测。 |

### 未覆盖范围与残余风险

- 未接触真实微信/OpenClaw、DeepSeek、生产 DB、真实服务号候选、外部身份或支付；这些均不在本次授权范围，不能由离线假适配器回归替代。
- H5 运行烟测覆盖核心登录/权限/深链/负责人变更，但未做全部筛选组合、导入导出、上传、并发 UI 连点或跨浏览器矩阵；Server/Gateway 现有自动测试覆盖关键并发、幂等和事务语义。
- App 安装阶段存在 deprecated 包警告及 allow-scripts 待批准提示；未擅自批准脚本或改变依赖。
- 发现的 DeepSeek/litellm 进程 PID 664666、664681、666909 启动于本次验证前（23:13/23:15），不是本测试启动，未触碰；本测试相关 H5/API 进程已退出。

### 测试阶段文件变化与结束状态

- 结束前 `git status --short` 与 `git diff --name-only` 仍为空（在本报告写入前）；`server/data` 无当前或受跟踪数据库文件，故无可比数据哈希。`node_modules`、`dist` 等安装/构建产物均被忽略且未形成 Git 差异。
- 本阶段唯一受控写入为本报告补充；未改动 `app/src`、`server/src`、`scripts` 或 `deploy` 的业务/部署实现。
- 后续验收应复测 CI 的 critical 风险门禁与 `git diff --check`；不得将已接受的 Vite high 写成无风险或永久豁免。

---

## 修复复测结论（提交 `9b05663`，2026-08-02）

### 最终判定

**PASS（可带已接受残余风险进入验收；不构成生产发布授权）。**

严重级别：**P1 = 0，未关闭 P2 = 0，P3 = 0**。残余风险 `R-1`：Vite `<=6.4.2` 的 1 个 high 仍存在，已由本次明确的临时 critical 门禁保持可见，不能称为已修复或无风险。

### 复测基线与范围

- 复测对象：`9b0566318dc4a80b6b3e36e4cb91744edc2654ab`，分支 `chore/project-health-remediation-v1`；复测开始前 worktree 干净。
- 该提交仅改动 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)、[docs/README.md](../README.md) 和本报告；`server/src`、`server/test`、Gateway 源码/测试/锁文件及 H5 源码/测试/锁文件相对 `a6a38a3` 均无差异。`server/src/db.ts` 相对 `a6a38a3` 及 `b4a28c4` 仍为字节一致。

### CI 门禁复测

| 检查 | 实际结果 | 判定 |
| --- | --- | --- |
| `npm audit --omit=dev` | 输出 Vite `<=6.4.2` 的 **1 high**，退出码 **1**。 | high 未被伪装消失。 |
| `npm audit --omit=dev --audit-level=critical` | 再次输出同一 high，退出码 **0**（当前无 critical）。 | CI 会阻断 future critical，同时保留 high 审计输出；与 YAML 的两段式临时门禁一致。 |
| CI YAML | 仍采用普通 `npm ci`，覆盖 Server 构建/测试、Gateway 构建/测试、H5 构建/E2E；新增末尾 `git diff --check`。 | PASS；原 P2-2 已关闭。 |
| `git diff --check b4a28c4..HEAD` 与 worktree `git diff --check` | 均退出 0。 | PASS。 |

`|| true` 只位于第一条“完整展示 audit”命令；第二条 critical 门禁未忽略退出码。因此网络/registry 等导致第二条审计失败仍会使 CI 失败，且 high 同时出现在两次日志中。

### H5 复测与未改范围确认

- 在 `app` 重新执行 `npm ci && npm run build:h5 && npm run test:h5 && npm run test:e2e`，命令成功；独立复跑 `npm run test:e2e` 为 **3/3** 通过（登录/列表/详情深链/负责人变更、member 403 与会话保留/公海关闭、401 清会话）。测试临时 SQLite/服务进程已清理。
- Server 与 Gateway 未改动，沿用前次同字节对象的全量结果：Server **146/146**、Gateway **53/53**；本次以源码、测试及锁文件无差异和 `db.ts` 双基线字节一致复核，未做无必要重复执行。
- 文档口径与代码核对通过：迁移为 001–007；单账号 OpenClaw 为默认关闭的 release candidate；多人绑定/Direct iLink 仍为 RESEARCH ONLY/NO-GO；DeepSeek/AI Scheduler 默认关闭；服务号候选未合入当前制品；Hermes 未开始。`vite.config.ts` 继续仅监听 `127.0.0.1`，生产由后端托管 H5 静态制品。

### 进入验收的条件与本阶段变更

- 验收可在保留 `R-1` 的前提下继续：不得公网暴露 Vite dev server；兼容的 uni-app/Vite 升级获批后必须移除该临时豁免并再次运行完整 audit/CI。
- 本次复测写入前后，除本报告外无 Git 变更；未修改业务源码、部署实现、数据库或测试行为。
