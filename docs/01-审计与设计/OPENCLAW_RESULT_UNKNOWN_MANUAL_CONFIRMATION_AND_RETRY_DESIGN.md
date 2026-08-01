# OpenClaw result_unknown 人工确认与受控重试设计

状态：用户已授权本轮仅完成离线设计、修复、测试与验收；真实重试继续禁止。

## 历史事实

- Gateway 技术结果保持 `result_unknown`，不得改写成成功或明确失败。
- 接收端人工结果为 `manually_confirmed_not_received`，实际确认收到条数为 `0`。
- 人工观察不是 Provider 回执，也不能证明不存在迟到投递。
- 历史隔离数据库和 Gateway 临时状态已按原批准边界删除；旧幂等键必须通过受控 legacy 导入永久烧毁。

## 范围与不变量

- 不修改迁移 `007`、正式 `notification_logs` Schema、业务事件、H5 或 Fastify API。
- 不使用现有管理员通知重试 API 处理 OpenClaw `result_unknown`。
- 一个 generation 只对应一个隔离数据库、一个稳定 delivery request ID、一个幂等键和最多一次真实 Adapter 调用。
- `result_unknown` 永不自动重试；旧 key 永不复用。
- `confirmed_not_received` 只使新代次具备“可申请”资格，不构成发送授权。
- 新代次必须线性引用前代，使用全新 key、全新隔离数据库和新的任务代次；不得分叉或跳号。
- 修复验收通过后仍须重新取得单条实况授权。

## 状态模型

技术投递状态：

```text
prepared -> in_flight -> sent | explicit_failure | result_unknown
```

取得 Adapter 发送权之后的超时、取消、进程退出、非法响应或响应丢失均为 `result_unknown`。仅能证明请求未提交的前置错误可归为明确失败；synthetic 代次仍不得自动进行第二次 Adapter 调用。

人工确认状态：

```text
awaiting_confirmation -> confirmed_received | confirmed_not_received | inconclusive
```

人工事实只允许追加，不得覆盖技术结果。`confirmed_received` 和 `inconclusive` 均关闭后续代次；`confirmed_not_received` 仅允许准备下一代。

代次状态：

```text
reserved -> prepared -> execution_authorized -> consumed -> closed
```

旁路终态为 `cancelled_before_send`、`expired`、`abandoned`。授权必须一次性消费，过期、取消或已消费时 Adapter 调用数必须为零。

## Gateway 本地审计状态

Gateway 本地 state 使用版本化内部迁移，保留现有数据并新增：

- `gateway_state_migrations`
- `delivery_attempts`
- `manual_delivery_confirmations`
- `pilot_generations`
- `pilot_audit_events`

人工确认与审计事件为 append-only，并使用事件哈希链发现意外改写。所有幂等键一经登记即永久占用。数据库、WAL、SHM 在打开前必须通过 realpath、owner、普通文件、单硬链接及权限检查；目录权限为 `0700`，文件权限为 `0600`。

## 本地 CLI

仅新增本地 CLI，不新增 HTTP/H5 管理入口：

- legacy pilot 导入；
- 人工确认记录；
- 新 generation 准备、授权和取消；
- 离线 reconcile。

CLI 必须验证唯一 operator UID、私有状态路径、`live=false`、Worker/Gateway/OpenClaw 均停止。完整旧 key 从 `0600` 文件或标准输入读取，不进入 argv、日志或报告；输出仅允许短哈希与状态枚举。

## synthetic 隔离数据库

每代新库可创建仅属于 synthetic 的 control/audit 表，并纳入 sealed-state 精确校验。新库仍只有一个测试用户、一条 `daily_report/openclaw_synthetic_pilot` 任务和一个 control manifest；`max_attempts=1`。任何控制表缺失、污染、篡改或与 Gateway ledger 不一致，都使 queue-check 和 Worker 在 Gateway 调用前失败。

## Worker 与 Gateway 协议

synthetic 请求携带严格 `pilotControl`：run ID、generation、authorization ID、稳定 delivery request ID、前代 key hash 和 manifest hash。Gateway 在 Adapter 前原子校验并消费授权。

- Worker 本地 HTTP 超时、取消、连接中断、非法 JSON及无法解释的 5xx 一律映射为 `result_unknown`。
- `result_unknown` 在 outbox 中落为不可重试 `failed`。
- Gateway 明确 `sent` 但 Worker 未收到响应时，只允许离线 reconcile 使用原 receipt 收敛，禁止重发。
- 日志按 sent、retry、failed、result_unknown 分开记录，不再把所有成功写回统称为 sent。

## 验收门禁

- Gateway 和 Server 的状态转换、非法转换、并发、崩溃恢复、路径权限、哈希链和隐私测试全部通过。
- 同 key 在 unknown 后任何路径 Adapter 调用数为零。
- 新代次跳号、分叉、重复授权、过期授权、控制清单不一致全部失败关闭。
- Server、Gateway、H5 完整回归通过，`server/data` 哈希不变。
- 本轮不得启动 daemon、登录、扫码或发送消息。
