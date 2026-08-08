# 阶段四点五 Provider 延迟审计 P2 修复：独立测试报告

测试日期：2026-07-31
测试角色：`test_verifier`（独立验证）
结论：通过，允许进入验收阶段。

## 1. 测试基线与边界

- 分支：`fix/phase4-provider-latency-audit`
- 测试前 HEAD：`cd77a4523973c7727916074aecf0c7b48e80206b`
- 测试前工作区包含实施阶段未提交的 P2 修复；未恢复、覆盖或清理任何文件。
- 未读取或使用任何 DeepSeek 密钥文件；未调用真实 Provider、未访问外网、未启动 AI Scheduler 或通知 Worker。
- 所有迁移和 API 测试使用内存或 `/tmp` 临时数据库；未访问或修改生产数据库。

测试计划：验证 006 的前向迁移及约束、Provider 尝试耗时的累计和状态保留、管理员安全投影与实时授权，再运行全量后端/H5 回归及本地数据库污染检查。

## 2. 迁移与数据完整性

验证 `server/src/db.ts` 仅追加迁移 `006`：

- 版本、描述和 checksum：`006` / `add provider latency audit to ai request logs` /
  `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a`。
- 空库可从 `001` 完整迁移至 `006`；005 数据库可升级至 006；重复运行跳过已应用版本。
- `001`–`005` 的版本、内容和 checksum 未变；006 checksum 冲突被拒绝。
- `latency_ms` 接受 `NULL` 和非负整数，拒绝负数、浮点数和文本；历史 005 AI 记录升级后保持 `NULL`。
- 测试人为失败迁移时事务回滚，不留下测试表；`PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 为空。
- 未发现线索、跟进、负责人或历史通知数据的迁移副作用。

## 3. Provider 延迟累计

独立验证 `addProviderLatency()` 使用数据库原子加法而非覆盖，并验证服务层在每次实际 Provider 尝试结束后调用记录器。

| 场景 | 期望 | 结果 |
| --- | --- | --- |
| 单次成功 | `321` | 通过 |
| 临时失败后成功 | `150 + 240 = 390` | 通过 |
| 两次失败后模板降级 | `120 + 180 = 300` | 通过 |
| 非重试错误 | 一次 `90`，不重试 | 通过 |
| 租约恢复 | 已有 `110` 加本次 `210`，等于 `320` | 通过 |
| `generating → ready → completed` | 延迟不清空 | 通过 |
| `generating → failed` | 延迟不清空 | 通过 |
| 未调用 Provider | `NULL`，不使用 `0` | 通过 |

DeepSeek Provider 和 Fake Provider 均使用 `performance.now()`，成功、HTTP/网络失败、超时、取消、读取/解析和输出拒绝路径都会给已实际发起的调用返回非负整数 `latencyMs`。调用前取消、关闭 DeepSeek、规则/捕获关闭、空上下文或额度阻止不会伪造耗时。独立 mock-fetch 冒烟验证了成功和 503 安全错误均携带非负整数延迟，且无外网请求。

## 4. 管理 API 与安全

验证 `GET /api/admin/ai/request-logs`：

- 安全投影返回 `latency_ms` 的非负整数或 `null`。
- 不返回 `result_snapshot_json`、Prompt、上下文、API Key 或上游原始错误。
- member 返回 403；member 临时升为 admin 后可访问，降回 member 后旧 Token 立即恢复 403。
- 分页和既有筛选回归通过。

## 5. 已执行命令

```bash
cd server && npm run build
cd server && npm test
cd app && npm run build:h5
git diff --check
```

结果：

- 后端 TypeScript 构建：通过。
- 后端测试：`121 passed / 0 failed`。
- H5 构建：通过。
- `git diff --check`：通过。

## 6. 本地数据库污染检查

测试前后 `server/data` 哈希一致：

| 文件 | SHA-256 |
| --- | --- |
| `server/data/app.db` | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `server/data/app.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/app.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

## 7. 问题分级与放行

- P1：0
- P2：0（本轮 Provider 延迟持久化缺口已被测试覆盖）
- P3：0

未发现阻止验收的问题。允许进入 `acceptance_optimizer` 验收；验收不得读取密钥、调用真实 DeepSeek 或自动重启真实单用户联调。

## 8. 测试阶段文件变化

本测试阶段仅新增本报告。其余未提交代码、测试和文档差异均为实施阶段已有内容，未由测试代理修改。
