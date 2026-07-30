# 阶段一部署说明：安全与数据库基线

> H5-only 后续策略说明：本文微信小程序构建步骤是阶段一时的历史记录，已被当前 H5-only 发布策略取代；之后仅构建 H5。

日期：2026-07-30
当前状态：仅提供部署步骤，尚未执行生产部署。

## 1. 上线前硬门禁

1. 从当前未提交工作区形成经过评审、可追溯的发布 commit/制品；逐项排除不属于阶段一的夹带变更。
2. 核对生产实际运行版本、Node.js 版本（至少 22.13）、服务工作目录和真实数据库路径。
3. 在服务器受控 `.env` 中配置：
   - `NODE_ENV=production`
   - 绝对路径 `DB_PATH`
   - 至少 32 字节 `JWT_SECRET`
   - 空库首次部署时设置至少 12 位 `ADMIN_INITIAL_PASSWORD`
   - 可选 `ADMIN_INITIAL_USERNAME`、`ADMIN_INITIAL_NAME`
4. `.env` 权限设为 `600`，不得进入 Git、部署包、普通日志或前端产物。
5. 使用 SQLite `.backup` 或 `scripts/backup.sh` 备份实际 `DB_PATH`；同时备份上传目录。校验备份文件可打开，并在隔离副本完成恢复演练。
6. 先在生产数据库副本执行同一发布制品，确认迁移、记录数、索引、`integrity_check` 和 `foreign_key_check` 全部通过。

## 2. 推荐部署顺序

1. 进入维护窗口并停止业务写入。
2. 记录发布 commit、制品校验值、原服务版本、`DB_PATH` 和备份位置。
3. 完成数据库与上传文件备份，保留原应用制品。
4. 安装锁文件依赖并执行：

   ```bash
   cd server
   npm ci
   npm run build
   npm test
   ```

5. 构建前端并确认产物：

   ```bash
   cd app
   npm ci --legacy-peer-deps
   npm run build:h5
   npm run build:mp-weixin
   ```

6. 加载受控生产环境变量，启动一次服务。启动顺序为连接数据库、启用 WAL/外键、运行迁移和检查、初始化空库管理员、注册并监听 HTTP。
7. 检查标准日志中每个迁移版本都有：
   - 首次执行：`result=applied`
   - 已执行且 checksum 匹配：`result=skipped`
   - 不得出现：`result=failed`
8. 确认启动日志中的数据库路径为预期绝对路径，且没有密码、哈希、客户数据或 SQL 参数。
9. 完成冒烟后再恢复流量和写入。

## 3. 上线后验证

- 健康检查成功，且迁移或管理员初始化失败时服务不会监听端口。
- 使用受控测试账号验证登录和 `/api/users/me`。
- 验证 admin 可访问管理员接口、member 返回 403。
- 在测试账号上执行 admin→member 降级、member→admin 升级、停用，确认旧 token 立即采用数据库实时状态。
- 验证线索创建、列表和跟进创建继续返回 `{ code, msg, data }`。
- 只读核对：

  ```sql
  SELECT version, description, checksum, applied_at
  FROM schema_migrations
  ORDER BY version;

  PRAGMA integrity_check;
  PRAGMA foreign_key_check;
  PRAGMA foreign_keys;
  ```

- `integrity_check` 必须为 `ok`，`foreign_key_check` 必须为空；应用连接日志/测试应证明 `foreign_keys=1`。

## 4. 监控与告警

- 启动日志：`database-migration` 的 version/description/result；任何 `failed` 立即阻断上线并告警。
- 进程：启动失败、PM2 重启循环、健康检查失败。
- 数据库：磁盘空间、数据库/WAL 增长、`SQLITE_BUSY`/I/O 错误、定期 integrity/foreign key 检查。
- 安全：登录 401、管理员接口 403 的异常增幅；管理员角色和启停变更。
- 备份：每日备份成功时间、大小异常、恢复抽检结果。
- 日志内容：不得出现初始密码哈希、JWT secret、SQL 参数或客户数据。

## 5. 停止上线条件

- 发布制品无法关联到评审 commit。
- `DB_PATH` 为空、相对路径或与预期不符。
- 数据库/上传备份缺失或恢复演练失败。
- 任一迁移 `failed`、checksum 冲突、完整性或外键检查失败。
- 生产空库缺少合规初始管理员密码。
- 核心 API、实时降权或响应包络冒烟失败。
