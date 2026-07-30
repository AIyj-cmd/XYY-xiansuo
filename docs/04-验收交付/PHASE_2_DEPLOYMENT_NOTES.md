# 阶段二部署说明：业务一致性基线

日期：2026-07-30  
当前状态：代码验收通过；尚未执行生产部署。

## 1. 上线前硬门禁

1. 从当前未提交工作区形成经过评审、可追溯的发布 commit 和制品，逐项排除阶段一、文档归档及其他既存改动中的非发布内容。
2. 保留阶段一安全门禁：生产使用明确的 `NODE_ENV=production`、绝对 `DB_PATH`、至少 32 字节 `JWT_SECRET`，空库首次部署配置安全管理员密码。
3. 停止业务写入后，使用 SQLite `.backup` 或受控备份脚本备份实际 `DB_PATH`，同时保存应用制品、环境变量快照和上传目录。
4. 在隔离的生产数据库副本运行同一发布制品，确认迁移 `001`、`002` checksum 匹配，`003` 成功执行，记录数、索引、完整性和外键检查通过。
5. 不得修改已发布的 `001`、`002` 内容或迁移记录；不得手工插入、删除或改写 `schema_migrations` 绕过错误。

## 2. 迁移 `003`

迁移描述：

```text
add owner transfer audit metadata and follow-up derivation source
```

固定 checksum：

```text
e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704
```

结构变化：

- `audit_logs.source`
- `audit_logs.operation_id`
- `leads.next_follow_at_source`
- `audit_logs(operation_id)` 索引

迁移会按 `created_at DESC, id DESC` 回填已有线索的最新跟进派生值和来源。没有跟进但已有 `next_follow_at` 的记录标记为 `manual`；运行时按已批准方案 B，在最后一条跟进被删除后清空派生时间和来源。

## 3. 推荐部署顺序

1. 进入维护窗口，停止 HTTP 写流量和后台写任务。
2. 记录发布制品、旧制品、实际 `DB_PATH`、数据库记录数和备份位置。
3. 完成数据库一致性备份并在隔离路径验证可打开。
4. 使用锁文件安装依赖，执行：

   ```bash
   cd server
   npm ci
   npm run build
   npm test

   cd ../app
   npm ci --legacy-peer-deps
   npm run build:h5
   npm run build:mp-weixin
   ```

5. 用生产环境变量启动一次服务。数据库连接、迁移、完整性检查和管理员初始化任何一步失败时，不得继续监听 HTTP。
6. 核对迁移日志：已执行版本应为 `skipped`，首次执行 `003` 应为 `applied`；不得出现 `failed`。
7. 完成数据库只读检查和 API 冒烟后再恢复流量。

## 4. 上线后验证

数据库只读检查：

```sql
SELECT version, description, checksum, applied_at
FROM schema_migrations
ORDER BY version;

PRAGMA integrity_check;
PRAGMA foreign_key_check;
PRAGMA foreign_keys;
```

必须满足：

- 版本顺序为 `001`、`002`、`003`；
- `integrity_check=ok`；
- `foreign_key_check` 为空；
- 应用连接 `foreign_keys=1`；
- `001` checksum 为 `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0`；
- `002` checksum 为 `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9`。

受控测试账号冒烟：

- member 创建线索时不能伪造其他负责人；admin 不能选择停用负责人。
- 单条转移、批量转移、公海认领保持原 API 路径和 `{ code, msg, data }` 包络。
- 相同负责人不新增 transfer 审计；一个批次的真实变化共享同一 `operation_id`。
- 构造包含无权限或不存在目标的批量请求，确认没有部分变更。
- 重复认领同一公海线索，只产生一次真实 transfer 审计。
- 新增、编辑、删除跟进后派生时间正确；删除最后一条后按方案 B 清空。
- 数据库异常返回 500 时仍保持 `{ code, msg, data }`，且业务数据已回滚。

## 5. 监控与停止上线条件

重点监控：

- `database-migration` 中的版本和 `applied/skipped/failed`；
- HTTP 400/403/409/500 异常增幅，尤其是转移和跟进接口；
- `SQLITE_BUSY`、约束失败、磁盘 I/O、WAL 增长；
- 同一批次审计数量与真实负责人变化数量不一致；
- `next_follow_at_source='follow_up'` 与最新跟进日期明显不一致；
- 进程重启循环和健康检查失败。

出现任一情况停止上线：

- 备份或副本演练缺失；
- 迁移 checksum 冲突、`failed`、完整性或外键检查失败；
- 负责人越权、停用负责人可被分配、批量部分成功或重复审计；
- 跟进派生时间错误；
- API 路径或响应包络回归；
- 发布制品夹带通知、微信、AI、拜访计划或 `sales_stage`。
