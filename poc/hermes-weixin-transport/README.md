# Hermes Weixin transport-only overlay

这是一个本地、窄边界的 PoC：它不是 Hermes Gateway，绝不启动登录、扫码、轮询、typing、Agent、Provider、工具或媒体路径。

每次运行先校验显式 `HERMES_SOURCE_DIR`（默认仅由两个仓库脚本指向 `/tmp/hermes-agent-v2026.8.3`）：非链接路径、remote、精确 tag、commit、tree、干净工作树、包版本、MIT 和 `UPSTREAM_MANIFEST.json` 中逐文件 SHA-256。校验失败时，CLI 在读取配置或状态、导入 Hermes 或创建网络客户端之前退出。

配置是一个由当前用户拥有的 `0600` JSON 普通文件：

```json
{"account_id":"wx-account","ilink_token":"<secret>","allowed_from":["peer-a"],"hmac_key":"<至少32字节随机值的base64>"}
```

`allowed_from` 必须是 1–10 个固定 ID；配置和状态目录都必须位于仓库外，且任何祖先目录不得是符号链接；状态目录必须为当前用户的绝对路径、普通 `0700` 目录。状态文件只保存该 allowlist DM 的最新 `context_token` 的认证加密密文与不可逆 HMAC reference，通过原子 replace、进程锁和 `0600` 文件权限防篡改；不会写入原始 account、peer、token、正文、媒体或消息 ID。

捕获（stdin 是原始入站 JSON）只会接受 `from_user_id` 在 allowlist、`to_user_id` 等于本账号、非群、非自身且带 token 的 DM：

```bash
printf '%s' '{"from_user_id":"peer-a","to_user_id":"wx-account","context_token":"..."}' |
  ./poc/hermes-weixin-transport/run-hermes-weixin-transport.sh capture --config /absolute/config.json --state-dir /absolute/state
```

出站（stdin 是严格的单对象）只投递一个 allowlist peer 的纯文本（最多 2000 字符）：

```bash
printf '%s' '{"peer":"peer-a","text":"通知正文","idempotencyKey":"business-key-001"}' |
  ./poc/hermes-weixin-transport/run-hermes-weixin-transport.sh send --config /absolute/config.json --state-dir /absolute/state
```

发送使用由账号、peer 与业务幂等键确定的 `client_id`，只调用一次 `ilink/bot/sendmessage`。精确 `{}`、或真正整数 `ret=0`（`errcode` 缺失或真正整数 `0`）报告 `sent`；任一真正整数 `ret`/`errcode` 非零报告永久失败；布尔、字符串、`null`、不一致或无法识别的非空对象、非对象均报告 `result_unknown`。stdout 的 `responseShape` 是固定枚举，只表达安全的响应形态，不包含上游值、未知字段名、正文、token、peer 或幂等键以外的请求信息；Gateway 仅接受包含该字段的四字段契约，旧输出失败关闭为未知。超时、断线、5xx、坏 JSON 都报告 `result_unknown`，4xx 等明确拒绝报告永久失败；不重试、分块、降级、typing 或媒体。stderr 只输出固定中文错误，不含 token、context 或正文。

运行离线测试（测试注入 fake transport，不发网络）：

```bash
./poc/hermes-weixin-transport/run-tests.sh
```

可选的 `poc/ilink-gateway` Hermes adapter 仅在显式选择 `ILINK_POC_TRANSPORT=hermes`、`ILINK_HERMES_TRANSPORT_ENABLED=true` 且 Gateway 的仓库外严格 peer 映射、overlay 配置和状态路径全部通过校验时调用本 CLI。它沿用 Gateway 已有的持久化幂等账本，不新增业务数据库或 schema；同 key 的启动/超时/非法输出均烧毁为未知结果，不能由稳定 `client_id` 单独替代这一门禁。
