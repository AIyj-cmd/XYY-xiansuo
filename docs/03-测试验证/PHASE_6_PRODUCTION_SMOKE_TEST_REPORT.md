# 阶段六生产冒烟测试报告

结论：**隔离 API 冒烟通过；实际生产冒烟未执行。**

## 工具链与构建结果

| 项目 | 结果 |
| --- | --- |
| Node.js / npm / sqlite3 / PM2 | `v24.18.0` / `11.16.0` / `3.45.1` / `7.0.1` |
| `server npm ci`、build、test | 通过；`121/121` 测试通过 |
| Gateway `npm ci`、build、test | 通过；`30/30` 测试通过 |
| `app npm ci` | **失败**：锁文件缺少 `vue@3.4.21` 及 runtime 相关条目；定级 P2。本轮不修锁文件。 |
| H5 build | 在已有/部分依赖环境中通过；不能抵消 `npm ci` 的可复现安装失败。 |

## 隔离 API 冒烟

环境限定为 `127.0.0.1` 的非生产端口、临时 SQLite 数据库、仅 API 进程；所有开关关闭、无 DeepSeek key、无 Worker/Scheduler/AI job/真实消息渠道。测试后进程正常停止，临时目录已删除。

| 检查 | 结果 |
| --- | --- |
| 迁移 `001–006` | 成功 |
| health | HTTP 200 |
| 未认证 admin 与 notifications | HTTP 401 |
| 登录与 `/me` | HTTP 200 |
| 线索池认领 | HTTP 403（开关关闭） |
| `notification_logs` / `ai_request_logs` | 均为 `0` |
| SQLite 完整性/外键 | `integrity_check=ok`；`foreign_key_check` 为空 |

该结果不使用生产端口、生产数据库、生产身份、真实密钥或生产反代，故不得称为生产冒烟通过。

## 数据与前端观察

本轮前后 `server/data` 哈希一致：

```text
app.db      8b8bc326ab3ac27a553b22ea7cacf6e34681d1f471246277907a8ed0a061d5f2
app.db-shm  fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb
其余空文件 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

H5 `/api/notifications` 仅显示 `audit_logs` 的 transfer 和 `leads.next_follow_at` 的逾期项，不读取 `notification_logs`；因此阶段四的 `scheduled_follow_overdue`、`daily_report` 和 AI 结果不会出现在当前 H5。所有生产相关开关必须继续关闭。

## 未执行的实际生产冒烟

未提供/确认生产项目、数据库、H5 静态目录、Nginx、PM2、备份/恢复位置或生产数据库只读备份授权。Nginx 命令在本机不存在，PM2 也未见任何 xiansuo 相关进程。因此未验证实际 HTTPS、反代、同源静态制品、PM2 进程、日志、生产数据库或旧制品回退。
