# H5-only 前端清理验收报告

日期：2026-07-30

基线提交：`7b07ec8cc78cb700477b108eeb51f3d807efd7e4`

分支：`chore/h5-only-frontend`

## 1. 验收结论

H5-only 前端清理验收通过，未发现未解决 P1/P2。前端当前只有 H5 开发和构建目标；微信小程序脚本、直接依赖、专属可达依赖树和历史可再生构建目录均已移除。

本次没有修改 `app/src` 业务代码、后端、API、数据库、迁移 `001`–`004`、通知基础设施或公海逻辑，也没有部署、推送或创建 PR。

## 2. 清理和保留范围

已清理：

- `app/package.json` 中的 `dev:mp-weixin`、`build:mp-weixin`；
- `@dcloudio/uni-mp-weixin` 及锁文件中的小程序专属可达依赖树；
- 本轮浏览器验证生成的 `.playwright-cli/`；
- 被忽略、可再生的历史 `app/dist/build/mp-weixin/`。

精确删除的两个目录不含用户业务数据，无法从 Git 恢复，但均属于可重新生成的测试或构建产物。`app/dist/build/h5/` 保留并由最终构建刷新。

明确保留：

- `dev:h5`、`build:h5` 和 `@dcloudio/uni-h5`；
- Vue、Pinia、uni-app 共享依赖、Vite、`pages.json`、App、页面、组件和 `uni` API；
- 泛非 H5 条件编译代码；
- 微信号字段、公众号来源、跟进方式“微信”；
- 普通微信/企业微信通知渠道的未来独立规划和安全边界；
- 历史报告中的原始命令、数字、SHA、checksum 和当时小程序构建通过结论。

## 3. 依赖结果

- `package-lock.json` 由 npm 命令生成并可被现有安装树解析。
- 锁文件 `packages` 条目从基线 619 个收敛为 523 个。
- `@dcloudio/uni-mp-weixin`、`uni-mp-vite`、`uni-mp-compiler`、`uni-mp-vue` 的依赖树为空。
- `@dcloudio/uni-h5`、`@dcloudio/uni-app`、`@dcloudio/uni-components` 保持可达。
- 生产依赖审计：0 vulnerabilities。
- 全量开发依赖审计：2 vulnerabilities（1 moderate、1 high），来自固定 uni-app 工具链引用的 Vite/launch-editor 开发服务器链；自动修复需要 `--force` 并造成不兼容升级，本次不越权处理。

## 4. 最终验证

| 验证 | 结果 |
| --- | --- |
| `cd app && npm run` | 仅 `dev:h5`、`build:h5` |
| `cd app && npm run build:h5` | 通过 |
| H5 产物 | `index.html`、核心 `assets/index-*.js`、页面 chunks 和静态资源存在 |
| `cd app && npm run build:mp-weixin` | 按预期失败：`Missing script` |
| `npm ls` 小程序四个包 | 空树 |
| `npm ls` H5/共享 uni 三个包 | 正常可达 |
| `cd app && npm audit --omit=dev` | 0 vulnerabilities |
| `cd server && npm run build` | 通过 |
| `cd server && npm test` | 61/61 |
| `git diff --check` | 通过 |
| `app/src` 相对基线 | 零差异 |
| `server`、迁移 `001`–`004` 相对基线 | 零差异 |
| `app/vite.config.ts`、`app/src/pages.json` 相对基线 | 零差异 |

独立测试阶段的 H5 浏览器烟测证据已复核并复用：登录、仪表盘、线索列表、详情、新建线索、跟进、线索池“全部线索”、搜索/筛选/排序/收藏和详情路径正常；未显示公海认领入口，网络路径使用 `/api/leads`。最终验收另行重跑构建、后端全量和静态门禁，没有重复写入浏览器测试数据。

`server/data` 五个文件的验收前后 SHA-256 保持不变：

| 文件 | SHA-256 |
| --- | --- |
| `app.db` | `c5526fb5ef63e920531fe66ecd45a8b5cd80b33e40da33e31c316a1598e4b2c3` |
| `app.db-shm` | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |
| `app.db-wal` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `leads.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `xiansuo.db` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## 5. 关键词剩余分类

### 当前交付和工作流

`AGENTS.md`、test verifier 配置、项目说明、现行阶段三部署/回滚和 package scripts 均只要求 H5。出现“微信小程序”的位置为“不再构建/发布/验收”的否定性说明。

### 历史事实

早期系统分析、实施报告、测试报告、验收报告和阶段一/二运维记录保留原小程序命令及当时通过结论。现行索引和相关阶段三文档已追加 H5-only 后续决策说明，不把历史结果误写为当前命令。

### 业务微信语义

线索微信号、公众号来源、跟进方式“微信”等是业务数据，不是平台构建依赖，完整保留。

### 未来通知渠道

普通微信、企业微信、绑定、凭证和渠道安全设计仍是独立未来能力；本次既未删除规划，也未实现任何渠道。

没有发现无法解释的小程序构建引用。

## 6. 残余风险和发布建议

- 开发依赖仍有 1 moderate、1 high；生产依赖为 0。开发服务器必须继续只监听本机，不把 Vite 开发服务暴露到不可信网络。
- 浏览器烟测未构造多页数据实际触发分页，也未自动操作浏览器通知授权弹窗；对应代码相对基线无变化。
- 历史文档仍可搜索到小程序命令，这是有意保留的历史证据；当前决策和工作流优先。

上线建议：**GO（H5-only）**。发布时只同步新鲜的 `app/dist/build/h5/`，不得恢复或上传微信小程序产物。开发依赖升级需单独评估 uni-app/Vite 兼容性。
