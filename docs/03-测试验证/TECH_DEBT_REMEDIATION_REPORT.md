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
- `routes/leads.ts` 的查询/详情 SQL 被移动到 [server/src/services/lead-query-service.ts](../../server/src/services/lead-query-service.ts)，静态逐项比对确认筛选、排序、分页、favorite 和详情投影不变；该验证对象当时为负责人及跟进派生增加了再导出入口，最终验收已删除这两个无价值间接层，见下方最终结论。前端分页重置、追加列表和 `hasMore` 逻辑也保持原行为；未发现此次重构引入新的去重分支。

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

---

## 最终验收结论（2026-08-03）

### 判定与交付范围

**PASS：技术债清理与稳定基线收口达到本轮完成标准，可进入合并评审；不构成生产发布、外部发送或功能开关启用授权。**

最终严重级别为 **P1 = 0、P2 = 0、P3 = 0**。保留已接受残余风险 `R-1`：Vite `5.2.8` 位于 `<=6.4.2` 的 high 公告范围；普通生产依赖审计退出 1，临时 critical 门禁退出 0。该风险仍可见且未伪装为已修复。

比较基线为 `b4a28c4`，本轮提交链为 `070223b`、`5926dcb`、`8df9134`、`a6a38a3`、`9b05663`、`70deb9f`、`ffc6539`；归档分支固定为 `archive/openclaw-multi-peer-research-20260802@20f4e5e`。验收只检查并修改 `/tmp/xiansuo-project-health`，未推送、合并、部署，未访问生产数据库或外网 Provider，未执行真实微信、OpenClaw、DeepSeek 或服务号操作。

### 完成标准核对

| 验收项 | 结论 | 最终证据 |
| --- | --- | --- |
| 多人研究归档 | PASS | 归档 ref 精确指向 `20f4e5e`；仅作 `RESEARCH ONLY / NO-GO`，未进入当前 17 文件整改差异。归档相对基线未新增数据库、WAL/SHM、真实 `.env`、密钥/证书、日志、二维码或状态/会话文件。 |
| H5 运行测试 | PASS | 3 条真实 Chromium 烟测覆盖登录、列表、详情深链刷新、负责人变更、member UI/API 403、公海关闭、401/403 会话语义；动态端口和临时 SQLite 均已清理。 |
| 共享前端逻辑 | PASS | 两个列表页共同使用 `lead-display.ts` 和 `useLeadListState.ts`；新增 5 条直接测试覆盖日期/逾期/意向、分页重置、筛选重置与 `hasMore`，不访问网络或生产数据。Playwright 套件实际为 **8/8**。 |
| leads 路由第一层拆分 | PASS | 仅新增有实际职责的 `lead-query-service.ts`；查询/详情 SQL 与响应投影保持一致。负责人和跟进派生继续直接复用基线已有的 `lead-owner.ts`、`follow-up-derived.ts`；验收删除两个只有两行再导出的空壳服务，避免为拆分制造新技术债。 |
| CI、配置与文档 | PASS | CI 使用普通 `npm ci`，覆盖 Server、Gateway、H5 构建及 8 条 Playwright 测试；完整展示 high、阻断 critical，并执行 `git diff --check`。配置清单区分 CURRENT/CANDIDATE/RESEARCH，敏感值未写入文档。 |
| 数据库与稳定边界 | PASS | `server/src/db.ts` 的基线、HEAD 和工作区 SHA-256 均为 `903767a7daaa99877cba85d4ee13ef0ec4e1480814c2584a0b8cb96fc666ba19`，迁移仍为 `001`–`007`；`server/data` 不存在文件。Worker、Gateway、认证、通知/outbox 与 OpenClaw channel 相对基线无差异。 |
| 工作区卫生 | PASS | `git diff --check b4a28c4..HEAD` 与工作区检查均通过；测试临时目录和本轮 H5/API/Playwright 进程均已退出。最终报告提交后再次确认 worktree 干净。 |

### 最终验证结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npm run build && npm test` | PASS；TypeScript 构建通过，**146/146**，0 failed/skipped。 |
| `cd poc/ilink-gateway && npm ci && npm run build && npm test` | PASS；全新安装、TypeScript 构建通过，**53/53**，0 failed/skipped；生产依赖审计 0 漏洞。 |
| `cd app && npm ci && npm run build:h5 && npm run test:h5 && npm run test:e2e` | PASS；全新安装 468 包；H5 构建通过；`test:h5` 与独立 `test:e2e` 的套件均为 **8/8**。 |
| `cd app && npm audit --omit=dev` | 预期非零；完整报告 **1 high**（Vite），即 `R-1`。 |
| `cd app && npm audit --omit=dev --audit-level=critical` | PASS；退出 0，仍打印同一 high，当前无 critical。 |
| `cd server && npm audit --omit=dev` | PASS；0 漏洞。 |
| 哈希、稳定边界、空白、临时文件与进程复查 | PASS；迁移字节一致，受保护边界无差异；本轮 H5 临时资源自动清理，Server 全量测试遗留的 7 个基线测试夹具目录经精确核对后移入系统回收站，本轮相关进程与 `/tmp` 目录最终无残留。 |

### 当前事实、上线与回滚口径

- 单账号 OpenClaw 已完成真实验证，但只是**默认关闭**的当前发布候选；启用前仍须走既有生产门禁。
- OpenClaw 多人绑定与 Direct iLink 是 **NO-GO / RESEARCH ONLY**；服务号是未合入当前制品的独立候选；Hermes 为 **NOT STARTED**。
- 本轮代码可进入合并评审；系统生产上线仍是**有条件 GO**：不得公网暴露 Vite dev server，所有外部消息/AI 开关保持关闭，并须另行完成生产备份恢复、发布制品和真实环境门禁。本报告不授权发布。
- 本轮没有迁移或数据写入，回滚不需要数据库降级。若合并后出现整改引入的回归，可回退本轮提交链至 `b4a28c4` 并重新构建 H5/Server；回滚前后保持全部外部渠道开关关闭，并复测登录、深链、权限和负责人变更。不得用数据库回滚掩盖应用问题。
- 监控至少关注 H5 深链静态 404、API 401/403/5xx、负责人变更失败、CI audit critical、Vite dev server 监听地址，以及测试/构建失败；任何 critical 依赖告警或 dev server 非回环监听都应阻断发布。

### 残余风险与后续建议

- `R-1`（已接受）：Vite high 只能在兼容 uni-app/Vite 升级设计获批并完整复验后关闭；不得使用 `force`、`--legacy-peer-deps` 或未批准的大版本升级绕过。
- H5 烟测不是全量 UI 矩阵，尚未覆盖所有筛选组合、导入导出、上传、并发点击及跨浏览器；关键事务、权限、幂等已有 Server/Gateway 自动测试兜底。
- 安装仍提示 deprecated/allow-scripts 待审项；本轮未擅自批准脚本或新增生产依赖。
- 信息项 `I-1`：5 个基线既有 Server 测试文件使用 `mkdtempSync` 后没有自动删除目录，本次运行生成 7 个目录并已由验收阶段精确清理；这些测试文件相对 `b4a28c4` 无差异，不是本轮回归，也不影响运行制品，故不增加 P3，但后续独立测试卫生任务应补上 `after`/`finally` 清理。
- **Hermes 适合在本稳定基线合并冻结后启动独立的只读审计与技术设计，不适合直接在当前整改分支开始实现、接入或部署。** 开始条件是单独明确业务目标、数据/权限/外部通信边界、退出条件和回滚方案；不得把 Hermes 与本轮验收捆绑上线。

---

## 发布分支合并独立验证（`c838ea8`，2026-08-03）

**PASS：允许进入后续验收，不构成生产部署或外部渠道启用授权。** P1 = 0，P2 = 0，P3 = 0；`R-1` 仍为未修复的 Vite `1 high`，不得记为已修复。

- 起止工作区均干净；`c838ea8` 是以 `b4a28c4`、`b15cc6a` 为双父的 `--no-ff` 合并，整改链 `070223b` 至 `b15cc6a` 完整保留。相对 `b4a28c4` 恰 17 个批准文件；服务号提交 `51c1e3d`/`a9da20f`、多人归档 `20f4e5e` 均非 HEAD 祖先，且 Worker、Gateway、认证、通知、迁移、`server/src/db.ts`、部署和脚本无差异。
- `server/src/db.ts` 基线/HEAD SHA-256 均为 `903767a7daaa99877cba85d4ee13ef0ec4e1480814c2584a0b8cb96fc666ba19`；001–007 与 checksum 未变，Server 迁移矩阵测试通过。`server/data` 的 8 个现存文件 SHA-256 前后一致。
- 实测：Server `npm ci && npm run build && npm test` 为 **146/146**，生产审计 0 漏洞；Gateway 同流程为 **53/53**，生产审计 0 漏洞；H5 `npm ci && npm run build:h5 && npm run test:h5 && npm run test:e2e` 通过，Playwright **8/8**（深链、admin/member、401/403、负责人变更、公海关闭）。
- H5 普通 `npm audit --omit=dev` 如预期报 **1 high**（退出 1）；临时 critical 门禁退出 0 且仍输出同一 high。`git diff --check b4a28c4..HEAD` 与工作区检查均通过。
- 本次未启动 OpenClaw、DeepSeek、AI Scheduler、微信或生产 DB；进程检查仅见测试开始前已存在的本机 DeepSeek/litellm。测试产生的安装/构建产物均被忽略；唯一受控变更为本报告本节。
