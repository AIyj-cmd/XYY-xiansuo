# 阶段四 DeepSeek 后端调度能力验收报告

状态：代码验收通过；不批准直接开启真实 Provider 或生产任务。

验收日期：2026-07-31

## 1. 验收基线与依据

- 分支：`feature/phase4-deepseek-backend-scheduling`
- 冻结设计提交：`e9a155e7a442b418b02454db094565666ecebc96`
- 批准设计：
  `docs/01-审计与设计/PHASE_4_DEEPSEEK_BACKEND_SCHEDULING_DESIGN.md`
- 实施说明：
  `docs/02-开发实现/PHASE_4_DEEPSEEK_BACKEND_SCHEDULING_IMPLEMENTATION.md`
- 独立测试报告：
  `docs/03-测试验证/PHASE_4_DEEPSEEK_BACKEND_SCHEDULING_TEST_REPORT.md`

验收核对了用户完整实现要求、冻结设计、全部工作区差异、Git 历史、迁移、
权限、Provider、调度、通知衔接、API、CLI 和交付文档。没有重做产品设计，
没有新增依赖、真实渠道、H5 AI 入口或周报任务。

## 2. 业务与技术结论

阶段四 V1 的批准范围已经实现：

- 独立 `xiansuo-ai-scheduler` 进程；
- `scheduled_follow_overdue` 和 `daily_report` 两项任务；
- DeepSeek、任务和 fallback 三层开关语义分离且默认安全关闭；
- member owner 隔离和 admin 团队日报实时角色校验；
- 字段白名单、跟进裁剪、脱敏、Prompt 数据边界和严格输出 Schema；
- Provider 抽象、Fake Provider 和 Node 内置 `fetch` 适配器；
- AI 幂等、租约、额度、恢复、临时结果和元数据清理；
- 阶段三 outbox、Mock Worker、事件快照和发送前 `context_stale` 校验；
- admin-only `GET /api/admin/ai/request-logs` 和只读 CLI dry-run。

明确未实现：`weekly_report` 实际任务、普通用户 AI API、H5 AI 页面/按钮/
聊天、真实微信或企业微信、自动业务写入、工具调用、RAG 和生产部署。

## 3. 验收发现与修复

| 级别 | 已确认问题 | 修复与复测 |
| --- | --- | --- |
| P1 | 任一任务时间命中时会同时运行两个已启用 job，日报可能在 08:30 提前生成 | 按上海时点显式选择 job，并加入扫描 deadline；回归通过 |
| P1 | 通知创建前只校验接收人，未复核 member owner、admin role 和冻结线索集合 | outbox 前完整实时复核；失效任务原子转 `cancelled/context_stale`；回归通过 |
| P2 | 日报重点查询把非四类普通线索纳入，今日到期统计混入历史口径 | 严格限定四类重点并按生成时点稳定排序；修正当日到期口径；回归通过 |
| P2 | 非重试 Provider 错误 fallback 时可能错误记录两次尝试 | 以实际已预留请求计数，保存安全原错误分类；回归通过 |
| P2 | Provider 在读取完整正文后才检查大小 | 改为流式上限读取，并覆盖超长、超时、取消和错误码；回归通过 |
| P2 | `ready` 临时结果过期直接清空会违反 ready 约束 | 先安全转 `failed/AI_RESULT_EXPIRED` 再清理；回归通过 |
| P2 | 迁移记录丢失恢复只凭同名表存在，可能绕过规则占位保护 | 同时核验完整列、索引、关键约束和两条规则目标状态；回归通过 |
| P2 | outbox 与 AI 完成关联分属两个事务，聚合人工重试仍按 owner_changed 校验 | 改为同一短事务关联和清正文；人工重试按事件专用规则复核；回归通过 |
| P3 | `AI_MAX_FOLLOW_UP_RECORDS` 未实际作用于上下文，PM2 会用默认值掩盖显式空配置 | 配置贯通上下文，PM2 仅对未定义值使用默认值；回归通过 |

验收修复没有放宽断言、删除测试或改变批准业务边界。

## 4. 关键验收矩阵

| 范围 | 结论 |
| --- | --- |
| 迁移 | `001` 至 `004` 内容/checksum 不变；`005` 原子升级、占位保护、约束、索引和恢复通过 |
| 配置/进程 | 全部默认关闭；非法配置拒绝 AI Scheduler；API/Worker 不解析 AI 配置 |
| 权限 | 到期提醒始终本人 owner；member 日报本人范围；admin 团队日报实时校验；创建和发送前 stale 取消 |
| 数据保护 | 不查询 phone、wechat、password_hash、wx_openid；跟进、单线索、候选、上下文和输出上限生效 |
| Prompt/输出 | 九类注入只作为无工具不可信数据；strict Schema、ref、secret 和长度校验生效 |
| Provider | 仅 429/500/503、timeout、network 重试一次；认证/业务/Schema/敏感错误不重试 |
| 状态/恢复 | 稳定幂等、60 秒租约、额度预留、ready 仅重试 outbox、原子关联和保留清理通过 |
| 两项任务 | 到期排序/总数/空任务/模板；日报四项统计/四类重点/空任务/metrics 冻结通过 |
| 通知 | pending/suppressed/capture 关闭/Worker 关闭/Mock/快照/body/context stale 与 owner_changed 回归通过 |
| API/CLI | admin 日志 200、member 403、实时升降级、分页筛选和安全字段；dry-run 只读 |
| 禁止边界 | 无普通用户 AI API、无 H5 AI 入口、无 weekly 实际任务、无真实渠道或外网测试 |

## 5. 最终验证

| 验证 | 结果 |
| --- | --- |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 97 通过，0 失败，0 skipped |
| `cd app && npm run build:h5` | 通过 |
| `git diff --check` | 通过 |
| `server/data` SHA-256 前后复核 | 完全一致 |

所有数据库测试使用内存或 `/tmp` 临时数据库。Provider 测试只使用 Fake
Provider 或本地 mock `fetch`，没有真实外部网络、真实 DeepSeek 调用或真实
API Key。`server/package.json` 只增加脚本，没有依赖或锁文件变化，因此无需
新增生产依赖审计。

## 6. 严重级别与已知风险

- 未解决 P1：0
- 未解决 P2：0
- 未解决 P3：0

残余风险属于上线门禁而非代码验收失败：

1. 尚未按上线当日官方文档核验真实 DeepSeek endpoint、模型和 JSON 输出；
2. 尚未使用受控真实 Key 做隔离环境联调；
3. 尚未在生产数据库副本演练迁移 `005`；
4. 当前只有 Mock 渠道，真实微信/企业微信不属于阶段四；
5. 全部 AI、任务、捕获和规则开关仍默认关闭。

## 7. 上线建议

允许提交阶段四代码和文档，并允许以全部开关关闭的状态进入预发布迁移演练。
不建议直接在生产开启任务或 `DEEPSEEK_ENABLED`。

只有完成数据库副本迁移、当日官方文档复核、Key 进程隔离验证、单用户
allowlist Provider 联调和 Mock outbox/Worker 灰度后，才可按部署说明逐项开启。
真实消息渠道必须另行审计和批准。
