# 阶段二业务一致性基线：独立测试报告

状态：不通过（等待验收阶段修复 1 个 P1）
日期：2026-07-30

## 测试计划

1. 记录测试前 Git 基线，区分阶段一、文档归档和实施阶段的既有未提交改动。
2. 使用独立临时 SQLite 数据库与 Fastify inject 验证负责人创建、单条转移、批量转移、公海认领及其越权、停用目标、幂等和回滚路径。
3. 验证跟进新增、编辑、删除后的派生时间，包含相同 `created_at` 时按 `id DESC` 决胜，以及方案 B 的“删除最后一条后清空”。
4. 验证导入停用负责人回退、导入跟进派生时间、迁移 `003` 的重复执行、`001/002` checksum、完整性与外键检查。
5. 运行后端构建和全量测试、H5/微信小程序构建、差异空白检查，以及本阶段禁止对象与前端枚举静态检查。

## 测试前工作区基线

- 提交：`d77b600 Initial project import`
- `git status --short`：工作区已有阶段一、文档归档、前端、部署和后端未提交改动；详见最终“归因”章节。测试不会回滚、覆盖或清理这些改动。
- `git diff --name-only`：测试开始时已包含 `server/src/db.ts`、`server/src/routes/leads.ts`、`server/src/routes/import_export.ts`、`app/src/pages/leads/list.vue`、既有测试与文档等差异。

## 测试范围与结果

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| member 创建伪造负责人、admin 不存在/停用负责人、响应包络 | 通过 | 独立用例第 1 项 |
| 单条/批量负责人变更、批次 `operation_id`、去重、越权/缺失全回滚 | 通过 | 独立用例第 2 项；临时 trigger 注入审计失败 |
| 公海重复/并发式认领不重复审计 | 通过 | 独立用例第 3 项，两个并发 inject 返回 200/400，只有一条 `pool_claim` 审计 |
| 跟进新增、编辑、删除、同时间按 `id DESC`、删除最后一条方案 B | 通过 | 独立用例第 4 项 |
| 导入停用负责人及导入历史跟进派生 | 通过 | 独立用例第 4 项，真实 multipart xlsx 注入 |
| `003` 可重跑、`001/002` checksum、外键/完整性、禁止对象 | 通过 | 独立用例第 5 项 |
| 事务异常时原 API `{ code, msg, data }` 包络 | **失败（P1）** | 独立用例第 6 项；完整 `buildApp()` 复现 |
| 前端跟进方式和禁止业务静态检查 | 通过 | 无“邮件”枚举；无通知/微信/AI/拜访计划/`sales_stage` 新对象命中 |

## 已执行命令

| 命令 | 结果 |
| --- | --- |
| `cd server && npx tsx --test test/phase2-independent-verifier.test.ts` | 5/6 通过；仅完整应用异常包络用例失败。 |
| `cd server && npm run build` | 通过。 |
| `cd server && npm test` | **38/39 通过、1 失败**；唯一失败为完整应用异常包络用例。 |
| `cd app && npm run build:h5` | 通过。 |
| `cd app && npm run build:mp-weixin` | 通过；仅提示未配置 uni Appid。 |
| `cd server && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities。 |
| `cd app && npm audit --omit=dev --audit-level=high` | 通过，0 vulnerabilities。 |
| `git diff --check` | 通过，无输出。 |

## 失败项

### P1：完整应用在事务错误路径破坏既有响应包络

- 预期：数据库事务内审计写入失败时返回 HTTP 500，响应仍为 `{ code, msg, data }`。
- 实际：HTTP 500 响应为 Fastify 默认错误格式：

  ```json
  {"statusCode":500,"code":"ERR_SQLITE_ERROR","error":"Internal Server Error","message":"forced full application failure"}
  ```

- 最小复现：在临时 SQLite 库创建 member、启用目标负责人和该 member 的线索；创建 `BEFORE INSERT ON audit_logs` trigger 并 `RAISE(ABORT, ...)`；以 member 调用 `PATCH /api/leads/:id` 修改 `owner_id`。
- 数据一致性：负责人和审计均已正确回滚，问题限定为错误响应兼容性。
- 定位：`server/src/index.ts` 在注册路由后才设置 `app.setErrorHandler`；已注册的封装路由未继承该处理器，落入 Fastify 默认错误体。
- 建议：在路由注册前设置根级错误处理器，或以等效方式确保已注册路由的异常统一进入现有 `{ code, msg, data }` 包络；修复后重新运行本报告中的独立用例、`npm test` 和后端构建。

## 未覆盖范围

- 没有访问生产数据库、真实生产环境或外部微信/AI 服务（均不在本阶段范围）。
- `node:sqlite` 的单连接 Fastify inject 无法形成跨进程写入竞争；已用同时发起的认领请求和旧 owner 条件更新覆盖应用层重复认领路径。
- 本轮禁止全面读取权限调整，故未将跟进作者权限改为 owner-only；该旧规则仅按既有行为回归。

## 安全与边界检查

- `rg` 未发现前端“邮件”跟进枚举。
- 阶段二差异范围未发现 `notification_rules`、`notification_logs`、`wechat_bindings`、`visit_plans`、AI 表或 `sales_stage`。
- `app/src` 未发现直接 `fetch(` 或 axios 调用；请求封装仍位于 `app/src/utils/request.ts`。
- 外键与 `PRAGMA integrity_check` 在独立临时数据库迁移用例中通过。

## 测试阶段文件变化与归因

- 测试阶段新增：`server/test/phase2-independent-verifier.test.ts`、本报告。
- 测试阶段未修改 `server/src`、`app/src`、`scripts` 或 `deploy` 的业务/部署实现。
- 测试后 `git status --short` 与开始时相同的阶段一、文档归档和实施阶段大量未提交改动仍存在；其中 `docs/`、`server/test/` 在测试前已是未跟踪目录，不能把其全部内容归因于测试阶段。
- 未执行回滚、清理、提交、推送或生产数据库操作。

## 放行结论

**不允许无条件进入验收阶段。** 负责人授权、批量事务、派生时间、导入、迁移及前端枚举均通过独立验证；但 P1 错误响应兼容性失败。仅在验收阶段于批准范围内修复并复测通过后，才可进入最终验收结论。
