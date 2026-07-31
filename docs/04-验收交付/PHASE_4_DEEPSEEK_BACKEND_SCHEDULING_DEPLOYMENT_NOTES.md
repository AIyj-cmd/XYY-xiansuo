# 阶段四 DeepSeek 后端调度部署说明

## 1. 当前部署结论

本交付没有执行生产部署、真实 DeepSeek 联调或真实渠道发送。当前没有真实
API Key；H5 没有 AI 入口；真实微信和企业微信不属于阶段四。

生产部署前必须完成数据库副本迁移 `005` 和受控 Provider 联调。首次部署时
所有开关保持：

```text
DEEPSEEK_ENABLED=false
AI_SCHEDULED_FOLLOW_ENABLED=false
AI_DAILY_REPORT_ENABLED=false
AI_WEEKLY_REPORT_ENABLED=false
NOTIFICATION_CAPTURE_ENABLED=false
```

两条新通知规则在迁移后也保持 `enabled=0`。

## 2. 制品与进程

构建：

```bash
cd server
npm ci
npm run build
npm test

cd ../app
npm ci
npm run build:h5
```

阶段四新增独立 PM2 定义：

```text
deploy/ecosystem.phase4.config.cjs
xiansuo-ai-scheduler
instances=1
exec_mode=fork
```

API、通知 Worker 和 AI Scheduler 必须使用同一绝对 `DB_PATH`，但分别建立
SQLite 连接。Scheduler 连接启用 WAL、foreign keys 和
`busy_timeout=5000`。

## 3. 密钥隔离

`DEEPSEEK_API_KEY` 只能注入 `xiansuo-ai-scheduler` 进程。不得把包含 Key
的环境文件加载到：

- Fastify API；
- 通知 Worker；
- H5 构建或静态资源；
- 数据库迁移参数；
- 日志采集字段。

建议为 Scheduler 使用独立、权限 `600` 的受控 secret 注入，并在进程环境
清单中核对 API/Worker 不含 `DEEPSEEK_API_KEY`。不要把真实 Key 写入仓库的
`.env.example`、`deploy/.env.example` 或 PM2 配置。

## 4. 迁移 `005` 门禁

1. 记录当前应用提交、数据库路径和 `001` 至 `004` checksum；
2. 使用批准的 SQLite 在线备份或停机一致性备份，包含 WAL 中已提交数据；
3. 只在数据库副本运行新制品迁移；
4. 核对迁移日志 `005=applied`、`PRAGMA integrity_check=ok`、
   `PRAGMA foreign_key_check` 为空；
5. 核对 `ai_request_logs` 约束/索引和两条规则仍 `enabled=0`；
6. 人工修改过任一占位规则时，`005` 必须失败；先人工评审，不得覆盖；
7. 副本演练、备份恢复演练和变更窗口均批准后，才可迁移生产库。

迁移失败时事务整体回滚。不得修改 `001` 至 `004` 或手工伪造
`schema_migrations` 记录。

## 5. 安全灰度顺序

1. 部署 API、Worker 和 Scheduler 制品，保持全部阶段四开关关闭；
2. 使用已停止其他写入来源、WAL 已合并的一致性隔离副本执行 CLI dry-run：

   ```bash
   cd server
   DB_PATH=/absolute/path/to/copy.db npm run ai:dry-run -- \
     --job scheduled_follow_overdue --user-id 1 --business-date 2026-08-01
   ```

3. dry-run 使用 SQLite `mode=ro&immutable=1`，若发现非空 WAL 会拒绝运行；核对主库、`-wal`、`-shm` 的 hash、大小和 mtime 均未变化，并核对输出的内部 lead ID 排序证据、计数、裁剪统计、hash 和脱敏说明；
4. 按联调当日 DeepSeek 官方文档重新核验 endpoint、请求字段、JSON 输出、
   响应结构、错误码和模型名；
5. 隔离环境注入受控 Key，`AI_PILOT_USER_IDS` 只放一名启用用户；
6. 第二轮只开启到期任务和真实 Provider，保持通知 Worker 关闭，检查
   AI 日志和 outbox；首轮真实 Provider 验证建议保持 fallback 关闭，避免
   模板掩盖 Provider 失败；
7. 第三轮启动 Mock Worker 前、且紧邻启动前再次执行只读队列预检：

   ```bash
   cd server
   DB_PATH=/absolute/path/to/copy.db npm run pilot:queue-check -- \
     --recipient-user-id 1 --event-type scheduled_follow_overdue --business-date 2026-08-01
   ```

   只有 `conclusion=SAFE` 且退出码为 0 才能启动 Worker。预检只是时点证明；预检后如任一业务进程继续写入 outbox，结论立即失效，必须重新执行。预检不会取消、修改或清理任何任务，任何非 pilot 的当前可领取/可恢复任务均为 `UNSAFE`。
8. 第三轮开启 fallback 和通知 Worker，仅使用 Mock 渠道验证完整链路；
9. 稳定后再灰度 `daily_report`；
10. `AI_WEEKLY_REPORT_ENABLED` 必须保持 `false`。

真实 Key 注入前必须完成阶段四点五补丁验收。`AI_MAX_OUTPUT_TOKENS` 只由 Scheduler 读取，默认 `2048`，必须为 `256` 至 `4096` 的整数；不得把它或任何 DeepSeek 配置注入 API、Worker 或 H5。

空 `AI_PILOT_USER_IDS` 永远是零用户，不是全量。任务关闭期间不补算。

## 6. 监控信号

重点监控结构化事件：

- `database-migration` 的 `failed`；
- `ai.scheduler.start_failed`、`ai.scheduler.error`、
  `ai.scheduler.recipient_error`；
- `ai.scheduler.empty_pilot_allowlist`；
- `NOTIFICATION_CAPTURE_DISABLED`、`AI_CONTEXT_EMPTY`、
  `AI_DAILY_LIMIT_EXCEEDED`、`AI_RESULT_EXPIRED`；
- `AI_PROVIDER_TIMEOUT`、`AI_PROVIDER_UNAVAILABLE`、
  `AI_PROVIDER_RATE_LIMITED`、`AI_PROVIDER_AUTH_FAILED`、
  `AI_OUTPUT_REJECTED`；
- AI 日志长期停留 `generating`/`ready`；
- 通知日志长期停留 `pending`/`retry_wait`、`context_stale` 取消和
  `rule_disabled` 抑制；
- 全局 200/日、单用户 4/日额度和 fallback 比例。

日志不得包含 Authorization、Key、完整 Prompt、完整上下文或上游错误正文。

## 7. 上线后核对

- API 和现有 `owner_changed` 正常；
- API/Worker 进程环境没有 DeepSeek Key；
- H5 产物没有 DeepSeek 配置或 AI 入口；
- Scheduler 只有一个实例；
- 08:30 只运行到期提醒，18:00 只运行日报；
- 通知中的总候选数与截断前统计一致；
- 无权限变化导致的越权消息，stale 任务整体取消；
- 无真实消息渠道调用。
