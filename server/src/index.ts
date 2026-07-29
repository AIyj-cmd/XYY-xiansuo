import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db.js';
import { hashPassword } from './utils/password.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { leadRoutes } from './routes/leads.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { importExportRoutes } from './routes/import_export.js';
import { uploadRoutes, UPLOADS_DIR } from './routes/upload.js';
import { tagRoutes } from './routes/tags.js';
import { memoRoutes } from './routes/memo.js';
import { notificationRoutes } from './routes/notifications.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap(): Promise<void> {
  // 初始化数据库
  initDb();

  // 首次启动自动创建 admin 账号
  const db = getDb();
  const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as any).cnt;
  if (userCount === 0) {
    const hash = await hashPassword('xyy123456');
    db.prepare("INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)").run('admin', '管理员', hash, 'admin');
    console.log('======================================================');
    console.log('首次启动：已自动创建管理员账号');
    console.log('用户名: admin  初始密码: xyy123456');
    console.log('请登录后立即修改密码！');
    console.log('======================================================');
  }

  const app = Fastify({
    logger: false,
  });

  // 请求日志
  app.addHook('onResponse', (request, reply, done) => {
    const userId = (request as any).user?.id || '-';
    console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${request.method} ${request.url} ${reply.statusCode} ${reply.elapsedTime.toFixed(0)}ms uid:${userId}`);
    done();
  });

  // 生产环境前端由同一进程通过 @fastify/static 同源托管，本不需要跨域；
  // 这里的白名单主要是为了本地开发时 Vite dev server（不同端口）能访问后端接口。
  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean);
  await app.register(cors, { origin: corsOrigins });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

  // 允许空 body 的 JSON 请求（DELETE 等无 body 请求不报 400）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) { done(null, null); return; }
    try { done(null, JSON.parse(body as string)); }
    catch (e) { done(e as Error, undefined); }
  });

  // H5 静态产物托管
  // /assets/* 是 Vite 按内容 hash 命名的产物，内容变了文件名一定变，可以放心长期缓存；
  // index.html 每次都要拿最新的（里面引用的资源 hash 会变），不能缓存；
  // /static/* 是没有 hash 的固定文件名（tabbar 图标等），给一个适中的缓存时间。
  // 注意：@fastify/static 自己会在 setHeaders 之后再覆盖一次 Cache-Control（默认 maxAge=0），
  // 所以这里用 onSend 钩子在响应真正发出前再设一遍，保证最终生效的是这里的值。
  app.addHook('onSend', (request, reply, payload, done) => {
    const url = request.url.split('?')[0];
    if (url.startsWith('/assets/') || url.startsWith('/uploads/')) {
      // 都是内容变了文件名就变的场景（Vite hash / 上传文件时间戳+随机串命名）
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (url.startsWith('/static/')) {
      reply.header('Cache-Control', 'public, max-age=86400');
    } else if (url === '/' || url.endsWith('.html')) {
      reply.header('Cache-Control', 'no-cache');
    }
    done(null, payload);
  });

  const h5Path = path.join(__dirname, '..', '..', 'app', 'dist', 'build', 'h5');
  try {
    await app.register(staticFiles, { root: h5Path, prefix: '/' });
    // SPA fallback: 非API路由返回index.html
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ code: 1, msg: '接口不存在', data: null });
      }
      return reply.sendFile('index.html');
    });
  } catch {
    // H5未构建时静默跳过
    app.setNotFoundHandler(async (request, reply) => {
      return reply.code(404).send({ code: 1, msg: '接口不存在', data: null });
    });
  }

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(leadRoutes);
  await app.register(dashboardRoutes);
  await app.register(importExportRoutes);
  await app.register(tagRoutes);
  await app.register(memoRoutes);
  await app.register(notificationRoutes);
  await app.register(staticFiles, { root: UPLOADS_DIR, prefix: '/uploads/', decorateReply: false });
  await app.register(uploadRoutes);

  // 全局错误处理
  app.setErrorHandler((error, _request, reply) => {
    console.error('服务器错误:', error);
    reply.code(500).send({ code: 1, msg: '服务器内部错误', data: null });
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`服务已启动: http://localhost:${PORT}`);
}

bootstrap().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
