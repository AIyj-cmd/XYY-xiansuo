# 阶段四 DeepSeek 后端调度实现说明

## 范围

实现冻结设计的后端 Only V1：`scheduled_follow_overdue`、`daily_report`、独立 Scheduler、AI 审计表、模板降级和阶段三通知 outbox 衔接。未实现周报、H5 AI 页面、普通用户 AI 接口、真实微信/企业微信或业务自动写入。

## 数据库与兼容性

迁移 `005` 新建 `ai_request_logs`，包含固定七种状态、唯一请求/幂等/通知 operation 关联、JSON object/长度约束、生成租约与 ready/completed 状态约束及保留索引。`001` 至 `004` 没有改动。两条通知规则只在完整匹配 `004` 原始占位值时升级到受控 Mock 配置；已管理配置会令迁移失败并回滚。

## 运行边界

`xiansuo-ai-scheduler` 是单实例 fork 进程，使用绝对 `DB_PATH`、WAL、外键和 5 秒 busy timeout。其仅在上海时间配置的 08:30 / 18:00 运行；空 allowlist 是零用户。API 与通知 Worker 不解析 AI 配置、不读取 Key。

DeepSeek 适配器使用 Node 内置 `fetch`、非流式 JSON、超时/响应限制、无 tools，并且不记录授权、完整 Prompt、上下文或上游正文。当前没有真实 API Key 或真实 DeepSeek 联调；测试不发外网请求。

## 安全与权限

AI 查询使用显式字段白名单。member SQL 始终带 `owner_id = recipient_user_id AND is_deleted = 0`；admin 团队日报在运行和通知前均校验实时 admin/启用状态。手机号、微信号、密码、openid、图片、金额、审计与通知正文不进入查询上下文。上下文会清除控制字符、裁剪跟进，模型只看到 `L1...` 映射。

输出以任务专用 Zod strict schema 校验，拒绝伪造/重复引用、额外字段、手机号、微信号、JWT、Key 和高熵 secret。Provider 异常或关闭时可由 `AI_FALLBACK_ENABLED` 生成同一 Schema 的确定性模板。

独立验证后的范围内修复：到期跟进即使接收人为 admin 也始终按其本人
`owner_id` 查询；仅日报保留 admin 团队范围。Provider 请求次数在租约恢复后
按数据库预留值累计，不会被单次执行结果覆盖。启用 DeepSeek 时，显式空的
`DEEPSEEK_BASE_URL` 与缺失值一样会阻止 Scheduler 启动。

最终验收继续确认并修复了冻结范围内的边界缺口：

- 调度入口只运行当前上海时点命中的任务，并受扫描 deadline 限制；
- 到期提醒的 scope 固定为 `self`；日报查询只选取四类冻结重点线索，
  “今日到期未跟进”不混入历史逾期；
- Provider 非重试错误只计一次，保留安全错误分类，并在读取流时限制响应体；
- outbox、AI 关联和临时正文清理在同一短事务完成，创建通知前再次校验角色、
  owner 和冻结 `subject_lead_ids`；
- `ready` 临时结果过期安全转为终态后再清理，避免违反 ready 约束；
- 迁移 `005` 的迁移记录恢复会同时核验完整表、索引和两条规则目标状态，
  不能只凭同名表绕过占位保护；
- 聚合通知的人工重试按事件专用规则和实时上下文校验。

## 运维

使用 `npm run start:ai-scheduler` 或生产构建的 `deploy/ecosystem.phase4.config.cjs`。`npm run ai:dry-run -- --job scheduled_follow_overdue --user-id 1` 只读输出候选计数、排序引用、裁剪统计和 hash，不写库、不调用 Provider、不创建通知。

生产前仍须在数据库副本演练 `005`，以受控 Key 和单用户 allowlist 完成 Provider 联调；H5 没有 AI 入口，真实微信渠道不属于阶段四。
