# 线索跟进管理系统

移动端优先的 H5 线索跟进系统。

## 技术栈

- **前端**: uni-app (Vue3 + TypeScript + Vite) + Pinia
- **后端**: Node.js ≥ 22.13 + Fastify + node:sqlite (WAL模式)
- **校验**: Zod v4
- **鉴权**: JWT (jose) + scrypt
- **导入导出**: exceljs

## 与 PRD 的已知偏离

如实记录几处后续迭代中偏离 PRD 原始设定的地方，供评审核对：

- **UI 组件库**（PRD 第 2 节）：要求用 wot-design-uni（失败则退 uview-plus）。实际全部页面用原生 `<view>`/`<button>` + 手写 CSS 实现，没有引入任何 UI 组件库。原因：项目节奏是逐页快速迭代 + 频繁的视觉细节调整（筛选抽屉、主题色联动、底部安全区适配等），手写组件在这些场景下改起来更直接，引入组件库反而要处理主题定制和样式覆盖的额外成本。
- **数据导出权限**（PRD 第 3/6 节）：原设定导出仅 admin。现改为登录用户均可导出，但 admin 导出全公司数据，普通用户只能导出自己负责的线索（不含软删数据）。原因：业务员日常需要自己核对/备份自己名下的客户数据，全锁给 admin 操作成本太高；全量客户数据（含所有人手机号）仍然只有 admin 能拿到。
- **线索删除权限**（PRD 第 3 节）：原设定 member 不可删除线索。现改为 member 可以软删除和恢复自己负责的线索，他人的线索仍然无权限操作（后端校验，不是只在前端隐藏按钮）。管理员可管理全公司的回收站。

## 开发启动

### 后端

```bash
cd server
npm install
export JWT_SECRET="$(openssl rand -hex 32)"
npm run dev        # 开发模式（热重载）
```

首次启动自动创建管理员账号：

- 用户名和姓名可由 `ADMIN_INITIAL_USERNAME`、`ADMIN_INITIAL_NAME` 配置，默认是 `admin`、`管理员`
- 设置了 `ADMIN_INITIAL_PASSWORD` 时使用该值（至少 12 位）
- 开发和测试环境未设置密码时生成一次性随机密码并只输出到首次启动日志
- `NODE_ENV=production` 的空数据库必须设置 `ADMIN_INITIAL_PASSWORD`，否则服务拒绝启动
- 登录后请立即修改初始密码

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

生成 2 个业务员账号（zhangsan/lisi）+ 20 条测试线索前，先设置至少 12 位的仅开发用途密码：

```bash
export SEED_MEMBER_PASSWORD='仅用于本地开发的长密码'
npm run seed
```

## 自动化检查

```bash
cd server
npm run build
npm test

cd ../app
npm run build:h5
```

GitHub Actions 会在推送和 Pull Request 时执行同样的后端构建、测试和 H5 构建。

当前 uni-app 插件严格要求 Vite `5.2.8`。该版本的开发服务器存在已公开安全公告，因此开发服务器被限制为仅监听 `127.0.0.1`，禁止暴露到局域网或公网；H5 生产包不包含 Vite 开发服务器。CI 使用 `npm audit --omit=dev` 确保前后端生产依赖保持无已知漏洞。

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

首次部署前，将 `deploy/.env.example` 复制为服务器上的 `/opt/xiansuo/.env`，填写至少 32 字节的 `JWT_SECRET`，设置生产数据库的绝对 `DB_PATH`，并将权限设为 `600`。首次部署到空数据库还必须设置至少 12 位的 `ADMIN_INITIAL_PASSWORD`。密钥文件只保留在服务器，不进入 Git 仓库和部署包。

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

## H5-only 发布边界

前端当前只构建、发布和验收 H5，产物为 `app/dist/build/h5/`。不再保留微信小程序依赖、构建脚本或发布流程；这不影响业务数据中的微信号、公众号来源、跟进方式“微信”，也不改变未来普通微信或企业微信通知渠道的独立安全设计。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `JWT_SECRET` | JWT 密钥，至少 32 字节 | **必须设置；未设置或太短时进程拒绝启动** |
| `NODE_ENV` | 运行环境 | `production` 的空数据库必须配置初始管理员密码 |
| `DB_PATH` | SQLite 数据库路径 | 未设置时为 `server/data/app.db`；相对路径按服务进程工作目录解析，生产建议绝对路径 |
| `ADMIN_INITIAL_USERNAME` | 首次管理员用户名 | `admin`，只在 users 表为空时读取 |
| `ADMIN_INITIAL_NAME` | 首次管理员姓名 | `管理员`，只在 users 表为空时读取 |
| `ADMIN_INITIAL_PASSWORD` | 首次创建 admin 的密码，至少 12 位 | 开发/测试环境未设置时仅首次生成随机密码；生产空库未设置则拒绝启动 |
| `POOL_IDLE_DAYS` | 多少天未跟进后允许进入公海并被认领 | `7` |
| `CORS_ORIGINS` | 允许跨域访问的来源，逗号分隔 | `http://localhost:5173,http://127.0.0.1:5173`（仅本地开发用，生产环境前后端同源不需要跨域） |

## 用户角色

- **member（业务员）**：在“线索”页管理自己负责的线索，在“线索池”查看全公司线索；可认领达到公海阈值的线索
- **admin（管理员）**：member 全部权限 + 全公司线索管理、用户管理、导入和全量导出

JWT 有效期为 7 天，但账号启停、姓名和角色会在每次请求时从数据库重新读取，因此权限调整会立即生效。

## 数据库迁移与备份

服务启动时会在 HTTP 监听前运行版本化迁移并执行 `integrity_check`、`foreign_key_check`；任一检查失败都会拒绝启动。迁移记录保存在 `schema_migrations`，已执行迁移的校验和不匹配同样会阻止启动。部署前应使用 `sqlite3 .backup` 或 [scripts/backup.sh](../../scripts/backup.sh) 对实际 `DB_PATH` 做可恢复备份，并先在副本上演练迁移；不要直接把未验证的工作区或本地数据库当成已部署版本。
