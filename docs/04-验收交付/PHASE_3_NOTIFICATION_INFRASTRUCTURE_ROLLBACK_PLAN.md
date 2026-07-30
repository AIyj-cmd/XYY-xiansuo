# 阶段三通知基础设施回滚计划

## 1. 回滚原则

- 公海待认领关闭是最低安全基线，任何回滚都不得重新开放 `GET /api/pool` 或 `POST /api/pool/:id/claim`。
- 线索池、“全部线索”和 `GET /api/leads` 必须继续可用。
- 不删除迁移 `004`、通知表、历史 `pool_claim`、负责人、线索、跟进或审计。
- 不提供破坏性 down migration，不手工伪造或删除 `schema_migrations`。

## 2. 首选应用回滚

1. 停止 Worker，等待当前最多 10 秒优雅退出。
2. 设置：

```text
NOTIFICATION_WORKER_ENABLED=false
NOTIFICATION_CAPTURE_ENABLED=false
NOTIFICATION_MOCK_ENABLED=false
NOTIFICATION_SCHEDULER_ENABLED=false
LEAD_POOL_CLAIM_ENABLED=false
```

3. 关闭 `owner_changed` 规则；其 pending/retry_wait 按规则更新事务取消。
4. 保留迁移 `004`、终态记录和未删除的通知历史。
5. 回滚通知运行逻辑时，以实现提交 `0f0c4a261fe66d54d6557dea88f2ce0422a73800` 的关闭配置制品作为最低安全基线；不得整体回到设计基线 `9a8fe40c...`。
6. 验证两个公海接口为 403，同时线索池和全部线索正常。

如果只能使用不识别 `LEAD_POOL_CLAIM_ENABLED` 的旧后端，必须先在反向代理精确阻断：

```text
GET  /api/pool
POST /api/pool/:id/claim
```

不得阻断 `GET /api/leads`、线索详情或前端线索池页面。

## 3. 故障场景

### Worker 或 Mock 故障

- 先关闭 Worker，保留 pending/retry_wait。
- Mock 关闭后不得启用引用 Mock 的规则。
- 修复配置后，只通过受限 admin retry 重试符合条件的 failed；不得重发 sent/suppressed/cancelled/expired。

### 捕获写入阻断业务

- 紧急设置 `NOTIFICATION_CAPTURE_ENABLED=false`。
- 负责人变化和 transfer audit 继续；记录 `notification.capture.disabled`。
- 明确记录窗口起止时间；该期间事件不会补发，不扫描历史 audit_logs 回填。

### SQLite 锁竞争

- 停止 Worker，保留 API。
- 确认单 Worker、绝对同库路径、WAL 和 `busy_timeout=5000`。
- 不通过复制活动 WAL 文件或启动第二 Worker 规避。

### 迁移 `004` 失败

- 阻止应用启动。
- 从上线前完整备份恢复整个 SQLite 数据库到隔离位置并验证。
- 查明失败原因后重新在副本演练。
- 不删除单表、不改 checksum、不跳过失败迁移。

## 4. 数据库恢复

只在迁移失败且应用尚未接受新写入时，使用上线前一致性备份整体恢复。若迁移后已有业务写入，不得直接覆盖生产库；先停止写入并制定单独的数据恢复方案。

恢复后检查：

- `PRAGMA integrity_check`；
- `PRAGMA foreign_key_check`；
- `001/002/003` checksum；
- 历史 `pool_claim` 数量和内容；
- leads、follow_ups、owner_id 和 audit_logs；
- 公海接口仍由应用或反向代理阻断。

## 5. 回滚完成标准

- API 可用且线索池“全部线索”无回归；
- 两个公海接口不可调用；
- Worker 不领取新任务；
- 没有删除或改写业务及历史审计；
- 未产生历史 audit_logs 到 notification_logs 的回填；
- 故障时间、开关变化、备份和验证结果有运维记录。
