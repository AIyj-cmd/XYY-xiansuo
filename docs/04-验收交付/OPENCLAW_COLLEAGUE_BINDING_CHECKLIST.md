# OpenClaw 同事绑定实测清单

状态：仅准备，默认不执行；本清单不触发登录、读取入站消息或发送微信。

## 人工步骤

1. 同事添加专用通知微信。
2. 同事向该账号发送绑定码 `XYY-<user_id>`。
3. 管理员在 OpenClaw 官方界面**人工**取得该同事的 `…@im.wechat` target；不得由本仓库、Gateway 或任何脚本读取、解析或处理入站绑定码。
4. 管理员在仓库外新建精确 `0600` 的 JSON 映射文件，使用系统用户 ID 键和值 `{"target":"…@im.wechat","enabled":true}`；当前已冻结的 Worker 只允许 `OPENCLAW_PILOT_USER_ID` 这一名接收人，所以本次同事的系统用户 ID 必须与该仓库外配置一致，其他预配置映射项保持 `enabled:false`。文件内容、target 和系统用户 ID 不得提交或粘贴到记录模板。
5. 在不提供 Gateway Secret 的前提下，先完成 Gateway `npm run build`，再离线运行 `cd poc/ilink-gateway && OPENCLAW_RECIPIENT_MAP_FILE=/仓库外/映射.json npm run gateway:recipient-map-check`。该命令使用已编译 CLI，不依赖生产裁剪后不存在的 `tsx`。成功只输出 `SAFE` 及三项计数；任何失败均停止，修正权限/格式后重新检查。
6. 获得正式部署门禁后，重启 Gateway 以加载映射；再分配一条测试线索。
7. 同事确认只收到本人提醒，其他人确认未收到。任何真实发送前均须另行得到一次明确授权。

## 脱敏记录模板

```text
日期：
执行人：
同事代号：
系统 user_id：已在仓库外映射核对（不记录具体值）
映射检查：SAFE；recipients=<数量>；enabled=<数量>；disabled=<数量>
Gateway 重启：已获部署门禁 / 未执行
测试线索：测试数据 / 生产数据（须明确授权）
发送授权：接收人=<同事代号>；类型=owner_changed；数量=1；生产数据=是/否
本人收到：是/否
其他人未收到：是/否
target、Secret、会话凭证、消息全文：不记录
异常与停止动作：
```
