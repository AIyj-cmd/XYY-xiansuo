# XYY-xiansuo 项目健康整改 Loop 循环提示词

> 用途：将下面完整 Markdown 交给项目主代理，持续执行“审计 → 实现 → 独立验证 → 验收 → 未通过则回到实现”的闭环，直到所有批准范围内的门禁关闭，或遇到必须由用户决定的真实阻断。

````markdown
# XYY-xiansuo：项目健康整改自主 Loop

你是本项目主代理和执行编排者。

读取并遵循仓库根目录 `AGENTS.md`。用户不负责在代理之间复制提示词；你必须自主调用：

```text
audit_designer
→ implementer
→ test_verifier
→ acceptance_optimizer
```

按照以下循环持续推进：

```text
读取当前证据
→ 选择一个最小整改单元
→ 审计并确认边界
→ 实现
→ 独立验证
→ 验收
→ 失败则把最小复现交回 implementer
→ 重新验证
→ 当前单元关闭后提交
→ 进入下一个整改单元
```

不要要求用户转发任何中间结果，不要每完成一步就询问“是否继续”。只有本文列出的人工门禁才暂停。

## 一、当前基线

```text
分支：feature/hermes-per-user-qr-binding
基线提交：82c15dc6e2e5cb38e614f3f27ba7bdaec99d1efd
```

审计依据：

```text
docs/03-测试验证/PROJECT_FINAL_AUDIT_REPORT.md
docs/03-测试验证/TEST_REPORT.md 第37节及37.1节
```

开始前执行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

要求：

- 当前分支必须包含上述基线提交；
- 工作区必须干净；
- 如有未知差异，立即停止，不 stash、不 reset、不 clean、不覆盖；
- 创建本地整改分支：

```text
chore/project-health-remediation-v2
```

禁止推送、创建 PR、合并主分支或部署。

## 二、已批准的产品口径

以下行为已经由用户确认，不属于问题，不得重新修改：

```text
普通成员可以查看公司级工作台汇总；
普通成员可以使用公司级工作台导出；
工作台中可以显示负责人和联系信息；
普通线索导出仍只导出 member 本人负责的线索；
admin 普通线索导出仍可覆盖全公司。
```

不得把工作台公司级可见性重新计入 P1/P2/P3，不得给 dashboard summary/export 增加 owner 过滤。

## 三、本轮目标与问题清单

必须依次关闭：

### A. P1-2：统一通知事件与渠道能力

当前问题：

```text
管理员可以保存 daily_report + hermes
→ AI任务进入pending
→ Worker缺少Hermes绑定三元组
→ HERMES_BINDING_GENERATION_INVALID
```

目标：

- 建立唯一、表驱动的事件×渠道能力定义；
- 管理规则保存、预览、AI事件生成和 Worker 共同使用；
- Hermes 首版只允许 `owner_changed`；
- `scheduled_follow_overdue`、`daily_report` 不得配置或生成 Hermes 任务；
- Worker 保留最后一道 fail-closed 防御；
- 不修改 Mock、OpenClaw 和已批准 AI 调度语义；
- 不自动修复或重放历史失败任务。

测试至少覆盖：

- `owner_changed + hermes` 允许；
- `daily_report + hermes` 拒绝；
- `scheduled_follow_overdue + hermes` 拒绝；
- 被拒绝组合不产生 pending outbox；
- Mock/OpenClaw 原有组合不回归；
- 管理 API、preview、event service、Worker 使用同一矩阵。

建议提交：

```text
fix: align notification event and channel capabilities
```

### B. P1-1：Hermes 关闭态 H5 fail-closed

当前问题：

```text
HERMES_BINDING_ENABLED=false
→ H5仍显示“微信通知绑定”
→ 页面仍显示“生成登录二维码”
→ 点击后才由API 409拒绝
```

目标：

- 服务端提供已认证的运行时 capability，或在现有 binding status 契约中返回安全 enabled 状态；
- 服务端关闭优先于任何 H5 编译期配置；
- 关闭时“我的”页面不显示 Hermes 入口；
- 用户直接访问深层路由时不显示二维码、创建按钮或可执行动作；
- 关闭态不得发起 QR create 请求；
- 开启态已有绑定、解绑、重新绑定流程不回归；
- 所有前端请求继续使用 `app/src/utils/request.ts`。

测试至少覆盖：

- API/H5 均关闭；
- H5误配置为开启但 API 关闭；
- API开启时菜单和绑定页正常；
- 未登录访问跳回登录；
- 深层路由刷新；
- 关闭时 QR POST 调用次数为0。

建议提交：

```text
fix: hide disabled Hermes binding capability
```

### C. G-1：关闭 Server 生产依赖审计门禁

当前问题：

```text
npm audit --omit=dev
→ brace-expansion / minimatch / fast-uri
→ 3 high
→ CI失败
```

目标：

- 只采用最小兼容修复；
- 优先 lockfile 合法更新、上游兼容版本或精确 override；
- 不升级无关直接依赖；
- 不使用 `--force`；
- 不使用 `--legacy-peer-deps`；
- `npm ci`、build、全量测试和 audit 全部通过；
- 检查依赖树中没有意外引入第二套核心大版本。

如修复必须升级 Fastify、node:sqlite 相关基础设施或产生大范围 API 兼容变化，暂停并向用户报告一个明确阻断，不得强行升级。

建议提交：

```text
chore: remediate server dependency advisories
```

### D. P3-1：消除 Gateway 超时测试竞态

当前问题：

```text
Gateway完整测试首次58/59
timeout.pid ENOENT
完整重跑59/59
```

目标：

- 只修测试同步或确有证据的子进程生命周期问题；
- 等待可观察条件，不使用固定 sleep；
- 不放宽 SIGKILL、超时清理、幂等或 `result_unknown` 断言；
- 相关测试连续运行至少3轮通过；
- 不启动真实 Hermes/OpenClaw。

建议提交：

```text
test: stabilize gateway timeout process verification
```

## 四、第二批安全加固

第一批 A–D 全部关闭后再处理，禁止与 P1 混在同一提交。

### E. P2-1：修改或重置密码后旧 JWT 失效

这是认证与迁移高风险改动。必须先由 `audit_designer` 给出真实数据结构、API兼容、迁移和回滚设计；除非用户在使用本提示词时明确授权端到端执行，否则设计完成后暂停一次等待批准。

最低目标：

- 使用 `token_version`、`password_changed_at` 或等价稳定机制；
- 改密和管理员重置密码后，旧 token 立即返回401；
- 新 token 正常；
- 账号停用、删除、角色变更的现有实时校验不回归；
- 如需迁移，只新增下一版本迁移，不修改 001–009 或 checksum；
- 空库、历史升级、重复执行、checksum冲突、回滚故障注入通过。

### F. P2-2：浏览器安全响应头

目标：

- 为 API、H5 和上传响应设置适配当前应用的安全头；
- 至少覆盖 `X-Content-Type-Options: nosniff`、frame 防护、Referrer-Policy；
- CSP 必须结合 uni-app H5 的真实构建资源制定，不能复制一段导致页面不可用的模板；
- HTTPS/HSTS 只在正确代理与生产环境语义下启用；
- 不新增第三方生产依赖，除非先说明必要性并获批准；
- H5 运行测试和上传下载回归通过。

### G. R-2：上传加固

只在 F 完成后评估：

- 对允许类型做文件魔数或安全解码验证；
- 明确用户配额、失败清理和孤儿文件清理策略；
- 不改变现有上传 API 响应；
- 不引入大型图像处理依赖；确需依赖时暂停申请批准。

## 五、部署硬门禁 D-1

只完成离线配置、服务单元、preflight、文档和 dry-run，不实际部署。

目标拓扑：

```text
xiansuo-api
→ notification-worker
→ iLink Gateway（127.0.0.1:38116）
→ Hermes account manager（127.0.0.1:38117）
```

要求：

- 打包 `poc/hermes-weixin-transport/` 和固定上游依赖；
- Gateway 与 manager 独立单实例进程；
- 明确工作目录、loopback、环境变量、0600文件和0700目录；
- manager/Gateway 不读取业务数据库或 DeepSeek Key；
- 增加 liveness/readiness、日志轮转、启动顺序、正常停止和回滚步骤；
- 默认所有真实开关关闭；
- dry-run 不得登录微信、扫码或发送消息；
- 不操作 PM2/Nginx/服务器。

建议提交：

```text
chore: package Hermes notification service chain
```

## 六、明确保留的残余风险

### R-1：Vite / uni-app

- 当前 uni-app 插件精确约束 Vite 5.2.8；
- 开发服务器继续只监听 `127.0.0.1`；
- 生产只发布静态 H5；
- 不使用 force、legacy peer deps 或跨大版本升级伪造修复；
- 只有找到兼容升级路径并通过 H5 全量测试时才单独提交升级。

### R-3：生产迁移与恢复

本 Loop 不操作生产环境。迁移和恢复演练必须在用户另行提供生产路径、备份目录和只读一致性备份授权后执行。

### T-1：超大页面

本 Loop 不重写 `leads/list.vue`、`leads/detail.vue` 或 `pool/index.vue`。只有整改直接触及相同逻辑且存在自动化保护时，才允许小范围提取；禁止为了行数好看做大重构。

## 七、每个整改单元的强制 Loop

每个 A–G 单元都必须独立执行：

1. `audit_designer` 只读确认真实根因、影响文件、接口、权限、数据和回滚边界；
2. 主代理确认没有扩大范围；
3. `implementer` 实现最小改动和定向测试；
4. 主代理检查 diff，确认没有夹带其他单元；
5. `test_verifier` 从干净基线独立复现原失败，并验证修复、反向权限、安全和回归；
6. 若验证失败：把具体复现、期望、实际和证据直接交回 `implementer`，不得让用户转发；
7. 重复步骤3–6，直到失败关闭或确认无法在原范围解决；
8. `acceptance_optimizer` 对照本提示词、实现差异和 TEST_REPORT 验收，只修复范围内已确认问题；
9. 受影响测试和全量基线通过后，形成一个语义明确的本地提交；
10. 工作区干净后进入下一个单元。

禁止通过以下方式“通过”：

- 删除或跳过失败测试；
- 放宽安全断言；
- 只重跑直到偶然变绿；
- 把异常吞掉；
- 默认回退到其他微信接收人；
- 打开自动重试；
- 修改历史迁移 checksum；
- 使用真实数据代替可复现的隔离 fixture。

## 八、完整验证矩阵

每个单元运行定向测试；所有批准单元结束后执行：

```bash
cd server
npm ci
npm run build
npm test
npm audit --omit=dev

cd ../poc/ilink-gateway
npm ci
npm run build
npm test
npm audit --omit=dev

cd ../hermes-weixin-transport
./run-tests.sh

cd ../../app
npm ci
npm run build:h5
npm run test:h5
npm run test:e2e
npm audit --omit=dev

cd ..
git diff --check
```

同时确认：

- Server 基线不少于163项，新增测试后以实际数量为准；
- Gateway 基线59项，新增测试后以实际数量为准；
- Hermes overlay 基线30项，新增测试后以实际数量为准；
- H5 Playwright 基线14项，新增测试后以实际数量为准；
- Gateway 全量至少连续3轮无 timeout.pid 竞态；
- 迁移 001–009 字节和 checksum 不变；如批准新增迁移，则从下一编号开始；
- fresh、历史升级、重复、冲突、失败回滚、integrity和foreign key通过；
- `server/data` 聚合 SHA-256 前后一致；
- 不调用真实微信、OpenClaw、Hermes上游或DeepSeek；
- 不访问生产数据库；
- 不产生小程序构建；
- 不把 Secret、token、target、二维码、手机号或客户数据写入Git和日志。

## 九、必须暂停的人工门禁

只有以下情况暂停，并且每次只提出一个明确问题：

1. JWT旧token失效方案需要新增数据库迁移，但用户尚未授权该设计；
2. 依赖修复必须跨 Fastify、uni-app 或 Vite 不兼容大版本；
3. 需要新增第三方生产依赖；
4. 需要修改已批准的工作台公司级可见权限；
5. 需要操作生产数据库、服务器、PM2、Nginx 或真实业务数据；
6. 需要扫码、登录、输入密钥或发送真实微信；
7. 需要推送、创建PR、合并或部署；
8. 发现无法在批准范围内关闭的真实 P1。

普通测试失败、类型错误、文档同步和同一整改单元内的小范围修复不询问用户。

## 十、文档与提交

不要新增多份阶段报告。更新：

```text
docs/03-测试验证/PROJECT_FINAL_AUDIT_REPORT.md
docs/03-测试验证/TEST_REPORT.md
docs/02-开发实现/CHANGELOG.md
docs/04-验收交付/ACCEPTANCE_REPORT.md
docs/04-验收交付/DEPLOYMENT_NOTES.md
docs/04-验收交付/ROLLBACK_PLAN.md
```

要求：

- 保留历史首次失败和修复证据；
- 每关闭一项明确标记复现是否仍存在；
- 不把默认关闭写成已部署；
- 不把离线测试通过写成真实微信 Pilot 通过；
- 不新增无索引、重复或相互矛盾的报告。

禁止推送、创建 PR、合并主分支或部署。

## 十一、完成条件

离线整改只有在以下条件同时满足时完成：

```text
P1=0
未解决P2=0（或有用户明确接受且记录的残余风险）
P3=0
G-1关闭
D-1离线服务链和dry-run完成
Server全量通过
Gateway全量连续3轮通过
Hermes overlay全量通过
H5构建和运行测试通过
迁移验证通过
server/data未变化
工作区干净
```

即使满足以上条件，仍不自动授权：

```text
生产部署
生产迁移
真实扫码
真实微信发送
开放多人使用
```

## 十二、最终一次性报告

只在 Loop 完成或遇到人工硬阻断时报告：

1. 实际关闭的 P1/P2/P3；
2. 每个问题的根因与修复；
3. 事件×渠道矩阵最终状态；
4. Hermes 关闭态 H5 行为；
5. Server 依赖审计结果；
6. Gateway 竞态连续复测结果；
7. JWT和安全响应头结果；
8. Hermes部署服务链dry-run结果；
9. Server、Gateway、overlay、H5实际测试数量；
10. 迁移和`server/data`结果；
11. 保留的R-1/R-2/R-3/T-1；
12. 本地提交SHA；
13. 工作区状态；
14. 是否允许进入合并评审；
15. 下一步唯一需要用户授权的事项。

完成后停止，不自动部署、不真实发送。
````
