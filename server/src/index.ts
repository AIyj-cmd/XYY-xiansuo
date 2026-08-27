import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb, getDatabasePath } from './db.js';
import { ensureBrandSchema } from './brand-schema.js';
import { initializeAdmin } from './bootstrap.js';
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
import { notificationAdminRoutes } from './routes/notification-admin.js';
import { aiAdminRoutes } from './routes/ai-admin.js';
import { hermesBindingRoutes } from './routes/hermes-bindings.js';
import { websiteLeadIntegrationRoutes } from './routes/website-leads.js';
import { brandDomainRoutes } from './routes/brand-domain.js';
import { resolveNotificationConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

// 当前 H5 只需要同源 API、静态资源和上传文件能力。
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
].join('; ');

const PERMISSIONS_POLICY = 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

export async function buildApp(): Promise<FastifyInstance> {
  // 在任何数据库或 HTTP 副作用之前验证全部阶段三开关。
  resolveNotificationConfig();

  // 主库迁移先执行，品牌域依赖 users/leads 外键，随后以独立版本表幂等初始化。
  initDb();
  ensureBrandSchema(getDb());
  const brandForeignKeyViolations = getDb().prepare('PRAGMA foreign_key_check').all();
  if (brandForeignKeyViolations.length > 0) {
    throw new Error(`品牌域初始化后发现 ${brandForeignKeyViolations.length} 条外键异常，拒绝启动`);
  }
  console.log(`数据库路径: ${getDatabasePath()}`);

  // 只有迁移与完整性检查都成功后才允许初始化管理员和注册 HTTP 服务。
  await initializeAdmin(getDb());

  const app = Fastify({
    logger: false,
    // Forwarded headers are accepted only when the directly connected proxy is
    // loopback. Public clients cannot forge their source address.
    trustProxy: (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1',
  });

  app.addHook('onRequest', (_request, reply, done) => {
    reply
      .header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Permissions-Policy', PERMISSIONS_POLICY);
    done();
  });

  // 必须在注册任何封装插件或路由前设置，确保所有子上下文继承统一错误包络。
  app.setErrorHandler((error, _request, reply) => {
    console.error('服务器错误:', error);
    reply.code(500).send({ code: 1, msg: '服务器内部错误', data: null });
  });

  app.addHook('onResponse', (request, reply, done) => {
    const userId = (request as any).user?.id || '-';
    console.log(`[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] ${request.method} ${request.url} ${reply.statusCode} ${reply.elapsedTime.toFixed(0)}ms uid:${userId}`);
    done();
  });

  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(s => s.trim()).filter(Boolean);
  await app.register(cors, { origin: corsOrigins });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // 允许空 body 的 JSON 请求（DELETE 等无 body 请求不报 400）。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) { done(null, null); return; }
    try { done(null, JSON.parse(body as string)); }
    catch (e) { done(e as Error, undefined); }
  });

  // H5 静态产物托管。
  app.addHook('onSend', (request, reply, payload, done) => {
    const url = request.url.split('?')[0];
    if (url.startsWith('/assets/') || url.startsWith('/uploads/')) {
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
    await app.register(staticFiles, { root: h5Path, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ code: 1, msg: '接口不存在', data: null });
      }
      return reply.sendFile('index.html');
    });
  } catch {
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.code(404).send({ code: 1, msg: '接口不存在', data: null });
    });
  }

  await app.register(healthRoutes);
  await app.register(websiteLeadIntegrationRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(leadRoutes);
  await app.register(dashboardRoutes);
  await app.register(importExportRoutes);
  await app.register(brandDomainRoutes);
  await app.register(tagRoutes);
  await app.register(memoRoutes);
  await app.register(notificationRoutes);
  await app.register(notificationAdminRoutes);
  await app.register(hermesBindingRoutes);
  await app.register(aiAdminRoutes);
  await app.register(staticFiles, { root: UPLOADS_DIR, prefix: '/uploads/', decorateReply: false });
  await app.register(uploadRoutes);

  return app;
}

export async function bootstrap(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  console.log(`服务已启动: http://localhost:${PORT}`);
}

const entrypoint = process.argv[1] && path.resolve(process.argv[1]);
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  bootstrap().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}
