# 阶段二收口：Git 基线冻结报告

日期：2026-07-30
验收角色：`acceptance_optimizer`
结论：**阶段一、阶段二已验收代码已形成可追溯的本地 Git 基线，可作为后续开发起点；尚未满足生产上线门禁。**

## 1. 冻结前分支与提交

- 冻结开始前分支：`main`。
- 冻结开始前提交：`d77b600b8c6d7a9fe3e71fdc9f75ef90d78a6c71`（`Initial project import`）。
- 远端基线：`origin/main` 仍指向 `d77b600b8c6d7a9fe3e71fdc9f75ef90d78a6c71`。
- 冻结前工作区包含阶段一、阶段二、文档归档以及任务开始前已有或无法安全逐行归因的修改；这些差异没有被删除、重置、清理或回滚。
- 当前冻结分支没有远端跟踪分支；未推送、未创建 PR、未合并到 `main`。

## 2. 工作区审计结果

冻结阶段核对了：

```text
git status --short
git diff --stat
git diff
git log -5 --oneline
```

审计结论：

- 阶段一和阶段二运行时代码、测试、依赖锁文件、部署/环境示例及强耦合集成文件被归入代码整合提交。
- 设计、实施、测试、验收、部署、回滚记录及项目代理配置被归入文档归档提交。
- 独立验证发现冻结范围相对初始提交有 17 项 Markdown 行尾或文件尾空白错误；验收阶段只删除这些空白，并追加独立测试报告，没有改变文档语义。
- 构建产物、本地 SQLite 文件、WAL/SHM、上传目录及 `/tmp` 测试数据库没有进入索引或提交。
- 验收报告提交前，工作区没有无法解释的业务源码、迁移或配置差异。

## 3. 阶段一、阶段二及无法精确归因修改

### 3.1 阶段一：安全与数据库基线

可明确归因的主要内容：

- JWT 只作为身份凭证，实时读取数据库用户、角色和启用状态。
- 安全的首次管理员初始化与环境变量校验。
- `DB_PATH`、SQLite WAL/外键、版本化迁移、完整性检查。
- 迁移 `001`、`002` 及其自动化测试。
- 环境变量示例、备份、种子和部署门禁。

### 3.2 阶段二：业务一致性基线

可明确归因的主要内容：

- member/admin 创建线索负责人权限与目标启用状态校验。
- 单条编辑、批量转移、公海认领共用负责人变更服务。
- 批量全有或全无、逐条真实审计、`source` 和 `operation_id`。
- 跟进新增、编辑、删除按 `created_at DESC, id DESC` 重算派生时间；删除最后一条按方案 B 清空。
- 迁移 `003`、导入一致性和前端移除非法“邮件”选项。
- Fastify 事务异常继续使用 `{ code, msg, data }` 响应包络。

### 3.3 任务开始前已有或无法安全逐行归因的修改

代码整合提交有意包含了已经随完整测试通过、但无法安全拆成纯阶段提交的强耦合修改：

- CI 工作流和前后端依赖锁文件；
- 公海页面、Vite 配置；
- 部署初始化、进程配置和脚本；
- `memo`、`upload`、`users` 路由及相关集成文件；
- Excel 和公海既有测试上下文。

这些修改已在代码整合提交正文中披露，没有伪造为阶段一或阶段二的独立新增能力。由于冻结前只有一个初始提交和混合工作区，无法在不改写文件历史、不丢失用户修改的情况下恢复逐行原始作者归因。

## 4. 未纳入提交的用户修改

- 冻结前没有能够安全识别并单独保留在工作区的用户业务修改。
- 无法精确归因但与已验收基线强耦合的修改已随整合提交纳入，并在第 3.3 节及提交正文中披露。
- 没有通过 `reset`、`clean`、强制切换或覆盖方式丢弃任何用户修改。
- 本地被忽略的数据库、上传目录和构建产物不属于可提交用户源码，保持在工作区但未进入 Git。

## 5. 创建的分支

```text
baseline/phase2-freeze-20260730
```

分支从 `d77b600b8c6d7a9fe3e71fdc9f75ef90d78a6c71` 创建，当前历史保持单线：

```text
d77b600 -> a4d04a6 -> 8d2121d -> c2e3a7b -> 本报告提交
```

## 6. 创建的提交及完整 SHA

| 顺序 | 完整 SHA | 提交信息 | 作用 |
| --- | --- | --- | --- |
| 1 | `a4d04a6bcf6ecd5fe4a550bc63855ea548f0fddf` | `chore: freeze verified phase 1 and phase 2 baseline` | 39 个文件的阶段一、阶段二及披露的强耦合代码整合基线。 |
| 2 | `8d2121d6b1fe7846d0f9a4f9a5675143704741c3` | `docs: archive phase implementation and acceptance records` | 项目代理配置与阶段设计、实施、测试、验收资料归档。 |
| 3 | `c2e3a7b8f3f019eaf84ff5be190f85d93df3a94e` | `docs: normalize frozen baseline records` | 仅修复独立测试确认的 Markdown 空白并加入独立冻结测试报告。 |
| 4 | 以本文件提交后的 `HEAD` 为准 | `docs: record phase 2 baseline freeze` | 记录最终冻结验收结果；完整 SHA 在最终交付回报中给出。 |

没有重写上述三个可达提交。`git fsck` 报告一个因冻结阶段提交整理产生的 dangling commit
`445d20ac8c76ef4429e8334bed79d45f95f647a0` 和一个 dangling blob；二者不在当前分支可达历史中，未使用破坏性清理。

## 7. 每个提交的文件范围

### 7.1 `a4d04a6`：代码整合提交

以下 39 个路径与审计阶段 exact code allowlist 双向比较一致，无缺失、无额外路径：

```text
.env.example
.github/workflows/ci.yml
app/package-lock.json
app/package.json
app/src/pages/leads/list.vue
app/src/pages/pool/index.vue
app/vite.config.ts
deploy/.env.example
deploy/deploy.sh
deploy/ecosystem.config.cjs
deploy/setup.sh
scripts/backup.sh
scripts/seed.ts
server/package-lock.json
server/package.json
server/src/bootstrap.ts
server/src/config.ts
server/src/db.ts
server/src/index.ts
server/src/middleware/auth.ts
server/src/routes/import_export.ts
server/src/routes/leads.ts
server/src/routes/memo.ts
server/src/routes/upload.ts
server/src/routes/users.ts
server/src/services/follow-up-derived.ts
server/src/services/lead-owner.ts
server/src/utils/jwt.ts
server/test/auth-db.test.ts
server/test/bootstrap.test.ts
server/test/business-consistency.test.ts
server/test/config.test.ts
server/test/excel.test.ts
server/test/independent-baseline-verification.test.ts
server/test/migrations.test.ts
server/test/phase2-independent-verifier.test.ts
server/test/pool.test.ts
server/test/startup-failure.test.ts
server/tsconfig.json
```

### 7.2 `8d2121d`：文档与工作流归档提交

该提交共涉及 29 个路径变化，与审计阶段文档 allowlist 双向比较一致：

- `AGENTS.md`；
- `.codex/config.toml`；
- `.codex/agents/acceptance-optimizer.toml`；
- `.codex/agents/audit-designer.toml`；
- `.codex/agents/implementer.toml`；
- `.codex/agents/test-verifier.toml`；
- 根目录 `README.md` 删除，并归档为 `docs/00-项目说明/README.md`；
- 根目录 `CLAUDE.md` 移动为 `docs/00-项目说明/CLAUDE.md`；
- 根目录 `goal-part1.md` 移动为 `docs/99-其他/goal-part1.md`；
- `docs/README.md`；
- `docs/01-审计与设计/` 下五份批准设计文档；
- `docs/02-开发实现/` 下阶段一、阶段二实施报告和 `CHANGELOG.md`；
- `docs/03-测试验证/` 下阶段一、阶段二测试报告；
- `docs/04-验收交付/` 下阶段一、阶段二验收、部署和回滚记录。

提交时 `docs/` 树共 20 个文件；除索引适配外，移动文件没有内容丢失。

### 7.3 `c2e3a7b`：格式纠正与独立验证记录

- 新增 `docs/03-测试验证/PHASE_2_BASELINE_FREEZE_TEST_REPORT.md`。
- 仅删除独立测试报告列出的 15 处 Markdown 行尾空格和两个文件尾空行，涉及：
  - `docs/02-开发实现/BASELINE_IMPLEMENTATION_REPORT.md`
  - `docs/02-开发实现/PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md`
  - `docs/03-测试验证/PHASE_2_TEST_REPORT.md`
  - `docs/03-测试验证/TEST_REPORT.md`
  - `docs/04-验收交付/ACCEPTANCE_REPORT.md`
  - `docs/04-验收交付/DEPLOYMENT_NOTES.md`
  - `docs/04-验收交付/PHASE_2_ACCEPTANCE_REPORT.md`
  - `docs/04-验收交付/PHASE_2_DEPLOYMENT_NOTES.md`
  - `docs/04-验收交付/PHASE_2_ROLLBACK_PLAN.md`
  - `docs/04-验收交付/ROLLBACK_PLAN.md`

### 7.4 本报告提交

- 仅新增 `docs/04-验收交付/PHASE_2_BASELINE_FREEZE_REPORT.md`。

## 8. 测试、构建和完整性结果

最终验收复跑结果：

| 检查 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 通过，39/39 |
| `cd app && npm run build:h5` | 通过；仅提示未配置 uni Appid |
| `cd app && npm run build:mp-weixin` | 通过；仅提示未配置 uni Appid |
| `cd server && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities |
| `cd app && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities |
| `git diff d77b600..HEAD --check` | 通过 |
| 工作区和暂存区 `git diff --check` | 通过 |

迁移冻结核对：

| 版本 | 描述 | checksum |
| --- | --- | --- |
| `001` | `create baseline schema` | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` |
| `002` | `reconcile legacy lead and follow-up schema` | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` |
| `003` | `add owner transfer audit metadata and follow-up derivation source` | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |

- `server/src/db.ts` 在工作区、`a4d04a6` 和当前 `HEAD` 的 SHA-256 均为
  `a351b3ee48072ec773c3e9082b976ec2440bb94cc9a932e73b13cc1644951eea`。
- `sed -n '257,279p' server/src/db.ts` 的 SHA-256 在三处均为
  `90850427df82435359922a2686765f465a252890ca58b6b058ab7c249f1865c9`。
- 格式纠正和报告提交没有修改 `server/src/db.ts` 或任何业务源码。

本地 `server/data/` 五个文件的测试前后大小和 SHA-256 完全一致：

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `app.db` | 94208 | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `app.db-shm` | 32768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `app.db-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `leads.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `xiansuo.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## 9. 敏感文件和污染检查

- Git 仅跟踪 `.env.example` 和 `deploy/.env.example`；敏感值均为空占位符。
- 未跟踪或提交真实 `.env`、私钥、云 API key、真实 JWT secret、管理员密码、微信凭证、token 或二维码。
- Git 历史没有数据库、SQLite WAL/SHM、上传文件、构建目录、日志或生产备份路径。
- `.gitignore` 明确忽略 `server/data/`、`server/uploads/`、`server/backups/`、应用/服务构建目录和非示例环境文件。
- 当前本地存在并保持 ignored：`app/dist/`、`server/dist/`、`server/data/`、`server/uploads/`。
- 当前没有本地真实 `.env`、日志、备份或二维码文件；`/tmp` 测试数据库位于仓库外且未进入 Git。
- 固定字符串 `xyy123456` 只存在于设计风险说明和测试/验收历史记录，不存在于当前运行时源码或环境示例。
- `docs/00-项目说明/README.md` 中的 `openssl rand` 命令是生成随机 JWT secret 的部署示例，不是已写入仓库的 secret。
- 初始提交已有的站内通知代码没有在 `a4d04a6` 中修改；未新增通知队列、普通微信、企业微信、DeepSeek/AI、拜访计划或 `sales_stage` 实现。

## 10. 当前剩余未提交文件

在本报告提交完成后，预期 `git status --short` 为空。

以下内容仍作为被忽略的本地运行/构建数据存在，不属于未提交源码：

```text
app/dist/
server/dist/
server/data/
server/uploads/
```

没有需要保留但未纳入基线的用户业务修改。

## 11. 下一阶段开发基线结论

**可以作为下一阶段开发基线。**

后续工作应从本地分支：

```text
baseline/phase2-freeze-20260730
```

以及本报告提交后的最终 `HEAD` 开始。该结论只表示代码、测试和 Git 归档基线稳定，不表示已经批准或开始普通微信 PoC、通知、微信或 AI 开发。

## 12. 仍未完成的生产上线门禁

当前不建议直接生产上线，仍需完成：

1. 核验生产实际运行 commit、Node 版本、环境变量和绝对 `DB_PATH`。
2. 评审并生成可重复构建的正式发布制品。
3. 停写后对生产数据库和上传目录进行一致性备份，并验证备份可打开。
4. 在生产数据库副本演练 `001`、`002`、`003`，核对 checksum、记录数、索引、`integrity_check` 和 `foreign_key_check`。
5. 在副本完成应用回退和数据库恢复演练，不得把真实生产库作为首次迁移目标。
6. 确定维护窗口、发布负责人、回滚负责人和业务验收人。
7. 使用受控账号完成登录、实时角色、负责人权限、批量原子性、公海认领、跟进派生和错误包络冒烟。
8. 配置并复核微信小程序正式 Appid；当前未配置只影响正式发布准备，不影响本次构建通过结论。
9. 决定本地 dangling Git 对象的保留和清理策略；本次为保护历史未执行 `git gc` 或其他破坏性清理。

## 13. 操作边界确认

- 未推送远端。
- 未创建 Pull Request。
- 未合并到 `main`。
- 未执行生产部署或生产数据库迁移。
- 未使用 `git reset`、`git clean`、rebase 或强制覆盖。
- 未修改阶段二已验收业务规则。
- 未进入普通微信 PoC，未开发通知、微信或 AI，未生成下一阶段提示词。
