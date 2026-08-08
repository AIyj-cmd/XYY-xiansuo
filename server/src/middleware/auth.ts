import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, JWTPayload } from '../utils/jwt.js';
import { getDb } from '../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: JWTPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization;
  // token 只走 Authorization header，不接受 query string 传 token（会被日志、浏览器历史记录明文留存）
  const rawToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!rawToken) {
    reply.code(401).send({ code: 1, msg: '未登录，请先登录', data: null });
    return;
  }
  try {
    const payload = await verifyToken(rawToken);
    const db = getDb();
    const user = db.prepare(
      'SELECT id, username, name, role, is_active FROM users WHERE id = ?'
    ).get(payload.id) as {
      id: number;
      username: string;
      name: string;
      role: string;
      is_active: number;
    } | undefined;
    if (!user || !user.is_active) {
      reply.code(401).send({ code: 1, msg: '账号已停用，请联系管理员', data: null });
      return;
    }
    // 权限与展示信息以数据库实时状态为准，避免角色调整后旧 JWT
    // 在最长 7 天有效期内继续保留原权限。
    request.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    };
  } catch {
    reply.code(401).send({ code: 1, msg: '登录已过期，请重新登录', data: null });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;
  if (request.user.role !== 'admin') {
    reply.code(403).send({ code: 1, msg: '无权限，仅管理员可操作', data: null });
  }
}
