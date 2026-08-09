import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveNotificationConfig } from '../config.js';
import { activateHermesQrAttempt, cancelOwnedHermesQrAttempt, consumeHermesInternalNonce, createHermesQrAttempt, expireHermesQrAttempts, fingerprint, getOwnedHermesQrAttempt, markHermesQrAwaitingContext, markHermesQrConfirmed, publicHermesBinding, verifyHermesInternalSignature } from '../services/hermes-binding.js';
import { nowDatetime } from '../utils/datetime.js';
import { hermesManagerRequest } from '../services/hermes-account-manager.js';

const attemptId = z.string().uuid();
const managerQr = z.object({ status: z.enum(['waiting','scanned','awaiting_context','active','expired','failed','cancelled']), qrDataUrl: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).max(2_000_000).optional(), confirmationCommand: z.string().max(256).optional(), errorCode: z.string().max(100).optional() }).strict();
const managerActivation = z.object({ id: attemptId, accountRef: z.string().min(16).max(128), targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/), activationId: z.string().uuid() }).strict();
function bad(reply: any, msg: string, status = 400) { return reply.code(status).send({ code: 1, msg, data: null }); }

export async function hermesBindingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hermes-binding', { preHandler: authenticate }, async (request, reply) => {
    expireHermesQrAttempts(getDb(), nowDatetime());
    reply.header('Cache-Control', 'no-store');
    return reply.send({ code: 0, msg: 'ok', data: { ...publicHermesBinding(getDb(), request.user.id), mode: 'per_user_qr' } });
  });

  app.post('/api/hermes-binding/code', { preHandler: authenticate }, async (_request, reply) => bad(reply, '旧绑定码接口已退役，请生成登录二维码', 409));

  app.post('/api/hermes-binding/qr-attempts', { preHandler: authenticate }, async (request, reply) => {
    if (!resolveNotificationConfig().hermesBindingEnabled) return bad(reply, 'Hermes 绑定功能未启用', 409);
    let created: ReturnType<typeof createHermesQrAttempt>;
    try { created = createHermesQrAttempt(getDb(), request.user.id, nowDatetime()); }
    catch (error) { const code = (error as any).code; return bad(reply, (error as Error).message, code === 'HERMES_ATTEMPT_BUSY' ? 423 : code === 'HERMES_ATTEMPT_EXISTS' ? 409 : 429); }
    try {
      const upstream = managerQr.parse(await hermesManagerRequest('POST', '/qr-attempts', { id: created.id, userId: request.user.id, accountRef: created.account_ref, generation: created.generation, expiresAt: created.expires_at }));
      reply.header('Cache-Control', 'no-store');
      return reply.send({ code: 0, msg: '请使用微信扫描二维码', data: { id: created.id, status: upstream.status, generation: created.generation, expires_at: created.expires_at, ...(upstream.qrDataUrl ? { qr_data_url: upstream.qrDataUrl } : {}), ...(upstream.confirmationCommand ? { confirmation_command: upstream.confirmationCommand } : {}) } });
    } catch {
      cancelOwnedHermesQrAttempt(getDb(), request.user.id, created.id, nowDatetime());
      try { await hermesManagerRequest('DELETE', `/qr-attempts/${created.account_ref}`); } catch { /* manager expiry/reconciliation remains fail-closed */ }
      return bad(reply, '二维码暂时不可用，请稍后重试', 503);
    }
  });

  app.get('/api/hermes-binding/qr-attempts/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = attemptId.safeParse((request.params as any).id); if (!id.success) return bad(reply, '绑定请求无效', 404);
    const attempt = getOwnedHermesQrAttempt(getDb(), request.user.id, id.data, nowDatetime()); if (!attempt) return bad(reply, '绑定请求不存在', 404);
    let remote: z.infer<typeof managerQr> | undefined;
    if (['waiting','scanned','awaiting_context'].includes(attempt.status)) {
      try { remote = managerQr.parse(await hermesManagerRequest('GET', `/qr-attempts/${attempt.account_ref}`)); } catch { /* durable DB state remains available without QR */ }
    }
    const status = remote?.status ?? attempt.status;
    if (status === 'scanned') markHermesQrConfirmed(getDb(), attempt.id, nowDatetime());
    if (status === 'awaiting_context') markHermesQrAwaitingContext(getDb(), attempt.id, nowDatetime());
    reply.header('Cache-Control', 'no-store');
    return reply.send({ code: 0, msg: 'ok', data: { id: attempt.id, status, generation: attempt.generation, expires_at: attempt.expires_at, ...(remote?.qrDataUrl && status === 'waiting' ? { qr_data_url: remote.qrDataUrl } : {}), ...(remote?.confirmationCommand ? { confirmation_command: remote.confirmationCommand } : {}), ...(remote?.errorCode || attempt.error_code ? { error_code: remote?.errorCode ?? attempt.error_code } : {}) } });
  });

  app.delete('/api/hermes-binding/qr-attempts/:id', { preHandler: authenticate }, async (request, reply) => {
    const id = attemptId.safeParse((request.params as any).id); if (!id.success) return bad(reply, '绑定请求无效', 404);
    const attempt = getOwnedHermesQrAttempt(getDb(), request.user.id, id.data, nowDatetime()); if (!attempt) return bad(reply, '绑定请求不存在', 404);
    cancelOwnedHermesQrAttempt(getDb(), request.user.id, id.data, nowDatetime());
    try { await hermesManagerRequest('DELETE', `/qr-attempts/${attempt.account_ref}`); } catch { /* cancellation is already fail-closed in DB */ }
    reply.header('Cache-Control', 'no-store'); return reply.send({ code: 0, msg: '已取消', data: { id: id.data, status: 'cancelled' } });
  });

  // Account manager callback: fixed HMAC, durable nonce, and no provider raw values.
  app.post('/internal/hermes-accounts/activate', async (request, reply) => {
    const config = resolveNotificationConfig(); const path = '/internal/hermes-accounts/activate'; const raw = JSON.stringify(request.body ?? {}); const nonce = String(request.headers['x-hermes-nonce'] ?? '');
    if (!config.hermesBindingEnabled || !config.hermesInternalSecret || !verifyHermesInternalSignature(config.hermesInternalSecret, 'POST', path, String(request.headers['x-hermes-timestamp'] ?? ''), nonce, raw, String(request.headers['x-hermes-signature'] ?? '')) || !consumeHermesInternalNonce(getDb(), nonce, nowDatetime())) return bad(reply, '内部认证失败', 401);
    const parsed = managerActivation.safeParse(request.body); if (!parsed.success) return bad(reply, '内部请求格式不合法');
    try { const result = activateHermesQrAttempt(getDb(), parsed.data, nowDatetime()); return reply.send({ code: 0, msg: 'ok', data: result }); } catch { return bad(reply, '绑定请求被拒绝', 409); }
  });
}

export { fingerprint };
