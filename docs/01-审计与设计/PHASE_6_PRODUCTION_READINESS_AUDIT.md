# 阶段六生产就绪审计

状态：**未获准上线（NO-GO）**。本文记录的是生产就绪审计，不是生产部署记录。

## 审计边界与基线

- 审计分支：`validation/phase6-production-readiness`
- 审计基线提交：`0fba8665efa89e253221fb911dde2138dcca3a57`
- 本轮仅交付文档；未修改源码、依赖、锁文件、迁移、数据库或生产配置。
- 未将仓库默认配置、本机服务、`server/data` 或临时目录视为生产环境。
- 未取得真实生产项目、生产数据库、H5 静态目录、Nginx 配置、PM2 配置/进程、备份目录、恢复目录及生产数据库只读备份的确认或授权；本文不记录其路径、客户数据或任何密钥。

## 已知运行环境事实

| 项目 | 观察结果 |
| --- | --- |
| Node.js / npm | `v24.18.0` / `11.16.0` |
| sqlite3 CLI | `3.45.1` |
| PM2 | `7.0.1` |
| Nginx | `nginx` 命令不存在，不能据此判断生产服务器状态 |
| 本机 PM2 进程 | 仅见其他项目 `deepseekv4pro`、`xyy-cms`、`xyy-web`；未见 xiansuo API、通知 Worker、AI Scheduler、OpenClaw、iLink 或微信进程 |

## 代码与制品边界核验

- 仓库 Nginx 模板为 HTTPS 终止并反代至 `127.0.0.1:3000`；该模板不能代替实际生产 Nginx 核验。
- H5 由 Fastify 静态同源托管，并使用 SPA fallback；实际生产静态制品目录与反代配置未提供，不能验证。
- 仓库主 PM2 配置只定义 xiansuo API，敏感 AI/渠道凭证不在其中；阶段三/四的 Worker 与 AI Scheduler 是独立配置，按当前渠道策略不应启动。实际生产 PM2 配置和进程未提供，不能验证。
- 所有真实外部消息渠道均暂停。无 DeepSeek、真实消息、微信、OpenClaw、iLink 或其他渠道操作。

## 功能与展示口径

H5 的 `GET /api/notifications` 只读 `audit_logs` 中的负责人转移事件及本人 `leads.next_follow_at` 的逾期信息；它不读取 `notification_logs`。因此 `scheduled_follow_overdue`、`daily_report` 和阶段四 AI 结果当前不会展示在 H5 通知页。此为当前实现事实，不得通过启动 Worker、Scheduler、DeepSeek 或 AI job 规避。

生产环境必须保持以下开关关闭：

```text
NOTIFICATION_CAPTURE_ENABLED=false
NOTIFICATION_WORKER_ENABLED=false
NOTIFICATION_SCHEDULER_ENABLED=false
DEEPSEEK_ENABLED=false
AI_SCHEDULED_FOLLOW_ENABLED=false
AI_DAILY_REPORT_ENABLED=false
AI_WEEKLY_REPORT_ENABLED=false
LEAD_POOL_CLAIM_ENABLED=false
VITE_LEAD_POOL_CLAIM_ENABLED=false
NOTIFICATION_MOCK_ENABLED=false
```

真实渠道保持全部关闭；公海认领的服务端、构建期 VITE 开关与 Mock 均为 `false`。

## 数据库与可恢复性审计

已通过的代码级迁移/回归测试为 `121/121`，仅证明受控测试数据库的代码行为。迁移冻结校验和如下：

| 版本 | SHA-256 checksum |
| --- | --- |
| 001 | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` |
| 002 | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` |
| 003 | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |
| 004 | `61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75` |
| 005 | `8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346` |
| 006 | `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a` |

未执行且不得表述为已通过的事项：生产数据库一致性备份、生产备份副本的 `001–006` migration-copy、从该副本 restore-copy、实际生产 Nginx/PM2 核验，以及旧生产制品回滚演练。

## 审计结论

当前不能作出生产可用结论。先修复 H5 锁文件的可复现安装问题，再取得并确认生产输入与只读备份授权，完成真实一致性备份副本迁移/恢复、实际运行配置核验和旧制品回滚演练，才可重新评审。
