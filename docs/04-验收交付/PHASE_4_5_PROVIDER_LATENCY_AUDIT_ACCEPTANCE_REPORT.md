# 阶段四点五 Provider 延迟审计 P2 修复验收报告

验收日期：2026-07-31
验收角色：`acceptance_optimizer`
修复分支：`fix/phase4-provider-latency-audit`
修复基线：`cd77a4523973c7727916074aecf0c7b48e80206b`

## 1. 验收结论

本轮批准范围内的 Provider 延迟审计 P2 已关闭，允许整理并创建本地提交。

实现以独立前向迁移 `006` 为 `ai_request_logs` 增加
`latency_ms`，Provider 成功和安全错误均报告单次实际调用耗时，AI
协调层在每次实际尝试结束后以数据库原子加法累计。管理员只读日志接口
可以返回该安全元数据；没有调用 Provider 的任务及升级前历史记录保持
`NULL`。

本结论只放行本地代码与文档提交，不代表允许扩大灰度、生产部署或直接
启用真实 Provider。下一步仍须使用新的隔离数据库副本，按原单用户范围
重新执行受控真实 Provider 联调，生成可以验证 `latency_ms` 的新记录。

## 2. 范围与差异验收

### 2.1 数据库

- 新增迁移：`006 / add provider latency audit to ai request logs`。
- checksum：
  `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a`。
- `001` 至 `005` 的迁移正文、版本、描述和 checksum 未修改。
- `006` 只追加：

  ```sql
  latency_ms INTEGER NULL
  CHECK (
    latency_ms IS NULL
    OR (
      typeof(latency_ms) = 'integer'
      AND latency_ms >= 0
    )
  )
  ```

- 空库可以执行 `001 → 006`，阶段四数据库可以从 `005 → 006`，重复执行
  安全跳过，checksum 冲突和迁移异常均拒绝继续。
- 迁移没有扫描、估算或回填历史耗时，没有修改线索、跟进、负责人和
  历史通知数据。

### 2.2 Provider 与累计语义

`latency_ms` 冻结为：

> 单个 AI 任务所有已经实际发生的 Provider 请求尝试累计耗时，单位为
> 毫秒；不包含数据库、调度、模板生成或通知处理时间。

- DeepSeek Provider 使用 `performance.now()` 的单调时钟计时。
- 成功、HTTP/网络错误、超时、取消、响应读取/解析及输出拒绝路径均
  产生非负整数 `latencyMs`。
- Fake Provider 使用相同安全契约，测试不访问外部网络。
- 每次实际尝试结束后调用 `addProviderLatency()`；数据库使用
  `NULL → 本次耗时`、`已有值 → 已有值 + 本次耗时`，避免重试覆盖。
- 临时失败后重试成功、两次失败后 fallback、非重试失败和租约恢复均
  保留累计值。
- `generating → ready → completed`、`generating → failed`、outbox
  关联和临时结果正文清理均不会清空或重置已有耗时。
- DeepSeek 关闭、任务/规则/捕获关闭、无候选、接收人失效、空
  allowlist 或调用前额度阻止不制造虚假耗时，数据库保持 `NULL`。

Provider 安全错误仅增加 `code`、`retryable`、`latencyMs` 这类安全
元数据；没有新增 Prompt、上下文、Authorization、API Key 或上游原始
正文的持久化和日志输出。

### 2.3 Admin API

`GET /api/admin/ai/request-logs` 的既有安全投影新增：

```json
{
  "latency_ms": 428
}
```

字段只可能是非负整数或 `null`，没有新增筛选参数。接口继续使用实时
`requireAdmin`；member 为 403，admin 降级后旧 Token 立即失效。响应
仍不包含临时结果正文、完整 Prompt、客户上下文、API Key 或上游原始
错误。

## 3. 历史记录处理

原单用户真实联调发生在迁移 `006` 之前，无法取得当时精确的 Provider
耗时。该记录升级后保持：

```text
latency_ms = NULL
```

没有根据任务总耗时、日志时间或其他间接信息估算和回填。原联调报告继续
保留 P2 事实，并追加“历史记录不回填、需用新隔离副本复验”的说明，没有
篡改当时的测试事实。

## 4. 独立测试与验收复核

`test_verifier` 独立报告结论：

- 后端测试：`121 passed / 0 failed`；
- 后端 TypeScript 构建：通过；
- H5 构建：通过；
- `git diff --check`：通过；
- P1/P2/P3：`0/0/0`。

验收阶段再次执行：

```bash
cd server
npm run build
npm test

cd ../app
npm run build:h5

git diff --check
```

复核结果：

- 后端构建：通过；
- 后端全量测试：`121 passed / 0 failed`；
- H5 构建：通过；
- `git diff --check`：通过。

测试覆盖的关键结果：

| 场景 | 验收结果 |
| --- | --- |
| 单次成功 | `321ms` |
| 临时失败后成功 | `150 + 240 = 390ms` |
| 两次失败后模板降级 | `120 + 180 = 300ms` |
| 非重试错误 | `90ms`，仅一次 |
| 租约恢复 | 原 `110 + 210 = 320ms` |
| 未调用 Provider | `NULL` |
| 历史 005 记录升级 | `NULL` |
| admin 日志 | 准确整数或 `null` |

## 5. 数据污染与安全边界

验收后 `server/data` 与实施前基线一致：

| 文件 | SHA-256 |
| --- | --- |
| `server/data/app.db` | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `server/data/app.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/app.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

本轮没有：

- 读取或注入真实 DeepSeek Key；
- 发起真实 DeepSeek 或其他外部网络调用；
- 启动 AI Scheduler 或 notification Worker；
- 修改 H5 页面；
- 修改生产数据库；
- 修改迁移 `001` 至 `005`；
- 扩大 pilot allowlist；
- 接入微信、企业微信或实现周报。

依赖及锁文件没有变化，因此不重复执行依赖审计。

## 6. 文档与部署门禁

已核对：

- `PHASE_4_5_PROVIDER_LATENCY_AUDIT_FIX.md`：准确记录实现和字段语义；
- `PHASE_4_5_PROVIDER_LATENCY_AUDIT_TEST_REPORT.md`：记录独立验证
  `121/121`；
- `PHASE_4_5_DEEPSEEK_LIVE_PILOT_REPORT.md`：保留原 P2，并说明历史
  数据不得回填；
- `PHASE_4_DEEPSEEK_BACKEND_SCHEDULING_DEPLOYMENT_NOTES.md`：生产副本
  迁移门禁更新至 `006`，要求新隔离副本重新单用户联调；
- `CHANGELOG.md`：记录迁移、累计语义、API 投影和历史处理。

部署建议：

1. 当前补丁可以创建本地提交；
2. 不允许直接扩大灰度或启用生产任务；
3. 先在新隔离数据库副本执行并验证迁移 `006`；
4. 再按原单用户、单业务日期范围进行真实 Provider 联调；
5. 核对新记录 `latency_ms`、幂等 outbox、队列 SAFE 和 Mock 投递；
6. 未完成上述复验前，不允许生产开启 DeepSeek 或真实渠道。

回滚采用前向兼容策略：关闭 AI 任务和 DeepSeek 开关，停止 AI Scheduler，
保留迁移 `006` 及历史审计数据；不提供破坏性 down migration，不删除
`latency_ms`。

## 7. 问题分级与最终放行

- P1：0
- P2：0
- P3：0

阶段四点五 Provider 延迟审计 P2 的代码、迁移、测试和文档满足批准的关闭
标准。允许创建本地提交；禁止自动重新执行真实 DeepSeek 联调、推送、
创建 PR、合并、部署或操作生产数据库。
