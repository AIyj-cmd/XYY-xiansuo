# XYY OpenClaw 微信入站静默插件

这是一个无依赖、无网络、无存储的原生 OpenClaw Hook 插件。它只在
`before_agent_reply` 的 `messageProvider` 精确为 `openclaw-weixin` 时返回
`{ handled: true }`，且不提供 `reply`；官方 Host 会在模型调用前静默结束该回合。

它不会读取或转发消息正文，不注册入站业务接口，不调用任何模型、DeepSeek、Gateway
或线索系统 API。其他渠道直接返回 `undefined`，由其原有策略处理。

## 受控安装（默认不执行）

仅可在专用 PoC OpenClaw state/config、人工确认版本为 OpenClaw `2026.7.1-2` 与
`@tencent-weixin/openclaw-weixin` `2.4.6` 后执行。先备份仓库外 `OPENCLAW_CONFIG_PATH`
（保留 `0600`）并停止 daemon；不得在生产或日常账号 state 中安装：

```bash
openclaw plugins install --link /绝对路径/xiansuo/poc/ilink-gateway/openclaw-plugins/xiansuo-no-reply
openclaw config set plugins.entries.xiansuo-openclaw-no-reply.enabled true
openclaw config set plugins.entries.xiansuo-openclaw-no-reply.hooks.allowConversationAccess true
openclaw plugins inspect xiansuo-openclaw-no-reply --runtime --json
```

最后一条命令的 runtime 输出必须显示 `hookCount` 为 `1`、`typedHooks` 包含
`before_agent_reply`，且没有 diagnostics；否则停止，不启动 daemon。安装命令不支持
`--force`，不得以手工修改配置文件替代上述两条 `config set`。

仓库外 OpenClaw 配置必须显式包含：

```json
{
  "plugins": {
    "entries": {
      "xiansuo-openclaw-no-reply": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

重新启动专用 daemon 后，仅通过官方 `plugins inspect` 核验注册；不得用真实微信入站或
Provider 调用作为安装检查。回滚方式是停止 daemon、恢复备份配置并 `plugins disable
xiansuo-openclaw-no-reply`，随后再次检查 runtime 注册已消失。
