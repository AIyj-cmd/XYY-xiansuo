# 阶段四 DeepSeek 后端调度能力独立测试报告

状态：通过，允许进入验收阶段。

## 测试计划

1. 固化 Git、`server/data` 哈希与实现差异基线，确保测试不写入正式数据库。
2. 独立审查迁移 005、严格配置、权限查询、上下文/输出校验和 Provider 实现；对照冻结设计列出可重现缺陷。
3. 使用新建的临时 SQLite 数据库和 Fake Provider 执行独立自动化测试，覆盖调度、幂等、恢复、权限失效和通知行为。
4. 运行后端构建/全量测试、H5 构建、差异一致性检查；锁文件或依赖发生变化时运行生产依赖审计。
5. 复查测试后基线并记录通过、失败、未执行项和是否允许进入验收。

## 测试前基线

- 分支：`feature/phase4-deepseek-backend-scheduling`
- HEAD：`e9a155e7a442b418b02454db094565666ecebc96`
- 测试开始时实现仍未提交；下文统一记为“实现前存在的差异”，不属于测试阶段。
- 开始时 `git diff --check`：通过。
- 开始时 `server/data/*` SHA-256：详见最终结果节。

## 测试范围与方法

- 迁移：空库 001至005、从 004 升级、幂等、checksum 冲突、事务回滚、人工修改占位通知规则的拒绝更新，以及 AI 表约束。
- 配置与运行隔离：默认关闭、严格布尔/时间/allowlist 解析、空 allowlist、Provider 开关与 fallback 语义、空 Base URL 门禁。
- 权限与数据最小化：member owner 隔离、admin 日报实时角色、到期任务对 admin 仍严格按 owner 筛选、停用/降级/负责人变化的 context_stale、字段白名单、裁剪、item_ref 和脱敏。
- Provider 与输出：仅使用 Fake Provider 或 mock fetch 覆盖成功、HTTP 502 不重试、严格 JSON Schema 拒绝；连接未使用真实 DeepSeek。
- 状态机与通知：幂等、租约恢复、Provider 请求累计额度、模板降级、通知抑制、Worker 租约/上下文校验和 owner_changed 回归。
- 接口与静态边界：admin 只读日志分页/筛选/实时降级和敏感字段不泄露；检查不存在普通用户 AI HTTP 入口、weekly 实际任务或 H5 AI 入口。

## 独立新增测试

`server/test/phase4-independent-verifier.test.ts` 新增 6 项且复测通过：

1. Provider 启用且 `DEEPSEEK_BASE_URL=''` 拒绝启动；
2. `scheduled_follow_overdue` 对 admin 也只查询其本人 owner 线索；
3. HTTP 502 不属于允许重试集合；
4. mock Provider 响应仍受严格 Schema 校验；
5. 租约恢复后所有已发 Provider 请求保留累计 `attempt_count`；
6. `GET /api/admin/ai/request-logs` 验证实时 admin、降级后立即 403、分页筛选和无结果/上下文泄露。

## 已执行命令和结果

| 命令 | 结果 |
| --- | --- |
| `cd server && npx tsx --test test/phase4-independent-verifier.test.ts` | 6 通过，0 失败 |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 71 通过，0 失败，0 skipped |
| `cd app && npm run build:h5` | 通过 |
| `cd server && DB_PATH=/tmp/... npm run ai:dry-run -- --job daily_report --user-id 1 --business-date 2026-01-02` | 通过；DB 哈希前后一致，未写库、未请求 Provider |
| `git diff --check` | 通过 |
实现仅变更了 `server/package.json` 中的 scripts，未变更生产依赖或锁文件，因此不需新增 `npm audit --omit=dev`。所有 Provider 测试均为 Fake Provider 或本地 mock fetch；未进行真实网络访问、未使用真实 API Key。

## 修复复测

首轮独立测试发现三项缺陷，实现方在冻结范围内修复后已全部复测通过：

| 级别 | 问题 | 复测结果 |
| --- | --- | --- |
| P1 | admin 到期任务误读团队线索 | 已改为严格 `owner_id=recipient.id` |
| P1 | 租约恢复后覆盖累计 Provider 尝试次数 | 已保留累计 `attempt_count=2` |
| P2 | 显式空 Base URL 被默认 URL 掩盖 | 已在 Provider 启用时拒绝启动 |

## 未覆盖范围与残余风险

- 本阶段按批准边界不进行真实 DeepSeek 联调、真实密钥注入或真实微信渠道测试。它些仍是上线前受控环境门禁，不是本次测试失败。
- 未执行小程序构建；用户授权仅要求 H5 验证。
- 无未解决 P1/P2/P3。

## 数据与工作区复核

`server/data` 在测试前后保持一致：

```text
c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3  server/data/app.db
fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb  server/data/app.db-shm
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  server/data/app.db-wal
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  server/data/leads.db
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  server/data/xiansuo.db
```

测试阶段只新建了本报告与
`server/test/phase4-independent-verifier.test.ts`。其他当前差异均为实现阶段已存在的变更；没有被恢复、覆盖或清理。

## 结论

允许进入验收阶段。测试基线上无未解决 P1/P2，无真实外部网络、生产数据库或密钥操作。

## 验收阶段补充说明

本报告以上内容保留 `test_verifier` 阶段当时的独立测试事实，不改写其
`71/71` 历史数字。最终验收的进一步代码审查发现并修复了该阶段用例未覆盖
的范围内问题，包括任务时点分派、日报重点口径、创建通知前上下文复核、
Provider 非重试计数、响应体流式限制、`ready` 结果清理、迁移恢复校验和
聚合通知人工重试。

补充测试位于
`server/test/phase4-acceptance-regression.test.ts`。最终全量后端回归为
`97` 通过、`0` 失败、`0` skipped；H5 构建、`git diff --check` 和
`server/data` 哈希复核均通过。验收修复后无未解决 P1/P2/P3。最终门禁和
上线建议以阶段四验收报告为准。
