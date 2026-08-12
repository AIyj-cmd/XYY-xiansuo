import { createHash, createHmac, randomBytes } from 'node:crypto';
import { resolveNotificationConfig } from '../config.js';

/** Loopback-only manager client.  Its request body is intentionally limited to
 * opaque account references and never includes QR, provider, token or target data. */
export async function hermesManagerRequest(method: 'POST' | 'GET' | 'DELETE', pathname: string, body?: Record<string, unknown>): Promise<unknown> {
  const config = resolveNotificationConfig();
  if (!config.hermesBindingEnabled || !config.hermesAccountManagerUrl || !config.hermesAccountManagerSecret) throw Object.assign(new Error('Hermes 账号管理器未配置'), { code: 'HERMES_MANAGER_DISABLED' });
  const raw = body ? JSON.stringify(body) : '';
  const timestamp = String(Date.now()); const nonce = randomBytes(24).toString('base64url');
  const signature = createHmac('sha256', config.hermesAccountManagerSecret).update([method, pathname, timestamp, nonce, createHash('sha256').update(raw).digest('hex')].join('\n')).digest('hex');
  const response = await fetch(`${config.hermesAccountManagerUrl}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-hermes-manager-timestamp': timestamp, 'x-hermes-manager-nonce': nonce, 'x-hermes-manager-signature': signature, 'cache-control': 'no-store' }, ...(raw ? { body: raw } : {}) });
  if (!response.ok) throw Object.assign(new Error('账号管理器拒绝请求'), { code: response.status === 409 ? 'HERMES_MANAGER_CONFLICT' : 'HERMES_MANAGER_UNAVAILABLE' });
  return response.json();
}

/** Best-effort post-commit retirement.  The DB remains fail-closed even if the
 * loopback process is down and its next reconciliation is required. */
export async function retireHermesManagerAccount(accountRef: string | null | undefined): Promise<void> {
  if (!accountRef || !/^hr_[A-Za-z0-9_-]{16,96}$/.test(accountRef)) return;
  try { await hermesManagerRequest('DELETE', `/qr-attempts/${accountRef}`); } catch { /* external work must not roll back user disablement */ }
}
