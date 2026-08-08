# 当前版本回滚手册

日期：2026-08-02
原则：先停写、保全数据和证据，再按故障类型回退；不得手工篡改 `schema_migrations` 绕过失败。

OpenClaw 补充：回滚不得删除 Gateway audit ledger、人工确认或已烧毁 key。已消费授权的不确定结果必须保持 `result_unknown`，不自动重试；回滚后真实渠道保持关闭。停止顺序固定为：先关闭规则和 `OPENCLAW_CHANNEL_ENABLED`，再停止 notification-worker、Gateway、OpenClaw，最后按需要停止 API；禁止清理仓库外 Secret、映射或会话目录作为“回滚”。

## 1. 回滚准备

- 上线前保存：发布 commit/制品、上一受批准制品、实际 `DB_PATH`、数据库一致性备份、上传目录备份、环境变量快照和迁移日志。
- 数据库备份必须由 SQLite `.backup` 生成并在隔离路径验证可打开。
- 明确维护窗口负责人、恢复负责人和业务确认人。

## 2. 触发条件

- 任一迁移出现 `failed`、checksum 冲突、`integrity_check` 非 `ok` 或 `foreign_key_check` 非空。
- 服务进入重启循环，或健康检查无法恢复。
- 登录、实时角色校验或核心线索 API 出现阻断性回归。
- 发现错误 `DB_PATH`、数据记录数异常或索引/外键关系损坏。
- 发现 secret、密码、哈希或客户数据进入迁移日志。
- 离线映射检查为 `UNSAFE`、live Gateway 因零个/多个 `enabled=true` 拒绝启动，或发现账号 B/其他接收人被误启用。

## 3. 回滚步骤

### A. 迁移前或迁移失败、HTTP 尚未启动

1. 保持服务停止，不反复重试，也不删除/修改迁移记录。
2. 保存失败日志、当前数据库文件和 WAL/SHM 现场副本供诊断。
3. 确认失败前的备份和目标路径。
4. 恢复完整数据库备份到明确的恢复路径，再原子切换 `DB_PATH` 或文件。
5. 使用最后一个**已批准且无已知固定密码/旧 JWT 角色风险**的制品启动；不得直接回退到已知不安全基线。
6. 执行 `integrity_check`、`foreign_key_check` 和核心 API 冒烟。

### B. 迁移成功、尚未恢复业务写入

1. 停止服务。
2. 若仅应用回归且旧应用兼容新增/放宽后的 schema，可先回退到已批准应用制品并保留升级后的数据库。
3. 若数据库结构或数据检查异常，恢复上线前完整备份。
4. 复核记录数、主键、外键、11 个相关索引和迁移表，再恢复流量。

### C. 已恢复业务写入后

1. 立即停止写入并记录故障时间。
2. 优先回退应用制品并保留当前数据库，避免直接恢复旧备份丢失上线后的新数据。
3. 如必须恢复数据库，先保存当前完整快照，评估上线后新增数据并制定人工对账/合并方案；未经业务确认不得覆盖。
4. 完成数据对账和完整性检查后再恢复服务。

## 4. 配置回滚

- 恢复上一份受控 `.env`，但继续要求绝对 `DB_PATH`、至少 32 字节 `JWT_SECRET` 和生产空库安全初始密码。
- 恢复上一份受批准的 PM2/Nginx 模板时，仍必须使用仓库外绝对 cwd；不得为让旧模板启动而恢复隐式工作目录、占位域名或仓库内 Secret/映射/会话路径。
- 若仅 Gateway 或 OpenClaw 故障，先关闭 OpenClaw 通知规则与 Worker，回退 Gateway 制品和配置后仅做离线健康/映射检查；未取得新的真实发送授权时不用微信消息作回滚冒烟。
- 映射门禁失败时保持 `OPENCLAW_CHANNEL_ENABLED=false`，停止 Worker/Gateway，保留原映射、账号 B 凭据和会话目录，不做删除式“修复”；仅在仓库外将唯一批准接收人设为 `enabled=true`、其余保持 `false`，再重跑离线检查。
- 若 JWT secret 被错误暴露，立即轮换；现有 token 将失效，需要通知用户重新登录。
- 不恢复固定默认管理员密码，不关闭实时角色查询，不关闭 SQLite 外键。

## 5. 回滚验证

- 进程稳定且健康检查通过。
- 数据库路径与预期一致。
- `integrity_check=ok`、`foreign_key_check` 为空、应用连接 `foreign_keys=1`。
- 用户、线索、跟进记录数和抽样关系正确。
- 登录、当前用户、admin/member 权限、线索创建/列表、跟进创建通过。
- 日志无迁移 `failed` 重试循环和敏感信息。
- 若保留内部通知能力，离线映射检查必须为 `SAFE` 且 `enabled=1`；DeepSeek 与 AI Scheduler 继续关闭，回滚验证不发送真实消息。
- 记录回滚原因、时间、制品、备份、数据影响和后续修复负责人。

## 6. Hermes Weixin 纯离线 PoC 回退（2026-08-08）

- 本 PoC 未部署、未迁移数据库、未修改产品源码或依赖，因此没有运行时或数据回滚动作。
- 提交前若不采纳，保持 `poc/hermes-weixin-offline/` 与本次四份文档追加不进入提交；不得为此清理用户其他未提交改动。
- 提交后若需撤回，使用正常 Git revert 撤销对应 PoC 提交，保留历史记录；不操作 `server/data`，不删除默认 Hermes 状态或任何仓库外凭据目录。
- 若发现意外 Hermes/OpenClaw/Worker 进程或真实网络/发送行为，立即停止该进程、隔离凭据并保全日志；这已超出纯离线 PoC，必须按安全事件处理并重新评审，不能用删除测试记录掩盖。
- 回退验收：`git diff --check` 通过，产品源码/依赖/`server/data` 与 PoC 前一致，且无 `/tmp/xiansuo-hermes-weixin-offline-*` 或相关服务进程。

## 7. Hermes Weixin transport-only overlay 回退（2026-08-08）

本轮没有部署、数据库迁移、真实账号状态或真实发送，因此正常回退只涉及 Git 交付范围，不执行数据恢复：

1. 提交前若不采纳，不把 `poc/hermes-weixin-transport/`、Gateway Hermes adapter/门禁/测试以及本次报告追加纳入提交；不得清理或覆盖用户其他未提交改动。
2. 提交后若撤回，使用正常 Git revert 撤销对应单一提交并保留历史；不得使用 `git reset --hard`、删除 `server/data`、修改迁移记录或以清理仓库外状态冒充回滚。
3. 若未来获批运行后需要停用，先阻止新业务任务并将 `ILINK_POC_LIVE_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false`，再停止 Gateway/overlay 子进程。不得重试、换 key 或 fallback 处理已有 `result_unknown`；必须保留 Gateway ledger、烧毁 key、context-token 状态与日志供人工核对。
4. 发现上游 gate、映射、权限、状态 MAC、幂等、超时回收异常，或出现意外网络/登录/扫码/发送时，立即隔离真实凭据、停止进程并保全仓库外 `0700/0600` 现场；按安全事件重新评审，不先删除状态或日志。
5. 回退验证：默认 transport/enable/live 仍关闭；Gateway、Hermes/OpenClaw/Worker/AI 相关进程为空；`git diff --check` 通过；Server/Gateway build/test 与 H5 build 通过；`server/data` 前后 SHA-256 一致；仓库和提交中无 token、HMAC key、Secret、peer、context token 或本机上游副本。

P3 自定义 HMAC 流加密风险的后续迁移也必须采用新 schema 版本、先验证旧状态完整性再原子迁移，并保留可审计回退路径；禁止就地改算法后继续读取旧密文，或删除 MAC/nonce/域分离以求兼容。

## 8. Hermes 成功响应分类修复回退（2026-08-08）

- 本修复未部署、未迁移数据库、未改变依赖或真实账号状态；提交前不采纳时只排除本轮允许路径和四份报告追加，不清理用户其他改动。提交后使用正常 Git revert 回退对应提交，禁止 `git reset --hard` 或删除账本/状态。
- 回退不得把上一 Pilot 的人工事实改成“未收到”：旧技术结果继续保留 `permanent_failure / ILINK_PROVIDER_REJECTED`，人工事实继续保留 `manually_confirmed_received`、实际收到 1 条、自动重试 0、其他渠道 0。
- 回退后 Hermes enable/live 和 Worker 继续关闭；不得用旧分类器重放消息，也不得为验证回退而登录、联网或发送。任何已存在的 sent、permanent 或 `result_unknown` key 均保持烧毁，不换 key、不 fallback。
- 回退验证：overlay/Gateway 受影响测试、Server build/test、H5 build 和 `git diff --check` 通过；`server/data` 哈希不变；无 Hermes/OpenClaw/iLink/Worker/Weixin 常驻进程，仓库和输出中无敏感值。

## 9. Hermes 1–10 用户绑定与定向通知回退（2026-08-08）

本轮未部署且未获真实 Pilot/生产授权，当前正常回退只涉及评审中的代码与文档；不得为回退清理用户其他未提交改动。

1. 提交前不采纳时，从拟提交范围排除 H5 Hermes 绑定页、Server 迁移/API/Worker/服务、Gateway userId+generation 路由、overlay daemon/vault 与本节文档；不使用 `git reset --hard`、不删除 `server/data`、不覆盖既有工作区。
2. 提交后撤回使用正常 Git revert 并保留历史。默认继续保持 `HERMES_CHANNEL_ENABLED=false`、`HERMES_BINDING_ENABLED=false`、`ILINK_HERMES_TRANSPORT_ENABLED=false`、`ILINK_POC_LIVE_ENABLED=false` 和相关通知规则关闭。
3. 若未来迁移 `008` 已应用但尚未恢复业务写入，优先评估旧应用是否兼容新增表/列；需要降级时停止服务，保全当前 DB/WAL/SHM、`hermes_bindings` activation 状态、持久 nonce 表与迁移日志，从上线前已验证备份恢复到新路径，再原子切换 `DB_PATH`。禁止手改 `schema_migrations` 或直接 DROP `hermes_bindings`/nonce 表/重建通知表。
4. 若已恢复业务写入，不直接恢复旧备份。先停止新写入与新通知，保存当前一致性快照，回退应用并保留升级后数据库；只有在业务确认数据对账/合并方案后才允许恢复旧备份。
5. 若 Hermes 运行路径异常，先关闭 `owner_changed` Hermes 规则及两个 Server Hermes 开关，停止 Worker、Gateway、capture daemon；保留 Gateway ledger、外部 vault/lock、prepared activation 状态、持久 nonce 哈希、烧毁的幂等 key 与脱敏日志。activationId 冲突不得强制 activate；`result_unknown`、超时或不确定投递禁止换 key、重试或 fallback。
6. 若发生 peer/token/cursor/Secret 泄露或错误接收人/重复发送，按安全事件处理：隔离进程和凭据、保全现场、轮换受影响 Secret；未经调查确认不删除 vault/ledger，不以清理状态掩盖事实。
7. 回退验证：`integrity_check=ok`、`foreign_key_check` 为空，核心登录/权限/线索 API 正常；正确 activationId 重放幂等、错误 activationId 拒绝、停用注入失败完整回滚、nonce 跨重启拒绝、vault flock 容量/peer 冲突均通过；Server `156/156`、Gateway `59/59`、overlay `18/18` 与 H5 build 通过。全部 Hermes/AI/通知开关仍关闭，无真实发送，仓库/日志不含 raw peer、token、cursor、nonce、activationId、绑定码或 Secret。
