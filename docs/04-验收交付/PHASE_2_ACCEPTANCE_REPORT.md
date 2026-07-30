# 阶段二验收报告：业务一致性基线

日期：2026-07-30  
验收阶段：第四阶段（验收优化）  
基线提交：`d77b600 Initial project import`  
结论：**阶段二代码与自动化验收通过；当前未提交工作区不能直接作为生产制品，完成备份、副本迁移演练和发布制品评审后方可受控上线。**

## 1. 验收依据与范围

- 原始需求：阶段二“业务一致性基线”，覆盖创建负责人权限、统一负责人变更、批量事务审计、公海认领、跟进派生时间和前端跟进类型。
- 批准设计：[`SYSTEM_ANALYSIS.md`](../01-审计与设计/SYSTEM_ANALYSIS.md)、[`TECH_DESIGN.md`](../01-审计与设计/TECH_DESIGN.md)、[`DATABASE_CHANGE_PLAN.md`](../01-审计与设计/DATABASE_CHANGE_PLAN.md)、[`API_CHANGE_PLAN.md`](../01-审计与设计/API_CHANGE_PLAN.md)、[`DEVELOPMENT_PLAN.md`](../01-审计与设计/DEVELOPMENT_PLAN.md)。
- 用户补充决策：采用方案 B，删除最后一条跟进后清空 `last_follow_at`、`next_follow_at` 和来源，不恢复旧人工日期。
- 实施与独立测试：[`PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md`](../02-开发实现/PHASE_2_BUSINESS_CONSISTENCY_IMPLEMENTATION.md)、[`PHASE_2_TEST_REPORT.md`](../03-测试验证/PHASE_2_TEST_REPORT.md)。
- 本阶段未操作生产数据库，测试均使用 `/tmp` 临时 SQLite 数据库。

## 2. 已确认问题与验收修复

独立测试唯一阻断为 P1：完整 Fastify 应用在数据库事务异常时返回框架默认错误体，破坏既有 `{ code, msg, data }` 包络。

复现确认：

- 注入 `audit_logs` 写入失败后，负责人更新与审计均正确回滚。
- 修复前响应为 Fastify 默认错误 JSON，独立单项 0/1。
- 根因是 `server/src/index.ts` 在路由注册完成后才设置错误处理器，已封装路由没有继承该处理器。

验收阶段采取最小修复：

- 将原有 `app.setErrorHandler` 移到 Fastify 实例创建后、所有插件和路由注册前。
- 未改变状态码、错误文案、事务、负责人或跟进业务逻辑。
- 修复后定向回归 1/1、阶段二独立用例 6/6、全量后端测试 39/39。

未发现新的验收阻断。

## 3. 验收矩阵

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| member 创建负责人权限 | 通过 | member 省略或指定自己成功，伪造其他 `owner_id` 返回 403 且不创建记录。 |
| admin 负责人校验 | 通过 | 不存在或停用目标返回 400；服务端校验，不依赖前端下拉框。 |
| 统一负责人服务 | 通过 | 单条编辑、批量转移、公海认领共用 `transferLeadOwner`，目标必须存在且启用。 |
| 相同负责人幂等 | 通过 | `old_owner_id === new_owner_id` 返回 unchanged，不更新、不写 transfer 审计。 |
| 批量全有或全无 | 通过 | `BEGIN IMMEDIATE` 内先校验全部目标和权限，再逐条变更；缺失、越权及第二条审计故障均整体回滚。 |
| 批量逐条真实审计 | 通过 | 每条真实变化记录旧/新负责人、`source=batch_transfer`，同批共享 `operation_id`；重复 ID 去重。 |
| 公海重复认领 | 通过 | 并发式双请求仅一个成功、一个拒绝，只产生一条 `source=pool_claim` 的真实转移审计。 |
| 跟进派生字段 | 通过 | 新增、编辑、删除均事务内重算，权威顺序为 `created_at DESC, id DESC`。 |
| 删除最后一条方案 B | 通过 | `last_follow_at`、`next_follow_at`、`next_follow_at_source` 均清空。 |
| 导入一致性 | 通过 | 停用负责人回退为导入者并告警；历史跟进使用相同派生算法。 |
| 数据库迁移 | 通过 | 仅新增 `003`；可重复执行；完整性和外键检查通过；无禁止业务表。 |
| `001`、`002` 稳定性 | 通过 | checksum 分别保持 `c10d...57a0`、`db94...b0d9`，测试固定断言。 |
| API 兼容 | 通过 | 原路径不变；成功、权限、校验和事务异常均保持 `{ code, msg, data }`。 |
| 前端枚举 | 通过 | 仅“电话、微信、拜访、其他”，源码无“邮件”跟进选项。 |
| 禁止范围 | 通过 | 未新增通知队列、微信、AI、拜访计划、日报周报或 `sales_stage`；未全面调整读取权限。 |

## 4. 数据库迁移版本

| 版本 | 描述 | checksum |
| --- | --- | --- |
| `001` | `create baseline schema` | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` |
| `002` | `reconcile legacy lead and follow-up schema` | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` |
| `003` | `add owner transfer audit metadata and follow-up derivation source` | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |

`003` 增加 `audit_logs.source`、`audit_logs.operation_id`、`leads.next_follow_at_source` 和 operation ID 索引。未创建通知、微信、AI、拜访或 `sales_stage` 相关表。

## 5. 最终测试与构建

| 命令/检查 | 结果 |
| --- | --- |
| 阻断用例定向复测 | 通过，1/1 |
| `cd server && npx tsx --test test/phase2-independent-verifier.test.ts` | 通过，6/6 |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 通过，39/39 |
| `cd app && npm run build:h5` | 通过；仅提示未配置 uni Appid |
| `cd app && npm run build:mp-weixin` | 通过；仅提示未配置 uni Appid |
| `cd server && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities |
| `cd app && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities |
| `git diff --check` | 通过 |
| 前端请求静态检查 | 通过；没有新增直接 `fetch` 或 axios 调用 |
| 阶段二禁止对象静态检查 | 通过；未发现禁止表、字段或新业务实现 |

## 6. 修改范围与归因

阶段二实施修改：

- `server/src/db.ts`
- `server/src/services/lead-owner.ts`
- `server/src/services/follow-up-derived.ts`
- `server/src/routes/leads.ts`
- `server/src/routes/import_export.ts`
- `server/test/business-consistency.test.ts`
- `server/test/migrations.test.ts`
- `server/test/independent-baseline-verification.test.ts`
- `server/test/phase2-independent-verifier.test.ts`
- `app/src/pages/leads/list.vue`

验收阶段业务源码只修改：

- `server/src/index.ts`：提前注册既有全局错误处理器。

验收阶段文档：

- 本报告
- [`PHASE_2_DEPLOYMENT_NOTES.md`](PHASE_2_DEPLOYMENT_NOTES.md)
- [`PHASE_2_ROLLBACK_PLAN.md`](PHASE_2_ROLLBACK_PLAN.md)
- [`CHANGELOG.md`](../02-开发实现/CHANGELOG.md)

当前工作区还有阶段一、文档归档、前端公海页面、部署脚本、依赖锁文件等既存未提交差异；验收未回滚、清理或把这些差异全部归因于阶段二。

## 7. 已知问题与残余风险

| 严重级别 | 风险 | 影响与处置 |
| --- | --- | --- |
| 高（上线门禁） | 当前为包含多阶段和用户修改的未提交工作区 | 不能直接当作发布制品；必须逐项评审并形成可追溯 commit/制品。 |
| 高（上线门禁） | 尚未在实际生产数据库备份副本执行 `003` 和恢复演练 | 不允许把生产库作为首次试跑目标；按部署和回滚文档完成副本验证。 |
| 中 | `003` 会回填已有派生时间来源 | 上线前抽样核对最新跟进和 `next_follow_at`，保留维护窗口与数据库备份。 |
| 中 | SQLite 单应用连接测试不能完全模拟多进程写竞争 | 当前通过 `BEGIN IMMEDIATE`、旧 owner 条件更新和并发式 inject 覆盖应用路径；生产应保持单写配置并监控 `SQLITE_BUSY`。 |
| 低 | 微信小程序未配置 uni Appid | 不影响构建；正式发布前需在开发者工具中配置并复核。 |
| 后续范围 | 现有读取权限仍较宽 | 用户明确禁止本阶段全面调整；通知或 AI 上线前必须按对应批准设计单独处理。 |

## 8. 上线与回滚建议

- **阶段二验收：通过。**
- **当前工作区立即生产上线：不建议。**
- 完成发布制品评审、数据库与上传目录备份、生产库副本迁移/恢复演练、维护窗口迁移及负责人/跟进/API 包络冒烟后，可受控上线。
- 发生迁移、权限、事务、派生时间或包络问题时，按 [`PHASE_2_ROLLBACK_PLAN.md`](PHASE_2_ROLLBACK_PLAN.md) 停写、保全当前数据库并优先回退应用；不得手工删除迁移记录或直接覆盖上线后数据。

本阶段完成后停止；未生成下一阶段提示词，未提交、推送、创建 PR 或操作生产数据库。
