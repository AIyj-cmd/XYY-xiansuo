# 技术债整改记录

日期：2026-08-02。范围仅为代码健康整改与隔离验证；**不构成生产发布授权**。

## 当前口径

| 范围 | 状态 | 口径 |
| --- | --- | --- |
| H5 | CURRENT | 唯一构建、发布和验收目标；深链刷新由后端 SPA fallback 托管。 |
| OpenClaw / Direct iLink | NO-GO / RESEARCH ONLY | 单账号路径保留为冻结研究边界，真实 daemon、试点和发布均未授权。 |
| DeepSeek / AI Scheduler | CANDIDATE，默认关闭 | 代码和离线配置存在，不得在无单独授权时启用或发送外部消息。 |
| 服务号候选 | CANDIDATE，默认关闭 | 仅候选记录；不含实现、凭据、二维码或发送授权。 |
| 企业微信、Hook、RPA、逆向、Windows 自动化 | NO-GO | 已取消或明确禁止，不是后续实现路径。 |
| Hermes | HISTORICAL / 未开始 | 未纳入本项目运行、部署或验收范围。 |

## 配置清单

敏感值只允许出现在仓库外私有文件或受控环境；表中不记录值。`required` 为进程实际启动所需条件，而非“建议”。

| name | process | default | sensitive | required | relation | enabled |
| --- | --- | --- | --- | --- | --- | --- |
| `JWT_SECRET` | API | 无 | 是 | 是 | API JWT；至少 32 字节 | CURRENT |
| `DB_PATH` | API / Worker / AI | 本地开发默认 | 是（数据） | 生产是 | 三进程必须指向同一受控数据库 | CURRENT |
| `ADMIN_INITIAL_*` | API | 用户名 `admin`、姓名“管理员” | 密码是 | 空生产库需要密码 | 仅 users 为空时读取 | CURRENT |
| `LEAD_POOL_CLAIM_ENABLED` | API / Worker | `false` | 否 | 否 | 服务端为公海认领唯一安全边界 | CURRENT / 默认关闭 |
| `NOTIFICATION_*_ENABLED` | API / Worker / AI | `false` | 否 | 否 | capture、worker、mock、scheduler 各自显式开关 | CURRENT / 默认关闭 |
| `DEEPSEEK_*`、`AI_*` | AI Scheduler | `DEEPSEEK_ENABLED=false` | API key 是 | 仅启用 Provider 时 | API/Worker 不传递 DeepSeek key | CANDIDATE / 默认关闭 |
| `OPENCLAW_CHANNEL_ENABLED` | API / Worker / AI | `false` | 否 | 否 | 还须通过单账号及 Gateway 门禁 | NO-GO / 默认关闭 |
| `OPENCLAW_GATEWAY_*` | Worker / AI | 本地回环、受限超时 | secret file 是 | 仅 OpenClaw 启用时 | Worker 完整窗口大于 Gateway 窗口 | NO-GO / 默认关闭 |
| `ILINK_*`、`OPENCLAW_*_DIR/FILE` | Gateway | 回环、`ILINK_POC_LIVE_ENABLED=false` | state、map、secret 是 | 仅受控研究时 | 必须仓库外私有目录/文件 | RESEARCH ONLY / 默认关闭 |
| 服务号候选配置 | 无运行进程 | 无 | 是 | 否 | 尚未接入 API、Worker 或 Gateway | CANDIDATE / 未实现 |

私密文件校验仍以各启动路径的属主、普通文件、非链接与权限检查为准。跨包共享私密状态（例如 Gateway secret、OpenClaw state）尚不安全地自动化；后续如需共享，必须先形成单一受控运行时目录和最小权限设计，不能复制私密文件。

## 本轮结果与剩余风险

- H5 新增 Chromium 运行烟测：登录、列表、详情深链刷新、管理员转负责人、member UI/API 越权、关闭公海、401 清会话、403 保会话。
- Vite 保持 `5.2.8`：`@dcloudio/vite-plugin-uni` 对此版本有精确 peer 约束；审计修复要求不兼容的 Vite major，未使用 force、legacy peer deps 或 uni-app 大版本升级。开发服务器只监听 `127.0.0.1`，生产仅托管静态 H5；该已知开发依赖风险须在兼容版 uni-app 升级设计获批后再处理。
- `npm audit --omit=dev` 仍报告 Vite 生产依赖链高危项；这是当前依赖约束的已知风险，CI 保留审计命令，不能将其误报为通过。
- 未改动迁移 `001`–`007`、数据库结构、公开 API、权限口径、Worker/Gateway/JWT 或 OpenClaw 单账号路径。
