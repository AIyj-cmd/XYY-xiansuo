# 阶段二收口：Git 基线冻结独立测试报告

日期：2026-07-30
验证角色：`test_verifier`（独立验证；未修改业务源码、迁移或既有提交）
结论：**不允许无条件进入验收。** 代码、迁移、构建、依赖审计、提交边界和本地数据库隔离均通过；但冻结范围相对初始提交的 `git diff --check` 有 17 项 Markdown 格式错误，未满足可追溯基线的完整格式门禁。先仅修复这些文档格式并形成后续修复提交，再复测该项后进入验收。

## 1. 测试环境与开始前基线

- 分支：`baseline/phase2-freeze-20260730`
- 冻结前置提交：`a4d04a6bcf6ecd5fe4a550bc63855ea548f0fddf`（整合代码）与 `8d2121d6b1fe7846d0f9a4f9a5675143704741c3`（文档），当前 `HEAD` 为后者。
- 初始导入提交：`d77b600b8c6d7a9fe3e71fdc9f75ef90d78a6c71`。
- 测试开始前 `git status --short`、工作区 `git diff --name-only` 和 `git diff --check` 均为空；未发现待提交的用户改动。本报告是本测试阶段唯一新增的工作区文件。
- `server/data/` 在测试前为被忽略的本地运行数据，共有 `app.db`、`app.db-shm`、`app.db-wal`、`leads.db`、`xiansuo.db`；测试使用 `/tmp` 临时数据库。

## 2. 测试计划

1. 核对分支、提交父子关系、提交正文、逐文件清单和审计 allowlist。
2. 核对 001/002/003 的版本、描述、checksum、`db.ts` Git blob 与迁移片段哈希，确认冻结后未漂移。
3. 扫描 HEAD、可达历史及忽略规则中的环境文件、数据库、WAL/SHM、上传、构建物、日志、备份、二维码及微信凭证/token；区分历史风险说明、测试夹具与真实密钥。
4. 复核负责人、跟进派生和禁止范围的代码差异，并运行完整后端测试、前端双目标构建、生产依赖审计及空白检查。
5. 测试后再次核对 Git 状态及 `server/data/` 文件清单/sha256，避免测试污染。

## 3. 提交与归因核验

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 分支/线性历史 | 通过 | `d77b600 -> a4d04a6 -> 8d2121d`；当前仅本地 `baseline/phase2-freeze-20260730` 包含 HEAD。未推送、未建 PR、未合并。 |
| 代码整合提交 | 通过 | `a4d04a6` 含 39 个文件，完整路径集合与审计 exact code allowlist 一致（双向比较无差异）。提交正文明确披露了无法逐行归因但耦合的 CI、锁文件、公海 UI、部署、memo/upload/users 等改动，未伪造为纯阶段一或阶段二。 |
| 文档提交 | 通过（内容边界） | `8d2121d` 仅含 `AGENTS.md`、`.codex` 代理配置、根文档迁移/删除和 `docs/` 归档树；均在审计文档 allowlist 范围内。 |
| 用户既有/无法归因改动 | 通过（可追溯披露） | 冻结前工作区现已清空；其内容由 `a4d04a6` 正文和报告归类为“已批准、强耦合但不安全逐行归因”的整合基线。未发现被静默丢弃或覆盖的剩余工作区改动。 |
| 业务规则与禁止范围 | 通过 | `lead-owner.ts`、`follow-up-derived.ts`、`leads.ts`、`import_export.ts` 和前端枚举与阶段二验收相符；`d77b600..a4d04a6` 未修改既有 notification 路由/页面/工具文件。仓库初始提交已有 notification 代码，不是本次提前新增。 |

## 4. 迁移与冻结完整性

| 版本 | 描述 | checksum | 结果 |
| --- | --- | --- | --- |
| `001` | `create baseline schema` | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` | 通过 |
| `002` | `reconcile legacy lead and follow-up schema` | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` | 通过 |
| `003` | `add owner transfer audit metadata and follow-up derivation source` | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` | 通过 |

- `a4d04a6..HEAD` 对 `server/src/db.ts` 无差异。
- `db.ts` 完整文件的工作区、HEAD Git blob sha256 均为 `a351b3ee48072ec773c3e9082b976ec2440bb94cc9a932e73b13cc1644951eea`。
- 审计所用精确命令 `sed -n '257,279p' server/src/db.ts | sha256sum`，在工作区、`a4d04a6` blob 与 HEAD blob 上均为 `90850427df82435359922a2686765f465a252890ca58b6b058ab7c249f1865c9`。因此审计报告的 `908504...` 是正确的迁移片段哈希；实现报告中提及的 `250f...` 不是相同取样范围的结果，不能用于判定漂移。Git blob 与源码常量是权威证据，未发现漂移。

## 5. 敏感文件与污染检查

- HEAD 与可达历史只跟踪 `.env.example`、`deploy/.env.example`；两者均为空占位符，没有真实密码或密钥。
- HEAD、初始提交和可达历史均未跟踪 `server/data/*.db`、SQLite WAL/SHM、上传目录、构建目录、日志、备份、二维码或微信凭证/token。`.gitignore` 已忽略 `server/data/`、`server/uploads/`、`server/backups/`、`.env*`（显式放行 `.env.example`）及构建目录。
- `server/data/` 测试前后清单、文件大小和 sha256 完全一致；`app/dist/`、`server/dist/`、`server/data/`、`server/uploads/` 均保持 ignored，未进入索引。
- 新增源码、脚本、示例和锁文件中未发现私钥、云 API key、真实 JWT secret 或真实管理员密码。测试代码的固定测试密码和运行输出属于测试夹具，不能用作生产配置。
- `xyy123456` 仍出现在受跟踪的设计/历史风险说明和测试报告中，且初始历史与一个不可达悬挂提交也保留旧 README 的公开默认密码说明；这些是非真实 secret 的历史证据，不是当前运行时兜底。当前源码/环境示例没有该默认密码。悬挂对象未删除，避免使用破坏性 Git 清理；如未来需要彻底减少本地对象暴露，应由仓库所有者另行决定保留期和安全清理策略。
- `git fsck --no-reflogs --no-progress` 仅报告上述可达分支之外的一个 dangling commit 和 blob，未报告对象损坏。

## 6. 已执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `git branch --show-current && git rev-parse HEAD && git status --short && git log -5` | 通过；分支和 HEAD 如上，开始时工作区干净。 |
| `git diff-tree ... a4d04a6` 与审计 allowlist 双向比较 | 通过；39/39 文件完全匹配。 |
| `git diff --quiet a4d04a6..HEAD -- server/src/db.ts`、Git blob/片段 sha256 核验 | 通过；迁移未漂移。 |
| `git ls-tree`/`git log --all --name-only`/`.gitignore`/敏感模式扫描 | 通过，结论见第 5 节。 |
| `cd server && npm run build` | 通过。 |
| `cd server && npm test` | **39/39 通过**。 |
| `cd server && npm audit --omit=dev --audit-level=high` | 通过，`0 vulnerabilities`。 |
| `cd app && npm run build:h5` | 通过；仅有未配置 uni Appid 的信息提示。 |
| `cd app && npm run build:mp-weixin` | 通过；仅有未配置 uni Appid 的信息提示。 |
| `cd app && npm audit --omit=dev --audit-level=high` | 初次受沙箱网络限制失败；经允许访问 npm 官方审计接口后重试通过，`0 vulnerabilities`。 |
| `git diff --check`（当前工作区） | 通过，无输出。 |
| `git diff d77b600..HEAD --check` | **失败，17 项格式告警**，见第 7 节。 |

## 7. 失败项：P1 基线提交包含 Markdown 空白/EOF 格式错误

### 预期

冻结后的提交相对 `d77b600` 也应通过 `git diff --check`，以满足“Git 基线整理”中的格式门禁；仅在干净工作区运行无参数的 `git diff --check` 不能覆盖已提交的新增内容。

### 实际

`git diff d77b600..HEAD --check` 返回 17 项：

1. `docs/02-开发实现/BASELINE_IMPLEMENTATION_REPORT.md:3` trailing whitespace
2. `docs/02-开发实现/PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md:3` trailing whitespace
3. `docs/03-测试验证/PHASE_2_TEST_REPORT.md:3` trailing whitespace
4. `docs/03-测试验证/TEST_REPORT.md:3` trailing whitespace
5. `docs/03-测试验证/TEST_REPORT.md:4` trailing whitespace
6. `docs/04-验收交付/ACCEPTANCE_REPORT.md:3` trailing whitespace
7. `docs/04-验收交付/ACCEPTANCE_REPORT.md:4` trailing whitespace
8. `docs/04-验收交付/ACCEPTANCE_REPORT.md:5` trailing whitespace
9. `docs/04-验收交付/DEPLOYMENT_NOTES.md:3` trailing whitespace
10. `docs/04-验收交付/DEPLOYMENT_NOTES.md:89` new blank line at EOF
11. `docs/04-验收交付/PHASE_2_ACCEPTANCE_REPORT.md:3` trailing whitespace
12. `docs/04-验收交付/PHASE_2_ACCEPTANCE_REPORT.md:4` trailing whitespace
13. `docs/04-验收交付/PHASE_2_ACCEPTANCE_REPORT.md:5` trailing whitespace
14. `docs/04-验收交付/PHASE_2_DEPLOYMENT_NOTES.md:3` trailing whitespace
15. `docs/04-验收交付/PHASE_2_ROLLBACK_PLAN.md:3` trailing whitespace
16. `docs/04-验收交付/ROLLBACK_PLAN.md:3` trailing whitespace
17. `docs/04-验收交付/ROLLBACK_PLAN.md:60` new blank line at EOF

### 最小修复与复测

仅删除上述行尾空格及两个多余 EOF 空行；不改变报告语义、代码、迁移、测试或既有提交。之后创建一个独立的文档格式修复提交，并重新运行：

```bash
git diff d77b600..HEAD --check
git diff --check
cd server && npm run build && npm test
```

严重级别：**P1（基线冻结门禁）**。它不改变运行时业务或安全行为，但阻断“提交范围无格式错误”的冻结完成结论。

## 8. 测试后工作区变化与放行结论

- 业务源码、迁移、部署脚本和既有提交均未被本测试阶段修改。
- 本报告为测试阶段唯一新增文件；临时 `npm`/构建产物和 `/tmp` 测试数据库均未进入 Git。
- 当前可作为阶段二功能回归的可复现候选基线：构建、39 个后端测试、迁移校验和、敏感文件防护及依赖审计均通过。
- **不允许无条件进入验收**：请先按第 7 节完成纯文档格式修复并建立可追溯提交。修复后若上述复测通过，可带条件进入最终验收；生产上线门禁（生产数据库备份副本迁移/恢复演练、发布制品评审与维护窗口）仍须单独完成。
