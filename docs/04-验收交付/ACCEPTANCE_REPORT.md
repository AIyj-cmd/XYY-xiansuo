# 当前版本离线收尾验收报告

日期：2026-08-02

基线：`75f29bc`

结论：**单账号/单接收人发布冻结通过，可形成本地提交；生产上线仍为 CONDITIONAL GO，不授权任何生产操作。多账号定向发送为 NO-GO。**

## 1. 验收边界

- 原始目标是收口 H5 锁文件、完整回归、当前全部迁移、首版生产配置与同事绑定准备，不再重新设计已真实验证的 OpenClaw 通道能力。
- 依据为用户当前指令、根 `AGENTS.md`、实际代码与 [`TEST_REPORT.md`](../03-测试验证/TEST_REPORT.md) 第 29 节（第 28 节为上一次离线收尾）。早期设计文档仅作历史上下文，不覆盖当前已确认范围。
- 提交祖先关系为线性且可追溯：`e0242dd` 是 `9542513`、`8db1f27`、`d140826`、`82a40a3` 与当前 `75f29bc` 的祖先；本轮真实未提交差异未包含迁移、H5 业务源码或依赖文件变更。
- 本轮没有启动 OpenClaw、Gateway、Worker、AI Scheduler 或 DeepSeek，没有发送微信，没有访问生产数据库，没有构建小程序。
- 发布范围冻结为单账号、单启用接收人；账号 B 仅 `experimental/disabled` 预配置，不删除凭据且不生产使用，其他同事使用 H5。DeepSeek 与 AI Scheduler 继续默认关闭。既有自动化已覆盖 `owner_changed` 固定详情与脱敏、`openclaw-weixin` 入站静默；本轮未扩大这些边界。

## 2. 验收结果

| 范围 | 结果 | 验收证据 |
| --- | --- | --- |
| H5 锁文件 | 通过 | `app/package.json` 未改，未升级直接依赖、未恢复小程序依赖；两个全新临时副本及仓库目录均用普通 `npm ci && npm run build:h5` 成功，未使用 `--force`/`--legacy-peer-deps`。 |
| Server | 通过 | `npm ci`、build 和 `146/146` 测试通过；仅使用测试临时库。 |
| Gateway | 通过 | build 和 `53/53` 测试通过；仅 Fake Adapter/离线 fixture。 |
| 迁移 | 通过 | 当前实际版本为 `001`–`007`；空库顺序执行、重复执行、`006` 升级、checksum 冲突、失败回滚、历史通知保留、默认规则关闭均有自动化证据；`integrity_check=ok`、`foreign_key_check=[]`。 |
| 部署配置 | 通过 | API/Worker/Gateway 的 PM2 单实例模板、Nginx HTTPS 占位模板、仓库外配置/Secret/映射/会话目录、日志轮转、启停顺序和回滚文档已收口。PM2 cwd 缺失或不是绝对路径时 fail-closed；部署包含 Gateway 制品但不会自动启动真实渠道。 |
| 单接收人发布门禁 | 通过 | 仓库外 `0600` 映射在离线 CLI 与 live Gateway 启动时均要求恰好一个 `enabled=true`；CLI 仅在 SAFE 时输出聚合计数，零个/多个启用项非零失败且不输出用户 ID 或 target。未绑定无回退。 |
| 文档敏感信息 | 通过 | 对本次发布文档扫描未发现真实账号 ID、具体 target、Secret/会话凭据或完整手机号；仅保留占位符、环境变量名和安全操作要求。 |
| 数据隔离 | 通过 | `server/data` 目录聚合 SHA-256 前后一致；未操作生产 DB。 |

## 3. 迁移冻结值

| 版本 | SHA-256 checksum |
| --- | --- |
| 001 | `c10d4871046168fe4d264341112454eba9983c979ba5ec16098f54ae0f0e57a0` |
| 002 | `db94974c385bf625457d12c33ee42c95b0c2e6c951d262dd0b9784fe8112b0d9` |
| 003 | `e774d92055d84bf62431de4af508d2ec0d70d2a05a384204f482bc3038f51704` |
| 004 | `61ab37aed4b7cc897e87bd01016ae79c38d472b967f816f1985522e8baf47f75` |
| 005 | `8636bf2723aa6991e2f8aa66b14b1232a16ea644d15954284e74acdbfa1a6346` |
| 006 | `b6b27bc98f6620ffa4bbfd829d6f248e0c726277e8f4d94d2be10bff6603026a` |
| 007 | `c09175e80d010ea056c3e93e5f4fdfc61c4b2f4c08c885d0a6b4e96b1f5242da` |

## 4. Vite audit 适用性复判

`npm audit --omit=dev` 因 npm v11 对 uni-app peer 树的标记方式，仍将直接 devDependency `vite@5.2.8` 报为 1 high。该总体级别不能不加区分地等同于当前静态发布运行漏洞：

- high 与多个 moderate 条目主要要求对网络暴露 Vite 开发服务器，部分还只影响 Windows；例如 [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) 明确要求对网络暴露 dev server。本项目生产只发布 H5 静态制品，不启动 Vite 服务。
- [GHSA-64vr-g452-qvp3](https://github.com/advisories/GHSA-64vr-g452-qvp3) 的 DOM clobbering 条目影响 Vite 构建的 `cjs`/`iife`/`umd` 产物。本次实际 H5 `index.html` 使用 `type="module"` 的 ES module 入口，不符合该适用条件。
- 用户明确禁止本轮升级直接依赖，而 uni-app 当前锁定该 Vite 系列。本轮不运行 `audit fix`、`--force` 或不兼容升级是正确的范围控制。

因此验收将其归类为**已知工具链升级债务和后续依赖升级门禁**，不是当前静态 H5 发布的未解决 P2。运行边界必须继续为：禁止对不可信网络启动 Vite dev server，生产制品只同步 `app/dist/build/h5/`；后续升级必须同时验证 uni-app 兼容性。

## 5. 验收优化

测试报告后的验收发现均属于已批准的部署收口范围，已完成小范围修复：

1. PM2 模板原先在 cwd 未设置时可能回退至调用目录；现在缺失或相对的 `XIANSUO_SERVER_DIR`/`XIANSUO_ILINK_GATEWAY_DIR` 会拒绝加载。
2. 生产环境示例的 `NODE_ENV` 由 `development` 修正为 `production`。
3. `setup.sh` 原先会直接复制含占位证书路径的 Nginx 模板；现在先校验域名，再在受控机上渲染域名和 Let's Encrypt 路径，并以 `nginx -t` 作切换前门禁。
4. 部署包原先未包含 Gateway 源码/锁文件和运行模板；现在会构建 Gateway 制品、复制 Worker/Gateway PM2 模板，但只更新 API，保持真实渠道停止。
5. 映射检查原脚本使用 devDependency `tsx`，不适用于 `npm prune --omit=dev` 后的制品；现在改为执行已编译 CLI。

## 6. 分级、残余风险与建议

- 未解决产品/实现缺陷：**P1=0、P2=0、P3=0**。
- 仓库内离线收尾：**GO，可提交**。
- 正式生产部署：**CONDITIONAL GO**。下列为外部/人工门禁，不是本轮代码 P 级缺陷：
  1. 集中提供生产项目目录、绝对 DB 路径、H5/Nginx/PM2 路径、备份/恢复目录、上一版制品，并授权只读一致性备份。
  2. 在生产副本完成当前 `001`–`007` 迁移与恢复演练，不得把生产主库作首次试跑目标。
  3. 明确维护窗口、回滚负责人，并另行授权 H5 覆盖、PM2/Nginx 操作及 OpenClaw/Gateway/Worker 启动。
  4. 仅对唯一指定内部接收人完成人工身份/映射核对；账号 B 保持 `experimental/disabled` 且不删除凭据，其他同事使用 H5。任何新真实发送仍需一次明确授权。

本结论不允许推送、合并、生产数据库操作、覆盖 H5、PM2/Nginx 重启或真实微信发送。
