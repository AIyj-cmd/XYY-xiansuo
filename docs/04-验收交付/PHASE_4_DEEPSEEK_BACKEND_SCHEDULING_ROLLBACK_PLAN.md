# 阶段四 DeepSeek 后端调度回滚方案

## 1. 回滚原则

- 先止住新任务，再处理已生成 outbox；
- 停止 AI Scheduler 不影响 Fastify API、通知 Worker 或
  `owner_changed`；
- 不执行破坏性 down migration，不删除 `ai_request_logs`；
- 不删除通知历史、业务线索、跟进或审计数据；
- 不补算任务关闭期间的业务日期；
- Key 只在 Scheduler 进程轮换或撤销。

## 2. 功能级回滚

按顺序设置并重启 AI Scheduler：

```text
AI_SCHEDULED_FOLLOW_ENABLED=false
AI_DAILY_REPORT_ENABLED=false
AI_WEEKLY_REPORT_ENABLED=false
DEEPSEEK_ENABLED=false
```

若需要保留任务但停止 Provider，可只关闭 `DEEPSEEK_ENABLED`：

- `AI_FALLBACK_ENABLED=true`：已开启 job 继续使用确定性模板；
- `AI_FALLBACK_ENABLED=false`：已开启 job 记录 skipped，不创建通知。

确认不再领取新 AI 任务后停止 `xiansuo-ai-scheduler`。SIGTERM 会停止新领取
并等待当前有限任务结束。

## 3. 通知侧隔离

如需立即阻止阶段四聚合通知发送：

1. 先停止通知 Worker；
2. 只读查询
   `event_source='ai_scheduler' AND status IN ('pending','retry_wait','sending')`
   的行数和 operation ID；
3. 在批准的维护事务内把这些行转为
   `cancelled/phase4_rollback`，清理租约并设置保留期限；
4. 核对 `owner_changed` 行未被修改；
5. 再恢复通知 Worker。

不要删除 outbox 行，也不要把已取消任务改回 pending。同日不重新生成。

## 4. 代码级回滚

1. 完成功能级回滚和通知侧隔离；
2. 保存数据库一致性备份和当前阶段四日志；
3. 回退 API、Worker、Scheduler 制品到上一批准版本；
4. 不回退 `schema_migrations` 的 `005` 记录，不删除新增表或索引；
5. 只启动旧 API/Worker，保持 Scheduler 停止；
6. 验证登录、线索、跟进、owner_changed、通知管理 API 和 H5。

旧制品不应处理阶段四聚合 outbox，因此代码回滚前必须先隔离这些未终态行。

## 5. 迁移失败恢复

`005` 在单一迁移事务中执行。若副本或生产迁移失败：

- 保持应用未切换；
- 核对两条通知规则是否偏离 `004` 原始占位状态；
- 核对迁移日志中没有 `005` 完成记录；
- 不手工覆盖规则，不伪造 checksum；
- 修复原因后重新从一致性备份副本演练。

只有在生产迁移已造成无法通过事务自动回滚的外部故障，且服务尚未恢复写入
时，才考虑恢复迁移前整库备份。恢复必须包含 WAL 一致性并执行 integrity 和
foreign-key 检查。

## 6. Provider 或密钥事件

发现 Key 泄露、认证异常或异常费用时：

1. 关闭两个具体 job 和 `DEEPSEEK_ENABLED`；
2. 停止 Scheduler；
3. 在 Provider 控制台撤销/轮换 Key；
4. 检查 Scheduler 环境和日志，确认 API、Worker、H5、数据库无 Key；
5. 保留安全元数据，不复制上游原始正文；
6. 完成事件评审和受控联调后再灰度。

## 7. 回滚验收

- Scheduler 已停止或所有 job 关闭；
- Provider 请求数不再增长；
- 阶段四未终态聚合通知已隔离；
- `owner_changed` 和普通 API 无回归；
- `001` 至 `004` checksum 保持不变；
- `005` 表和历史记录保留；
- 无业务数据、通知历史或审计日志被删除；
- 没有真实微信/企业微信调用。
