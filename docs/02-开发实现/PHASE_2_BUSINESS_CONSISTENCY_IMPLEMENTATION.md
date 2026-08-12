# 阶段二业务一致性基线实施报告

日期：2026-07-30
范围：负责人授权与转移一致性、跟进派生时间一致性；不含通知、微信、AI 或拜访计划。

## 基线与保护措施

- 起始提交为 `d77b600 Initial project import`。
- 实施开始时工作区已经包含阶段一和用户的未提交修改；未执行回滚、清理、提交、推送或生产数据库操作。
- 所有新增自动化测试均使用 `/tmp` 下独立 SQLite 文件或内存数据库，并在结束时关闭连接、删除临时目录。

## 实现内容

- 新增 `server/src/services/lead-owner.ts`：负责人必须存在且启用；单条编辑、批量转移和公海认领共用同一真实变更服务。负责人未改变时不更新、不写重复审计。
- 创建线索时 member 只能指定自己；admin 才可指定其他已启用负责人。批量和单条转移同样拒绝不存在或停用负责人。
- 批量转移使用 `BEGIN IMMEDIATE`：先验证全部线索和权限，再逐条变更并写入真实旧/新负责人审计；任一审计或更新失败会整体回滚。一个批次共享一个 `operation_id`。
- 新增迁移 `003`：为 `audit_logs` 增加 `source`、`operation_id`，为 `leads` 增加 `next_follow_at_source`；回填已有跟进的最新派生日期和来源。未修改 `001`、`002` 的版本、描述、实现或 checksum。
- 新增 `server/src/services/follow-up-derived.ts`：跟进新增、编辑和删除均在事务内按 `created_at DESC, id DESC` 重算 `last_follow_at`、`next_follow_at`。按用户确认的方案 B，删除最后一条跟进后两项均清空，来源也清空。
- 导入入口不再把线索分配给停用用户；导入有跟进记录时调用同一派生重算逻辑。
- 前端跟进方式仅保留“电话、微信、拜访、其他”，移除“邮件”。

## 迁移

| 版本 | 描述 | checksum |
| --- | --- | --- |
| `003` | `add owner transfer audit metadata and follow-up derivation source` | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |

已在测试中断言既有 checksum 保持：

- `001`: `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0`
- `002`: `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9`

部署前仍须对实际生产 `DB_PATH` 创建 SQLite 备份副本并在副本演练；本阶段没有操作生产数据库。

## 修改范围

- `server/src/db.ts`
- `server/src/services/lead-owner.ts`（新增）
- `server/src/services/follow-up-derived.ts`（新增）
- `server/src/routes/leads.ts`
- `server/src/routes/import_export.ts`
- `server/test/business-consistency.test.ts`（新增）
- `server/test/migrations.test.ts`
- `server/test/independent-baseline-verification.test.ts`
- `app/src/pages/leads/list.vue`

## 验证结果

- `cd server && npm run build`：通过。
- `cd server && npm test`：33/33 通过。覆盖 member 伪造负责人、停用负责人、单条/批量来源与 operation_id、相同负责人无重复审计、失败回滚、公海重复认领、同时间戳以更大 id 为最新、编辑/删除/删除最后跟进、003 回填、既有 checksum 和前端枚举。
- `cd app && npm run build:h5`：通过。
- `cd app && npm run build:mp-weixin`：通过（仅提示未配置 uni Appid，未影响构建）。
- `git diff --check`：通过。

## 交给独立验证的重点与剩余风险

- 复核导入 multipart 场景下停用跟进人回退到导入者并保留警告的端到端行为。
- 复核并发公海认领、批量事务和异常审计写入的独立隔离行为。
- 现有工作区仍包含大量未提交差异，不能直接视为已部署制品。
- 未实施任何通知、微信、DeepSeek/AI、拜访计划、日报周报、`sales_stage` 或读取权限全面调整。
