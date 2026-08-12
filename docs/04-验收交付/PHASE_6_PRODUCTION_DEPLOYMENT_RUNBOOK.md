# 阶段六生产部署运行手册

状态：**当前不得执行部署。** 本手册仅在全部上线门禁解除且获得生产变更授权后使用；不包含密码、secret、完整生产路径或客户数据。

## 0. 必须满足的前置门禁

1. 独立修复并验证 app 锁文件，使 `app npm ci` 与 H5 build 都通过；
2. 提供并确认七类生产输入：生产项目、生产 DB、H5 静态目录、Nginx 配置、PM2 配置/进程、备份目录、恢复目录，以及生产 DB 只读一致性备份授权；
3. 完成真实一致性备份副本的 `001–006` migration-copy 与 restore-copy；
4. 核验实际 Nginx 与 PM2；
5. 提供可用的上一版兼容制品并完成回滚演练；
6. 全部开关和所有真实渠道均保持关闭。

任何一项不满足即停止，不得用仓库模板、本机进程或临时数据库替代生产证据。

## 1. 发布前受控准备

1. 由授权人员确定维护窗口、变更负责人、回滚负责人和验收记录位置；不在文档中复制生产路径或密钥。
2. 使用受控环境完成服务器端和 H5 的可复现安装、构建与测试；记录制品 hash 与上一版制品标识。
3. 核验实际 Nginx 为 HTTPS 终止、仅反代本机 `127.0.0.1:3000`；核验 Fastify 同源静态 H5 与 SPA fallback。不以仓库 `deploy/nginx.conf` 推断已部署配置。
4. 核验实际 PM2 仅按获准配置管理 xiansuo API；阶段三 Worker 与阶段四 AI Scheduler 均不得启动。敏感 AI/渠道凭证不得进入 API、H5、PM2 配置或日志。
5. 创建并验证实际生产 DB 的一致性只读备份，确保 WAL 已提交数据包含在备份证据中；禁止手工改写 `schema_migrations`。

## 2. 副本迁移与恢复门禁

1. 仅在批准的备份副本运行新制品迁移 `001–006`；记录 checksum 和 `schema_migrations`。
2. 核验 `PRAGMA integrity_check=ok`、`PRAGMA foreign_key_check` 为空，且通知与 AI 默认规则仍关闭。
3. 从该备份做独立 restore-copy，并对恢复库重做上述核验和最小登录/只读 API 冒烟。
4. 用确认的旧生产制品完成不删数据、无 down migration 的回滚兼容演练。
5. 任一失败即停止发布，按回滚手册处理；不得在生产主库试错。

## 3. 发布顺序

1. 再次确认以下十项开关的实际运行时/构建时值均为 `false`，不得只依赖默认值或未渲染的配置模板：

   ```text
   NOTIFICATION_CAPTURE_ENABLED=false
   NOTIFICATION_WORKER_ENABLED=false
   NOTIFICATION_SCHEDULER_ENABLED=false
   NOTIFICATION_MOCK_ENABLED=false
   DEEPSEEK_ENABLED=false
   AI_SCHEDULED_FOLLOW_ENABLED=false
   AI_DAILY_REPORT_ENABLED=false
   AI_WEEKLY_REPORT_ENABLED=false
   LEAD_POOL_CLAIM_ENABLED=false
   VITE_LEAD_POOL_CLAIM_ENABLED=false
   ```

   同时核验通知 Worker、AI Scheduler、Gateway、OpenClaw、iLink、普通微信、企业微信及其他真实外部消息渠道均未运行。
2. 将已验证的 H5 制品与 API 制品按已确认生产目录发布；不要覆盖备份或恢复副本。
3. 启动/重载获准的 xiansuo API 单元；不启动 Worker、AI Scheduler、Gateway、OpenClaw、iLink 或微信相关进程。
4. 对实际 HTTPS 域名完成只读冒烟：health、未认证 401、登录/me 200、认领关闭 403、静态 H5 与 SPA fallback；不发送真实消息，不注入 DeepSeek key。
5. 在受控证据位置记录发布前后的脱敏行数：至少覆盖关键业务表、`audit_logs`、`notification_logs` 与 `ai_request_logs`，并记录含状态字段表的按状态分布。结合维护窗口内已授权的业务流量，确认没有非预期增量或状态迁移；只有部署前证据已证明某表为空白基线时，才额外核对该表发布后仍为 `0`。绝不将 `notification_logs=0` 或 `ai_request_logs=0` 作为生产环境的通用通过条件。同时确认完整性与外键检查无异常，文档中只保留脱敏摘要。

## 4. 发布后观察与停止条件

观察 API 可用性、登录、H5 静态加载、反代错误和数据库完整性。出现迁移/checksum、完整性、鉴权、H5 制品、反代或进程异常时，立即停止进一步操作并执行回滚手册。任何 Worker、Scheduler、AI、Mock 或真实渠道意外启动均为停止条件。
