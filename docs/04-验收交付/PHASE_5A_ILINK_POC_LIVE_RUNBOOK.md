# 阶段五A：iLink 实况 PoC 运行手册（未执行）

> 本手册仅供后续得到单独授权后使用。本轮不得据此登录、生成二维码或发送消息。

## 前置门禁

1. 只使用专用测试 Bot/账号与专用测试接收账号；禁止员工或领导日常账号。
2. 使用隔离机器和仓库外、权限 `0600` 的 Gateway 配置；`ILINK_POC_STATE_DIR` 与 live 必需的 `ILINK_POC_SESSION_DIR` 均为非符号链接、权限 `0700` 的绝对目录。所有官方 CLI 进程均显式使用该会话目录的 `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH`，不会继承父进程同名路径；live 关闭的 prereq 则使用 state 内派生的 `openclaw-offline` 目录，绝不使用默认 OpenClaw 状态。官方运行时是凭证与会话的唯一事实源；不得导入、读取、复制或解析其私有会话文件。
3. 不连接业务数据库、真实 outbox、DeepSeek 或通知 Worker；只使用固定合成文本。
4. 先运行 `npm run gateway:prereq-check`。只有输出 `READY`（实际 CLI、插件 metadata 兼容条件和明确文本出站 capability 均通过）才可继续；不得把 README 中的任何最低版本手工写入配置或源码。
5. `ILINK_POC_LIVE_ENABLED` 只有人工批准的短时窗口才能设为 `true`；不得将凭证放进 Git、日志、API、H5 或其他进程。

## 后续功能 PoC（3–7天）

人工执行 `npm run gateway:login -- --confirm-live-login` 后查看终端二维码、用专用账号扫码并确认。包装器不得截取二维码。登录后用 `npm run gateway:official-session-status` 只确认脱敏状态。只验证：登录、官方会话恢复、固定单条文本、同幂等键抑制、Gateway 重启、网络中断、登录失效、接收人不存在、context token 会话窗口和受控会话清理。每日消息数必须很小，且不处理任何收到的微信消息。

每次合成发送都必须显式带键，例如 `npm run gateway:send-synthetic -- --idempotency-key "phase5a-YYYYMMDD-test-01"`；禁止自定义正文或接收人。CLI 仅在严格的已验证运行时确认（`ok=true`、稳定 `messageId`，以及若提供则匹配的 `channel`）下报告 `sent`；provider `channelId` 只校验安全非空格式，绝不回显或作为回执。它不是 Gateway 伪造的 raw `ret`，也不是微信官方 message ID。若 CLI 非零退出但 JSON 含数值 `ret`，按该 ret 分类；其余不可解释输出为待人工确认。出现 `result_unknown` 时停止自动重试、不换幂等键、不换渠道，人工确认接收账号。

记录安全元数据：日期、测试账号代号、会话状态、请求次数、错误分类、成功/未知结果、人工扫码次数和重启恢复，不记录二维码、token、客户信息或消息正文。

## 30天稳定性观察门禁

功能 PoC 通过后才可申请。30天仍使用专用账号和合成内容，不连接生产 outbox、不作为唯一通知方式。至少观察成功率、P95 延迟、context token 失效、人工扫码、不可恢复掉线、重复/未知结果、服务端规则变化和账号限制。

任何账号限制、不可恢复会话丢失、每日人工维护或不能在用户无近期交互时可靠主动通知，都应判定 iLink 不满足 XYY-xiansuo 主动提醒场景。PoC 成功不等于批准生产；不得因此转向 Hook、RPA 或逆向协议。

## 结束与清理

停止 Gateway，执行受控会话清理，撤销/删除测试配置与凭证，保存脱敏报告。绝不提交 state、会话文件、环境文件、二维码或日志。
