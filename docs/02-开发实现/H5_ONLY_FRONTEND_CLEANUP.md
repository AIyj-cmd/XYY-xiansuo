# H5-only 前端清理实施说明

日期：2026-07-30

## 实施内容

- 通过 `npm uninstall @dcloudio/uni-mp-weixin --legacy-peer-deps` 自动收敛 `app/package.json` 与锁文件。
- 删除小程序开发和构建脚本，只保留 `dev:h5` 与 `build:h5`。
- 更新前端验证规范、现行项目说明、阶段三现行部署/回滚说明及相关历史运维说明。

## 明确保留

H5 页面、组件、路由、`uni` API、manifest/pages 文件、线索池、通知基础设施、服务器、迁移 `001` 至 `004` 均未修改。普通微信/企业微信通知规划、微信字段、跟进方式和公众号来源不属于本次平台清理。

## 验证目标

- `npm ci --legacy-peer-deps`
- `npm run build:h5`
- 小程序构建脚本缺失且平台包不再被依赖树解析
- 后端构建、全量测试、H5 生产依赖审计和差异检查
