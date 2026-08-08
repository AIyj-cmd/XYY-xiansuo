import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveNotificationConfig } from '../config.js';
import { commitHermesBinding, consumeHermesInternalNonce, disableHermesBinding, fingerprint, issueHermesBindingCode, prepareHermesBindingByCode, publicHermesBinding, refreshHermesBinding, verifyHermesInternalSignature } from '../services/hermes-binding.js';
import { nowDatetime } from '../utils/datetime.js';

const internalSchema = z.object({ userId: z.number().int().positive(), activationId: z.string().uuid(), peerFingerprint: z.string().regex(/^[0-9a-f]{64}$/), generation: z.number().int().positive() }).strict();
const prepareSchema = z.object({ code: z.string().regex(/^XYY-[A-Z2-7]{26}$/), peerFingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const refreshSchema = z.object({ userId: z.number().int().positive(), peerFingerprint: z.string().regex(/^[0-9a-f]{64}$/), generation: z.number().int().positive() }).strict();
function bad(reply: any, msg: string, status = 400) { return reply.code(status).send({ code: 1, msg, data: null }); }

export async function hermesBindingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hermes-binding', { preHandler: authenticate }, async (request, reply) => reply.send({ code: 0, msg: 'ok', data: publicHermesBinding(getDb(), request.user.id) }));
  app.post('/api/hermes-binding/code', { preHandler: authenticate }, async (request, reply) => {
    if (!resolveNotificationConfig().hermesBindingEnabled) return bad(reply, 'Hermes 绑定功能未启用', 409);
    try { const issued = issueHermesBindingCode(getDb(), request.user.id); return reply.send({ code: 0, msg: '请在微信中发送该绑定码', data: issued }); }
    catch (error) { return bad(reply, (error as Error).message, (error as any).code === 'HERMES_BINDING_RATE_LIMIT' ? 429 : 409); }
  });
  const internal = (path: string, handler: (value: any) => any) => app.post(path, async (request, reply) => {
    const config = resolveNotificationConfig(); const raw = JSON.stringify(request.body ?? {});
    const nonce = String(request.headers['x-hermes-nonce'] ?? ''); const db = getDb();
    if (!config.hermesBindingEnabled || !config.hermesInternalSecret || !verifyHermesInternalSignature(config.hermesInternalSecret, 'POST', path, String(request.headers['x-hermes-timestamp'] ?? ''), nonce, raw, String(request.headers['x-hermes-signature'] ?? '')) || !consumeHermesInternalNonce(db, nonce, nowDatetime())) return bad(reply, '内部认证失败', 401);
    const parsed = (path.endsWith('/refresh') ? refreshSchema : path.endsWith('/prepare') ? prepareSchema : internalSchema).safeParse(request.body); if (!parsed.success) return bad(reply, '内部请求格式不合法');
    try { return reply.send({ code: 0, msg: 'ok', data: handler(parsed.data) }); } catch { return bad(reply, '绑定请求被拒绝', 409); }
  });
  internal('/internal/hermes-bindings/prepare', (value) => prepareHermesBindingByCode(getDb(), value, nowDatetime()));
  internal('/internal/hermes-bindings/commit', (value) => { commitHermesBinding(getDb(), value as any, nowDatetime()); return { committed: true }; });
  internal('/internal/hermes-bindings/refresh', (value) => { refreshHermesBinding(getDb(), value, nowDatetime()); return { refreshed: true }; });
  // Kept internal-only for operator cleanup; it never exposes a peer.
  app.post('/internal/hermes-bindings/disable/:userId', async (request, reply) => {
    const config = resolveNotificationConfig(); const path = '/internal/hermes-bindings/disable/:userId'; const raw = JSON.stringify(request.body ?? {});
    const nonce = String(request.headers['x-hermes-nonce'] ?? ''); if (!config.hermesBindingEnabled || !config.hermesInternalSecret || !verifyHermesInternalSignature(config.hermesInternalSecret, 'POST', path, String(request.headers['x-hermes-timestamp'] ?? ''), nonce, raw, String(request.headers['x-hermes-signature'] ?? '')) || !consumeHermesInternalNonce(getDb(), nonce, nowDatetime())) return bad(reply, '内部认证失败', 401);
    const id = z.coerce.number().int().positive().safeParse((request.params as any).userId); if (!id.success) return bad(reply, '用户无效'); disableHermesBinding(getDb(), id.data, nowDatetime()); return reply.send({ code: 0, msg: 'ok', data: null });
  });
}

export { fingerprint };
