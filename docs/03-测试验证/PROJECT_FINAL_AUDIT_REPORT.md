# XYY-xiansuo 项目收尾、功能健康与技术债审计报告

> **最新状态（2026-08-09）：** 第 1–13 节保留整改前的首次审计与失败证据；整改后的当前结论以第 14 节为准：P1=0、P2=0、P3=0，合并评审 GO，生产发布与 Hermes 真实启用仍未授权。

## 1. 审计结论

审计日期：2026-08-09

审计分支：`feature/hermes-per-user-qr-binding`

审计基线：`615e5dd457cbdf064544bbe26aea955f34ef0dc9`

直接结论：**存在明显技术债但仍可维护。**

当前核心代码可以构建，Server、Gateway、Hermes overlay 和 H5 浏览器回归最终共 **266/266** 通过；迁移 001–009 的离线矩阵完整，`server/data` 前后哈希一致。在已执行的离线 Fake/Mock 范围内，未发现数据库损坏、Hermes 跨用户错误路由、真实渠道误调用或核心状态机回归。

当前分支确认 **2 项运行时/契约发布阻断（P1）**、**2 项发布前安全问题（P2）** 和 **1 项测试稳定性问题（P3）**。此外还有 **1 项 Hermes 部署硬门禁（D-1）**、Server 生产依赖审计/CI 门禁、App 已知依赖风险和生产迁移演练门禁。独立测试报告第 37 节最初把公司级工作台可见性和 D-1 一并计入 4 个 P1；用户随后明确确认公司级工作台/导出属于接受的产品权限口径，因此本报告不再将其计为缺陷，同时继续把“代码运行缺陷”和“尚未形成部署单元”分开统计。

因此：

- 继续本地功能测试：可以。
- 合并为发布候选：NO-GO；Server 依赖审计会令当前 CI 失败。
- 部署并启用 Hermes：NO-GO；同时受 P1-1、P1-2 和 D-1 阻断。
- 修复 2 项 P1、处置 Server CI 门禁并完成对应回归后，才可进入合并评审；D-1 必须在任何 Hermes 部署前关闭，不能用代码测试通过替代。

本轮只审计、测试和记录问题，没有修改产品源码、迁移、依赖、运行配置或业务数据。

## 2. 审计范围

覆盖：

- H5 登录、权限行为、主要页面、深层路由、Hermes 绑定与解绑页面；
- Fastify API、JWT、角色与数据隔离、导入导出、上传和响应头；
- 线索、跟进、负责人变更、notification outbox 与 worker；
- iLink Gateway、Hermes account manager/overlay 和跨系统失败语义；
- SQLite 迁移 001–009、checksum、回滚故障注入、完整性与外键；
- npm 依赖、构建、PM2/部署脚本、环境变量和文档一致性；
- 大文件、重复逻辑、遗留分支和测试稳定性。

未执行：

- 真实微信发送、扫码或重新绑定；
- 真实 DeepSeek 调用；
- 生产数据库访问、备份、迁移或恢复；
- 生产部署、PM2/Nginx 重启；
- 服务号分支或历史多人研究分支合并。

## 3. 实际验证结果

| 范围 | 结果 |
| --- | --- |
| Server `npm ci` / build / test | PASS，163/163 |
| iLink Gateway `npm ci` / build / test | 最终 PASS，59/59；首次 58/59，见 P3-1 |
| Hermes overlay `./run-tests.sh` | PASS，30/30 |
| H5 `npm ci` / `build:h5` | PASS |
| H5 Playwright | PASS，14/14 |
| 自动化最终合计 | PASS，266/266 |
| 迁移 001–009 | fresh、升级、重复、checksum 冲突、失败回滚均 PASS |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 空结果 |
| `git diff --check` | PASS |
| `server/data` | 测试前后 SHA-256 一致 |
| Gateway 生产依赖审计 | 0 vulnerability |
| Server 生产依赖审计 | FAIL，3 high |
| App 生产依赖审计 | FAIL，2 high；当前 CI 仅 critical 阻断 |
| App 完整依赖审计 | FAIL，2 high + 1 moderate |

详细命令、最小复现和迁移 ledger 见 [TEST_REPORT.md](./TEST_REPORT.md) 第 37 节。

## 4. 前端健康审计

### 已通过

- 前端业务请求统一经过 `app/src/utils/request.ts`，未发现页面直接使用 `fetch` 或 axios。
- H5 普通 `npm ci`、生产构建和 14 条 Playwright 测试通过。
- 登录页、管理员/成员登录、401/403、线索主要页面、深层路由、Hermes QR/确认/解绑交互均有运行级覆盖。
- 二维码、token、target、accountRef 等敏感值未进入 Git 或构建配置。
- Hermes 已绑定状态只显示“解除机器人”，不会继续显示生成二维码入口。

### 问题

#### P1-1：Hermes 关闭时仍显示 H5 入口

`HERMES_BINDING_ENABLED=false` 时，“我的”页面仍展示“微信通知绑定”；进入页面仍可看到“生成登录二维码”，直到点击后才由 API 409 拒绝。

影响：关闭态前后端契约不一致，用户会进入一个注定失败的流程；也违反当前 README 的 fail-closed 口径。此项不会绕过服务端开关，也不会真实创建二维码，但属于 Hermes 启用/发布前的明确阻断。

建议：由认证后的 capability/status API 返回运行时 enabled 状态；菜单、深链页面和创建按钮均按服务端能力关闭，不能只依赖编译期变量。

#### T-1：前端超大页面仍存在

- `app/src/pages/leads/list.vue` 约 1150 行；
- `app/src/pages/leads/detail.vue` 约 890 行；
- `app/src/pages/pool/index.vue` 约 614 行。

现有测试证明它们当前可工作，但页面同时承担状态、格式化、请求编排和视图，后续改动容易扩大回归面。建议后续只按真实改动热点继续提取 composable/展示组件，不做一次性重写。

## 5. 后端、权限与数据隔离审计

### 已通过

- JWT 只保存 user id；认证中间件每次从数据库重载用户状态和角色，因此账号停用、删除和角色变更能够即时生效。
- 管理员接口具有服务端权限校验，不依赖 H5 隐藏按钮。
- 普通线索导出 `/api/export` 已按 member 的 `owner_id` 过滤，并排除软删除数据。
- 负责人变更、outbox 生成、绑定代次、用户停用、解绑与待发送任务取消的事务测试通过。
- Hermes HMAC、nonce、activationId、generation、accountRef、target fingerprint 和 post-TTL active callback 回归通过。

### 问题

#### 已接受的产品口径：普通成员可查看公司级工作台与工作台导出

隔离数据库最小复现确认：member 请求 `/api/dashboard/summary` 能看到其他负责人线索的手机号；`/api/export/dashboard` 也返回公司级 XLSX。相关 SQL 没有按 `request.user.id` 过滤。

该行为与 README 中“普通用户只能导出自己负责的线索”的原有文字口径冲突；用户已于 2026-08-09 明确确认这属于可接受的公司级工作台权限，不要求按 owner 隔离，因此不再计入 P1/P2/P3，也不要求修改当前 API。

后续维护要求：更新项目权限说明，明确区分普通线索导出与公司级工作台导出，避免未来开发者依据旧文档误改权限。若将来产品口径再次改为成员数据隔离，需要重新进行权限设计和 XLSX 内容级测试。

#### P2-1：修改密码后旧 JWT 继续有效

实测 member 修改密码成功后，旧 token 仍可请求 `/api/users/me`。账号停用和角色变化虽然实时生效，但密码重置没有 session/token version。

建议：在 users 增加受控的 token/session version，签发 JWT 时携带并在每次认证时比对；用户改密和管理员重置密码时事务内递增。该改动涉及迁移和认证，应单独按高风险流程实施。

#### P2-2：浏览器基础安全响应头缺失

隔离 API 响应未发现 CSP、`X-Content-Type-Options`、frame 防护和 `Referrer-Policy`。上传文件又通过 `/uploads/` 公开静态托管，缺少 `nosniff` 会放大错误 MIME 的风险。

建议：结合现有 H5 资源需求设计 CSP，并补 `nosniff`、frame、Referrer-Policy 和 Permissions-Policy；对 API、H5 和上传响应分别回归。

#### 加固观察：上传内容识别不足

上传接口已有认证、10 MB 限制、MIME allowlist 和随机文件名，但只信任客户端 mimetype，未校验文件魔数或真实解码结果，也没有明确的用户配额与清理策略。本轮没有写入 uploads 做攻击性测试，因此暂不定为已复现 P2，建议与安全响应头一起加固。

## 6. 通知、Worker 与 Hermes 审计

### 已通过

- `owner_changed` 详细消息、手机号脱敏、结构清理和受控长度测试通过。
- outbox、lease、幂等、单次调用、`result_unknown` 不重试语义未回归。
- Worker 在发送前核验 Hermes binding generation/accountRef；解绑、停用或重绑后的旧任务不能继续发送。
- Hermes capture 仅识别精确确认命令或刷新已绑定 peer 的 context，不调用 Agent、AI、自动回复、typing 或媒体能力。
- Gateway 和 account manager 与业务数据库保持边界隔离。

### 问题

#### P1-2：通知规则允许创建 Worker 永远无法处理的 Hermes 任务

最小复现：管理员可把 `daily_report` 启用为 `channel_order=['hermes']`，API 返回 200；任务随后以 pending 入队，但没有 Hermes binding generation/accountRef。Worker 领取后终态失败：`HERMES_BINDING_GENERATION_INVALID`。

没有发生网络调用或误发，但会产生注定失败的任务。根因是管理 API、AI event service 和 worker 使用了三份不一致的渠道能力判断。

建议：建立唯一的“事件 × 渠道”能力矩阵并由规则保存、事件生成和 worker 共用。当前 Hermes 只能允许 `owner_changed`，AI 摘要必须在保存规则及入队前 fail-closed。

#### D-1：Hermes 部署服务链尚未成为可部署单元

当前 `deploy/deploy.sh` 不包含 `poc/hermes-weixin-transport/`；也没有完整的 38116 Gateway、38117 account manager PM2/systemd 单元、依赖顺序、readiness、日志轮转和回滚链。现有脚本主要部署 API/H5，并刻意让真实 worker/Gateway 保持关闭。

影响：离线测试已经验证相关代码路径，但仓库内尚不能可靠复现测试服务器/生产部署。此项是部署门禁，不是现有业务逻辑失效。

建议：单独形成 Hermes manager 和 Gateway 服务单元；固定 Python/上游依赖；只监听 loopback；敏感文件 0600、目录 0700；增加 health/readiness、启动顺序、停止与回滚演练。完成前不得打开真实 Hermes 规则。

#### P3-1：Gateway 超时子进程测试存在一次竞态

Gateway 全量测试首次在等待 `timeout.pid` 时出现 ENOENT（58/59），完整重跑为 59/59。实现结果未发现错误，但测试依赖子进程写文件的时序，存在偶发不稳定。

建议：让测试显式等待 PID 文件/子进程状态可观察后再断言，不使用调度时机作为隐含同步。

## 7. 数据库与迁移审计

当前仓库实际迁移为 001–009：

1. 001 基线 schema；
2. 002 legacy leads/follow-ups 对齐；
3. 003 负责人转移审计与跟进派生；
4. 004 通知规则和可靠 outbox；
5. 005 AI scheduler 审计与规则初始化；
6. 006 provider latency；
7. 007 OpenClaw channel；
8. 008 Hermes 多用户 opaque binding 与 delivery generation；
9. 009 每用户独立 Hermes QR account reference。

离线验证：fresh、旧版本升级、重复执行、checksum 冲突、故障回滚、索引/trigger 恢复、历史数据保持、完整性和外键均通过。001–009 ledger checksum 与当前代码一致。

残余门禁：迁移是 forward-only；尚未在真实生产数据的一致性副本上完成 008→009 迁移、锁等待、耗时和恢复演练。因此不能把自动化通过等同于生产迁移已批准。

## 8. 依赖与构建健康

### Server

`npm audit --omit=dev` 报 3 个 high：

- `brace-expansion`（通过 `minimatch`）；
- `minimatch`；
- `fast-uri`。

均为间接生产依赖，npm 显示存在修复版本。当前 CI 无豁免执行 Server `npm audit --omit=dev`，因此会直接导致合并检查失败；这是独立于 P1/P2/P3 的依赖/CI 门禁。应优先用最小 lock/override 或上游兼容升级处理，禁止 `--force`。

### H5

`npm audit --omit=dev` 报 2 high，完整 `npm audit` 报 2 high + 1 moderate，涉及 Vite、nanoid 和 `@dcloudio/vite-plugin-uni`。当前 CI 会完整输出生产 high，但仅以 critical 阻断，因此不能把 App 的 high 与 Server 已确定的 CI 失败混为一谈。其中 Vite 风险是既有 `R-1`：uni-app 插件精确约束 Vite 5.2.8，安全升级需跨兼容边界；当前补偿措施是开发服务器只监听 `127.0.0.1`，生产只发布静态 H5。

这不代表风险已修复。nanoid 可修复性应和 uni-app lockfile 一起独立评估，不能通过 force 或 legacy peer deps 掩盖。

### Gateway

生产依赖审计为 0 vulnerability。

## 9. 配置、部署与 Git 健康

- 敏感文件路径、0600/0700、loopback URL 和严格布尔配置具备校验；未发现真实 target、token、QR payload、context 或 Secret 被提交。
- 环境变量数量和跨进程关系已经偏多，API、Worker、Gateway、manager 的启用顺序仍主要依靠文档维护；建议在补部署服务链时增加机器可读 preflight。
- 分支数量较多，当前 `main` 不是实际稳定基线；服务号候选、OpenClaw 研究、Hermes 当前实现并存。禁止以 `main` 名称推断可发布内容，应记录唯一 release candidate SHA。
- 根目录 `6b5464b0fc707b823ddc225724fb3103.txt` 是初始导入时提交的 40 字符文本，来源/用途未文档化。可能是历史站点验证文件；在确认外部依赖前不要删除，但应补说明或迁移到明确目录。

## 10. 维护性评价

项目尚未呈现需要整体推翻重写的高风险失控结构。理由：

- API、业务数据库、worker、Gateway 和 Hermes manager 的边界基本明确；
- 事务、幂等、失败关闭、Hermes 绑定代次/账号隔离和主要线索操作已有大量反向测试；
- H5 已有真实浏览器测试，不再只有构建验证；
- 迁移有 checksum、回滚故障注入、完整性和外键门禁；
- 本轮发现的问题可以按模块独立修复，不需要推翻整体架构。

但已经存在明显技术债：

- 通知渠道能力在三处重复定义并已产生真实不一致；
- 部署拓扑落后于本地实现；
- 公司级工作台权限已获产品确认，README 已同步区分普通线索导出和工作台导出；
- 大型页面和 `server/src/db.ts`、`server/src/routes/leads.ts` 仍承担过多职责；
- OpenClaw/服务号/Hermes 多条历史路线增加配置和文档认知成本。

## 11. 问题清单与优先级

| 编号 | 等级 | 问题 | 修复门禁 |
| --- | --- | --- | --- |
| P1-1 | P1 | Hermes 关闭仍展示 H5 入口 | Hermes 启用/发布前 |
| P1-2 | P1 | Hermes 可配置到 AI 事件但 worker 必失败 | Hermes 启用前 |
| P2-1 | P2 | 改密后旧 JWT 不失效 | 正式发布前 |
| P2-2 | P2 | 浏览器安全响应头缺失 | 正式发布前 |
| P3-1 | P3 | Gateway timeout 测试竞态 | 合并前建议修复 |
| T-1 | 技术债 | 前端大页面 | 可在稳定后渐进处理 |
| D-1 | 部署硬门禁 | Hermes manager/Gateway 部署服务链缺失 | Hermes 部署前 |
| G-1 | 依赖/CI 门禁 | Server 生产依赖审计 3 high | 合并检查前 |
| R-1 | 残余风险 | Vite/uni-app 版本兼容风险 | 保持 loopback；单独升级评估 |
| R-2 | 残余风险 | 上传仅 MIME allowlist | 安全加固批次处理 |
| R-3 | 外部门禁 | 生产迁移/恢复未演练 | 部署授权后执行 |

## 12. 推荐最小整改顺序

1. 建立统一事件×渠道能力矩阵，Hermes 仅允许 `owner_changed`。
2. 增加 Hermes runtime capability，关闭时 H5 菜单和页面 fail-closed。
3. 最小修复 Server 可修复的 3 个 high 生产依赖，并让 CI 恢复通过。
4. 修复 Gateway timeout 测试同步竞态。
5. 在另获部署范围批准后，完成 Hermes manager/Gateway 可部署服务单元、preflight、readiness 和回滚；该项是 D-1，不计作运行缺陷修复。
6. 单独设计 JWT session version 与浏览器安全响应头；同步加固上传内容识别。
7. 获得部署授权后，在一致性副本完成迁移与恢复演练。
8. 上述门禁完成后，再做双用户 Hermes 隔离 Pilot；不得直接开放多人生产使用。
9. 大页面和历史路线清理由后续真实维护热点驱动，不做一次性大重构。

## 13. 最终建议

当前推荐状态：

```text
核心业务离线回归：PASS
Hermes 每用户 QR/绑定状态机离线回归：PASS
当前分支合并发布：NO-GO
Hermes 真实启用：NO-GO
下一步：按第12节先修2项P1与Server依赖/CI门禁，再进行独立复验
```

建议继续以当前分支和完整 SHA 管理，不切换到 `main`，不合并服务号或历史 OpenClaw 多人研究代码。修复应按小提交拆分，每个 P1 独立测试、独立验收，避免再次把渠道、权限和部署改动混在一个提交中。

## 14. 项目健康整改最终状态（2026-08-09）

本节是对第 1–13 节历史快照的追加结论，不删除首次失败证据。验收分支为
`chore/project-health-remediation-v2`，验收基线为
`2d5ce5964c7f00ff25a4cdb31f5157bf6d8b6866`；`82c15dc` 为祖先提交，验收开始时工作区干净。

### 14.1 闭环结论

| 单元 | 最终状态 | 核心证据 |
| --- | --- | --- |
| A 通知事件×渠道 | 已关闭 | 唯一能力矩阵允许 `owner_changed + hermes`，拒绝 `daily_report/scheduled_follow_overdue + hermes`；管理保存、preview、AI 入队、Worker 和人工重试共用同一判定。 |
| B Hermes 关闭态 H5 | 已关闭 | 服务端 runtime capability 优先；菜单、深链、QR 创建/轮询/解绑均 fail-closed，关闭时请求数为 0。 |
| C Server 依赖门禁（Loop G-1） | 已关闭 | `npm audit --omit=dev` 为 0 vulnerability，未使用 `--force` 或 `--legacy-peer-deps`。 |
| D Gateway timeout 竞态 | 已关闭 | 独立复验连续 3 轮 62/62，验收再跑 62/62；未放宽 SIGKILL/reap/unknown 断言。 |
| E 改密后旧 JWT | 已关闭 | 新增迁移 `010` 的 `token_version`；本人改密和管理员重置均立即使旧 token 401，新 token 可用。 |
| F 浏览器安全头 | 已关闭 | API/H5/上传统一 CSP、nosniff、frame、Referrer-Policy 和 Permissions-Policy；HTTP 应用不伪造 HSTS。 |
| G1 上传内容与发布安全 | 已关闭 | MIME 与 PNG/JPEG/GIF/WebP/HEIC 签名匹配、私有 staging、0600 原子发布、失败清理和静态隔离均通过。 |
| D-1 Hermes 离线服务链 | 已关闭（仅离线） | overlay/固定上游打包、manager/Gateway 单实例单元、loopback、preflight/readiness、环境隔离和 dry-run 通过；真实开关仍默认关闭。 |

第 37 节记录的 dashboard summary/export 公司级可见性是用户已批准的产品行为，不是越权缺陷，本轮未增加 owner 过滤。普通 `/api/export` 仍只导出 member 本人负责线索，admin 仍可导出公司范围。

### 14.2 提交、数据和范围核验

- `947597c`、`172f63d`、`4e5a9b7`、`f2136fd`、`a015d40`、`e725b9f`、`d72ecea`、`ebf6d44` 分别对应上述最小整改单元，`2d5ce59` 仅追加独立复验记录。未修改 dashboard/导出权限代码，未重构 T-1 大页面。
- 相对批准基线，迁移 001–009 对象字节完全一致（抽取块 SHA-256 均为 `6c40433f1d7e72ddc6b203dda176a255fbfbbc876248a59026b3e2789fa0cd5c`）；只新增 010。空库、历史升级、重复、checksum 冲突、故障回滚、integrity 和 foreign key 复验通过。
- `server/data` 未出现 Git 差异，验收前后 8 个数据/备份文件的 SHA-256 逐文件一致。测试只使用 `/tmp` 隔离库。
- 受控源码扫描未发现真实 JWT、DeepSeek key、三段式 token 或微信业务凭据；新增 `.env.example` 只含空值路径占位。本结论不替代 Git 托管平台密钥扫描。

### 14.3 最终验证与风险

验收阶段再跑 Server 170/170、Gateway 62/62、Hermes overlay 33/33、H5 17/17，合计 **282/282**；四项构建/测试命令均退出 0。Server/Gateway 生产依赖审计均为 0。Hermes dry-run 返回 `offline=true`、`network=not_used`、`businessDatabase=not_used`、`residentProcess=not_started`。

本轮最终统计：**P1=0、P2=0、P3=0**。仍保留：

- **R-1：** App `npm audit --omit=dev` 的完整 effect graph 真实输出 **29 high + 1 moderate**（根因摘要为 nanoid/postcss 与 Vite/uni-app 链，不是 30 个独立根因），critical=0；开发服务器只允许 loopback，生产只发布静态 H5，CI 以 critical 为阻断门禁。禁止 force/legacy peer/跨大版本伪修复。
- **R-2 / G2：** 上传配额、保留期、孤儿文件判定及清理时间窗仍未定义；这些需要产品给出具体值后另立设计，不得由验收代理臆造。
- **R-3：** 未获授权访问生产路径、一致性备份、迁移或恢复；010 及已有 Hermes 迁移的生产演练未执行。
- **T-1：** `leads/list.vue`、`leads/detail.vue`、`pool/index.vue` 大页面技术债按批准范围保留，本轮未重构。
- **Hermes 外部门禁：** 本整改版本没有新的真实 Pilot 或部署授权。历史单条 Pilot 事实不等于当前多用户链路已验证；真实扫码、发送、PM2/Nginx 操作和多人开放仍未授权。

最终建议：**允许进入合并评审（GO），但不授权合并、推送或生产发布。生产发布为 NO-GO，直到 R-3 迁移/恢复演练及明确发布授权完成；Hermes 必须继续关闭，直到另行批准并通过真实 Pilot。**
