# H5-only 前端清理独立测试报告

测试日期：2026-07-30

测试结论：**允许进入验收阶段（无 P1/P2 阻断项）**。

## 测试环境与基线

- 分支：`chore/h5-only-frontend`
- 测试基线提交：`7b07ec8cc78cb700477b108eeb51f3d807efd7e4`
- 本次开始时工作区已有 implementer 未提交的依赖及文档改动；测试未恢复、覆盖或暂存其中任何文件。
- 测试未修改 `app/src`、`server/src`、迁移、部署实现或 `server/data`。

测试前后 `server/data` 的五个文件路径、大小和 SHA-256 一致：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `server/data/app.db` | 94208 | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `server/data/app.db-shm` | 32768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `server/data/app.db-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/leads.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server/data/xiansuo.db` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## 测试计划与范围

1. 验证 npm 脚本、直接调用和依赖树均已移除微信小程序构建目标。
2. 从干净、隔离的 H5 输出验证构建产物，不清理工作区历史产物。
3. 验证 H5 核心流程及线索池“全部线索”回归。
4. 验证后端构建、完整测试、迁移及 `server/data` 隔离。
5. 核验 H5-only 工作流、源码边界、关键字和历史文档语义。
6. 核验依赖锁文件收敛、生产依赖审计和差异卫生。

## 已执行命令及结果

| 验证 | 结果 | 证据/说明 |
| --- | --- | --- |
| `cd app && npm run` | 通过 | 仅列出 `dev:h5`、`build:h5`。 |
| `cd app && npm run build:mp-weixin` | 通过（预期拒绝） | npm 返回 `Missing script: "build:mp-weixin"`。 |
| `cd app && npm ls @dcloudio/uni-mp-weixin --all` | 通过 | 无可达依赖（命令以 npm 的空树状态退出）。`uni-mp-vite`、`uni-mp-compiler` 同样无可达依赖。 |
| `cd app && npm ls @dcloudio/uni-h5 @dcloudio/uni-app @dcloudio/uni-components --all` | 通过 | H5 与共享 uni 依赖仍存在。 |
| `cd app && npm ci --legacy-peer-deps` | 通过 | 安装 447 个包；全量（含开发依赖）npm 摘要提示 1 个 high。 |
| `cd app && npm audit --omit=dev` | 通过 | 生产依赖 0 vulnerabilities。 |
| `cd app && npm run build:h5` | 通过 | 正常产出 H5。 |
| 隔离目录 `npm run build:h5` | 通过 | 隔离目录仅产生 `dist/build/h5`（含 `index.html`、`assets`、`static`），明确不存在 `dist/build/mp-weixin`。初次受 sandbox 网络接口限制失败后，以授权的本地同命令重试通过。 |
| `cd server && npm run build && npm test` | 通过 | 61/61 测试通过；测试数据库均在 `/tmp`。 |
| `git diff --check` | 通过 | 无空白错误。 |
| `git diff 7b07ec8 -- app/src server/src` | 通过 | 无业务源码差异；`001`–`004` 亦无服务端差异。 |

锁文件由基线的 619 个 `packages` 条目收敛为 523 个；`@dcloudio/uni-mp-weixin` 及其专属依赖树已删除，同时共享 H5 依赖仍被锁定。

## H5 浏览器烟测

使用临时数据库和本机 `127.0.0.1` Fastify 实例执行；未接触 `server/data`，测试完成后已优雅停止该实例。

- 管理员登录后进入线索列表；仪表盘、线索列表、详情、创建线索均可用。
- 创建测试线索后可进入详情，新增跟进并更新为“跟进中”。
- 底部“线索池”入口可用，页面为“全部线索”能力：搜索、状态筛选、日期筛选、排序、收藏与详情跳转均存在并可用。
- 线索池页面未显示“公海待认领”页签或认领入口；网络请求为 `GET /api/leads`，未调用 `/api/pool`。
- H5 顶部未出现单独的小程序页签；浏览器通知仍由 H5 条件编译分支处理。

本次浏览器数据只有一条新建线索，未构造多页数据以实际触发翻页；分页的现有 `loadMore`、`hasMore` 和列表分页请求仍保留，且 `app/src` 相对基线无改动。筛选抽屉及浏览器通知授权也只做静态/代码路径核验，未做权限弹窗自动化。

## 工作流、代码边界与关键字核验

- `AGENTS.md` 和 test verifier 配置均仅要求 H5 构建；当前 package scripts 没有小程序目标。
- `app/src/pages.json`、`app/vite.config.ts`、页面路由、H5 条件编译及共享 `uni` API 未被误删；不存在 `app/manifest.json`，项目按现有 `pages.json` 配置。
- 当前活跃应用目录（排除 `node_modules`、`dist`）没有 `mp-weixin`、`uni-mp` 或“微信小程序”依赖/构建引用。
- 文档中的小程序命令和平台叙述分为历史事实与已标注的 H5-only 决策：新的 H5-only 决策/清理文档及当前 README、CHANGELOG 明确以 H5 为准；阶段三相关文档已说明旧小程序验证是历史记录。
- 更早阶段测试报告、基线报告和系统分析仍保留当时的微信小程序构建事实，符合“保留原测试数字、SHA、checksum 和历史事实”的要求，不是当前工作流指令。
- “微信”字段（如线索微信号、微信公众号来源、跟进方式）属于业务数据，保留正确；未来普通微信/企业微信渠道仅在历史/规划设计中出现，未发现 Wechaty、iLink、RPA、Hook、DeepSeek 或外部网络渠道实现。

## 发现项、风险与建议

1. **非阻断：工作区存在历史 `app/dist/build/mp-weixin` 产物。** 未由本次测试或本次清理产生，按指令未删除。隔离构建已证明新构建不会产生它。部署/验收应只发布新鲜的 `dist/build/h5`，不得把历史目录作为产物依据。
2. **非阻断：全量开发依赖审计仍显示 1 个 high。** 生产依赖审计为 0；此次只移除小程序依赖，未引入生产依赖。建议验收时将该开发依赖链单列为后续依赖治理项。
3. **非阻断：历史报告中仍有原始小程序构建记录。** 这些记录不应被改写；H5-only 决策文件与当前工作流已完成语义覆盖。

未发现 P1/P2 缺陷、权限绕过、迁移变化、`server/data` 污染或真实微信/AI/外部网络调用。

## 测试阶段文件变化

- 新增本报告：`docs/03-测试验证/H5_ONLY_FRONTEND_TEST_REPORT.md`。
- 浏览器工具生成未跟踪目录：`.playwright-cli/`。它仅含本次测试快照/运行产物，未纳入业务实现；未按用户要求以外的方式清理。

## 放行结论

允许进入 `acceptance_optimizer` 验收。条件是验收继续保留工作区已有 implementer 改动的归因，且发布仅使用新鲜 H5 构建产物。
