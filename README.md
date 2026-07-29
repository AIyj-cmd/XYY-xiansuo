# 线索跟进管理系统

移动端优先的 H5 线索跟进系统，支持编译为微信小程序。

## 技术栈

- **前端**: uni-app (Vue3 + TypeScript + Vite) + Pinia
- **后端**: Node.js ≥ 22 + Fastify + node:sqlite (WAL模式)
- **校验**: Zod v4
- **鉴权**: JWT (jose) + scrypt
- **导入导出**: exceljs

## 与 PRD 的已知偏离

如实记录几处后续迭代中偏离 PRD 原始设定的地方，供评审核对：

- **UI 组件库**（PRD 第 2 节）：要求用 wot-design-uni（失败则退 uview-plus）。实际全部页面用原生 `<view>`/`<button>` + 手写 CSS 实现，没有引入任何 UI 组件库。原因：项目节奏是逐页快速迭代 + 频繁的视觉细节调整（筛选抽屉、主题色联动、底部安全区适配等），手写组件在这些场景下改起来更直接，引入组件库反而要处理主题定制和样式覆盖的额外成本。
- **数据导出权限**（PRD 第 3/6 节）：原设定导出仅 admin。现改为登录用户均可导出，但 admin 导出全公司数据，普通用户只能导出自己负责的线索（不含软删数据）。原因：业务员日常需要自己核对/备份自己名下的客户数据，全锁给 admin 操作成本太高；全量客户数据（含所有人手机号）仍然只有 admin 能拿到。
- **线索删除权限**（PRD 第 3 节）：原设定 member 不可删除线索。现改为 member 可以软删除自己负责的线索，他人的线索仍然无权限删除（后端校验，不是只在前端隐藏按钮）。删除后仍走软删 + 回收站机制，恢复操作仍然仅 admin 可执行。

## 开发启动

### 后端

```bash
cd server
npm install
npm run dev        # 开发模式（热重载）
```

首次启动自动创建管理员账号：
- 用户名：`admin`
- 初始密码：`xyy123456`（登录后请立即修改）

### 前端 H5

```bash
cd app
npm install --legacy-peer-deps
npm run dev:h5     # 开发服务器（默认 5173 端口）
```

### 种子数据

```bash
# 须先启动后端（初始化数据库）
./server/node_modules/.bin/tsx scripts/seed.ts
```

生成 2 个业务员账号（zhangsan/lisi，密码 xyy123456）+ 20 条测试线索。

## H5 构建

```bash
cd app
npm run build:h5   # 产物在 app/dist/build/h5/
```

## 后端托管静态产物

后端已配置 `@fastify/static` 托管 `app/dist/build/h5/` 目录，构建完成后直接启动后端即可同时提供 API 和 H5 页面：

```bash
cd server && npm run start
# 访问 http://localhost:3000
```

## 生产部署（Nginx HTTPS 反代）

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

## 每日备份

```bash
# 手动备份
bash scripts/backup.sh

# crontab 自动备份（每天凌晨 02:00）
0 2 * * * cd /path/to/project && bash scripts/backup.sh >> /var/log/xiansuo-backup.log 2>&1
```

备份保留最近 7 份，存储在 `server/backups/` 目录。

## 微信小程序编译

```bash
cd app
npm run build:mp-weixin   # 产物在 app/dist/build/mp-weixin/
```

> **注意**：上线微信小程序需要：企业主体认证 + 接口域名 ICP 备案 + 微信后台配置合法域名。备案周期数周，建议提前启动。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `JWT_SECRET` | JWT 密钥 | **必须设置，不再有内置兜底值；未设置时进程会拒绝启动** |
| `CORS_ORIGINS` | 允许跨域访问的来源，逗号分隔 | `http://localhost:5173,http://127.0.0.1:5173`（仅本地开发用，生产环境前后端同源不需要跨域） |

## 用户角色

- **member（业务员）**：查看全部线索、新增/编辑线索、写跟进
- **admin（管理员）**：member 全部权限 + 用户管理、软删除恢复、数据导入导出
