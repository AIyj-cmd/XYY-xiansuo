# Hermes Weixin 纯离线 PoC

该 PoC 固定审计对象为 `NousResearch/hermes-agent` 的 `v2026.8.3` 标签：commit `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`、`pyproject.toml` 版本 `0.20.0`、MIT。它只读取本机的官方源码副本 `/tmp/hermes-agent-v2026.8.3`，不修改该副本，也不接触本项目的 `server/`、`app/`、`server/data/` 或生产数据库。

先在该固定源码副本建立临时测试环境（仅用于本 PoC，不安装或修改本机 Hermes）：

```bash
cd /tmp/hermes-agent-v2026.8.3
uv sync --frozen --extra dev --extra messaging
```

然后从本仓库根目录执行：

```bash
./poc/hermes-weixin-offline/run-offline-poc.sh
```

可用 `HERMES_SOURCE_DIR`、`HERMES_PYTHON` 显式指定同一固定副本及其 `.venv/bin/python`。测试进程会在导入 Hermes 前设置随机 `/tmp` 下的 `HERMES_HOME`、`HOME` 与 XDG 目录，并在结束时删除；不读取默认 `~/.hermes`。DNS 与 socket 连接入口在每个测试中都被替换为失败桩，因此测试一旦触发真实网络即失败；不会登录、扫码、轮询或发送微信。

覆盖范围：

- O1 溯源（tag、commit、版本、许可证）；
- 两个虚构 peer 的 `MessageEvent` 与 Gateway session 隔离；
- `ContextTokenStore` 的 account+peer 隔离、落盘和“重启”恢复；
- DM `disabled` 在 handler 前丢弃；`pairing` 可到 handler，`allowlist` 仅已列入 peer 可到 handler；二者随后仍受标准 Gateway 授权判定。未授权分支在 session/Agent 前阻断，而获授权的发送者会进入 Gateway Agent 链（测试以记录桩证明分支，不构造 Agent）；
- 公开 `hermes send` 的 CLI handler 已以假 Weixin transport 覆盖路由；同时验证底层 `send_weixin_direct` 到假 iLink 的单 peer payload 与 context token。该测试不启动 CLI 子进程，不能等同于真实 iLink 投递；
- 零 AIAgent、Provider、工具调用的 adapter/Gateway 早退路径；
- timeout、HTTP 4xx/5xx、坏 JSON 的当前默认重试行为，以及两次独立逻辑发送产生不同 `client_id` 的幂等缺口；
- 随机临时状态清理。

最后两项是**风险证据**：测试通过表示已可重复观测到 v2026.8.3 的行为，不表示这些行为适合生产。当前源码对这四类失败会默认尝试 1+4 次；独立重复调用也没有跨调用幂等键。因本任务禁止修改 Hermes 生产逻辑，PoC 不修复这些缺口。
