import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ADMIN = { username: 'h5-admin', password: 'h5-admin-password' };
const MEMBER = { username: 'h5-member', password: 'h5-member-password' };
const RECIPIENT = { username: 'h5-recipient', password: 'h5-recipient-password' };
const REBIND = { username: 'h5-rebind', password: 'h5-rebind-password' };
const HERMES_INTERNAL_SECRET = 'h5-runtime-hermes-internal-secret-at-least-32-bytes';

let baseUrl = '';
let tempDir = '';
let server: ChildProcess | undefined;
let adminToken = '';
let leadId = 0;

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        reject(new Error('无法分配 H5 运行测试端口'));
        return;
      }
      probe.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  return { response, body: await response.json() as { code: number; data: any } };
}

async function hermesInternalApi(path: string, data: unknown) {
  const body = JSON.stringify(data);
  const timestamp = String(Date.now());
  const nonce = randomUUID().replaceAll('-', '');
  const signature = createHmac('sha256', HERMES_INTERNAL_SECRET)
    .update(['POST', path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n'))
    .digest('hex');
  return api(path, {
    method: 'POST',
    body,
    headers: {
      'x-hermes-timestamp': timestamp,
      'x-hermes-nonce': nonce,
      'x-hermes-signature': signature,
    },
  });
}

async function login(page: Page, credentials: typeof ADMIN): Promise<void> {
  await page.goto(`${baseUrl}/pages/login/index`);
  // uni-app H5 把 placeholder 渲染为相邻 div，不会保留为 input 属性。
  const inputs = page.locator('input.uni-input-input');
  await inputs.nth(0).fill(credentials.username);
  await inputs.nth(1).fill(credentials.password);
  await page.locator('.login-btn').click();
  await expect(page.getByText('搜索公司/联系人/手机')).toBeVisible();
}

test.beforeAll(async () => {
  const port = await getFreePort();
  tempDir = await mkdtemp(resolve(tmpdir(), 'xiansuo-h5-runtime-'));
  baseUrl = `http://127.0.0.1:${port}`;
  const hermesSecretFile = resolve(tempDir, 'hermes-internal.secret');
  await writeFile(hermesSecretFile, `${HERMES_INTERNAL_SECRET}\n`, { mode: 0o600 });
  const serverEntry = resolve(process.cwd(), '..', 'server', 'dist', 'index.js');
  server = spawn(process.execPath, [serverEntry], {
    cwd: resolve(process.cwd(), '..', 'server'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: resolve(tempDir, 'runtime.sqlite'),
      JWT_SECRET: 'h5-runtime-test-jwt-secret-at-least-32-bytes',
      ADMIN_INITIAL_USERNAME: ADMIN.username,
      ADMIN_INITIAL_NAME: 'H5管理员',
      ADMIN_INITIAL_PASSWORD: ADMIN.password,
      LEAD_POOL_CLAIM_ENABLED: 'false',
      NOTIFICATION_CAPTURE_ENABLED: 'false',
      NOTIFICATION_WORKER_ENABLED: 'false',
      NOTIFICATION_MOCK_ENABLED: 'false',
      NOTIFICATION_SCHEDULER_ENABLED: 'false',
      HERMES_BINDING_ENABLED: 'true',
      HERMES_INTERNAL_SECRET_FILE: hermesSecretFile,
    },
    stdio: 'ignore',
  });

  await expect.poll(async () => {
    try {
      return (await api('/api/health')).response.status;
    } catch {
      return 0;
    }
  }).toBe(200);

  const adminLogin = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify(ADMIN),
  });
  adminToken = adminLogin.body.data.token;
  const auth = { Authorization: `Bearer ${adminToken}` };
  const member = await api('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ...MEMBER, name: '测试业务员', role: 'member' }),
  });
  const recipient = await api('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ ...RECIPIENT, name: '接收业务员', role: 'member' }),
  });
  const lead = await api('/api/leads', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      contact_name: 'H5运行测试联系人', phone: '13800138000', source: '官网',
      owner_id: 1, lead_date: '2026-08-02', status: '新线索', intent_level: '中',
    }),
  });
  expect(member.body.code).toBe(0);
  expect(recipient.body.code).toBe(0);
  expect(lead.body.code).toBe(0);
  leadId = lead.body.data.id;
});

test.afterAll(async () => {
  if (server && !server.killed) {
    server.kill('SIGTERM');
    await new Promise<void>(resolveStop => server!.once('exit', () => resolveStop()));
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('管理员登录、列表、深链刷新与负责人变更', async ({ page }) => {
  await login(page, ADMIN);
  await expect(page.getByText('H5运行测试联系人').first()).toBeVisible();

  // 服务端静态 SPA fallback：直接刷新详情深链仍能正常加载。
  await page.goto(`${baseUrl}/pages/leads/detail?id=${leadId}`);
  await expect(page.getByText('H5运行测试联系人').first()).toBeVisible();
  await page.getByText('转移', { exact: true }).click();
  await page.getByText('接收业务员', { exact: true }).click();
  await expect(page.getByText('负责人')).toBeVisible();
  await expect.poll(async () => {
    const result = await api(`/api/leads/${leadId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    return result.body.data.owner_name;
  }).toBe('接收业务员');
});

test('member 无管理员 UI、越权 API 为 403 且保留会话，公海关闭', async ({ page }) => {
  await login(page, MEMBER);
  await page.goto(`${baseUrl}/pages/mine/index`);
  await expect(page.getByText('管理后台')).toHaveCount(0);
  const token = await page.evaluate(() => localStorage.getItem('token'));

  const status = await page.evaluate(async () => {
    const current = localStorage.getItem('token');
    return (await fetch('/api/users', { headers: { Authorization: `Bearer ${current}` } })).status;
  });
  expect(status).toBe(403);
  await page.goto(`${baseUrl}/pages/admin/users`);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).toBe(token);

  await page.goto(`${baseUrl}/pages/leads/detail?id=${leadId}`);
  await expect(page.getByText('转移', { exact: true })).toHaveCount(0);
  await page.goto(`${baseUrl}/pages/pool/index`);
  await expect(page.getByText('公海待认领')).toHaveCount(0);
});

test('401 清理会话并跳转登录页', async ({ page }) => {
  await login(page, ADMIN);
  await page.evaluate(() => localStorage.setItem('token', 'invalid-runtime-token'));
  await page.reload();
  await expect(page.getByText('账号登录')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});

test('Hermes 绑定页生成完整命令、轮询成功并在未配置入口时降级', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await login(page, ADMIN);
  await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await expect(page.getByText('机器人入口尚未配置')).toBeVisible();
  await expect(page.getByText('本页不会生成或展示登录二维码。')).toBeVisible();

  // uni-app H5 的 button 没有稳定的 ARIA role，使用页面组件类名定位。
  await page.locator('.button').click();
  const command = page.getByTestId('hermes-binding-command');
  await expect(command).toHaveText(/^绑定 XYY-[A-Z2-7]{26}$/);
  const fullCommand = (await command.textContent())!;
  await page.locator('.copy-button').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullCommand);
  await expect(page.getByText(/剩余 \d{2}:\d{2}/)).toBeVisible();

  const code = fullCommand.replace('绑定 ', '');
  const peerFingerprint = createHash('sha256').update('xiansuo/hermes-peer/v1\0h5-test-peer').digest('hex');
  const prepared = await hermesInternalApi('/internal/hermes-bindings/prepare', { code, peerFingerprint });
  expect(prepared.response.status).toBe(200);
  const committed = await hermesInternalApi('/internal/hermes-bindings/commit', {
    userId: prepared.body.data.userId,
    generation: prepared.body.data.generation,
    activationId: prepared.body.data.activationId,
    peerFingerprint,
  });
  expect(committed.response.status).toBe(200);
  await expect(page.getByText('绑定成功')).toBeVisible({ timeout: 5_000 });
  await expect(command).toHaveCount(0);
});

test('已有 active 绑定时重新生成码必须展示新的完整命令', async ({ page }) => {
  const created = await api('/api/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ ...REBIND, name: '重新绑定测试用户', role: 'member' }),
  });
  expect(created.response.status).toBe(200);
  await login(page, REBIND);
  await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await page.locator('.button').click();
  const command = page.getByTestId('hermes-binding-command');
  await expect(command).toHaveText(/^绑定 XYY-[A-Z2-7]{26}$/);
  const firstCode = (await command.textContent())!.replace('绑定 ', '');
  const peerFingerprint = createHash('sha256').update('xiansuo/hermes-peer/v1\0h5-rebind-peer').digest('hex');
  const prepared = await hermesInternalApi('/internal/hermes-bindings/prepare', { code: firstCode, peerFingerprint });
  const committed = await hermesInternalApi('/internal/hermes-bindings/commit', {
    userId: prepared.body.data.userId,
    generation: prepared.body.data.generation,
    activationId: prepared.body.data.activationId,
    peerFingerprint,
  });
  expect(committed.response.status).toBe(200);
  await expect(page.getByText('绑定成功')).toBeVisible({ timeout: 5_000 });

  // 避免等待真实的一分钟发码间隔；只调整本轮隔离 SQLite 的发码时间，
  // 生产服务的 rate limit 逻辑和页面请求链保持不变。
  const database = new DatabaseSync(resolve(tempDir, 'runtime.sqlite'));
  database.prepare("UPDATE hermes_bindings SET last_code_issued_at='2000-01-01 00:00:00' WHERE user_id=?").run(prepared.body.data.userId);
  database.close();

  const regenerated = page.waitForResponse(response =>
    response.url().endsWith('/api/hermes-binding/code') && response.request().method() === 'POST',
  );
  const activeStatus = page.waitForResponse(response =>
    response.url().endsWith('/api/hermes-binding') && response.request().method() === 'GET',
  );
  await page.locator('.button').click();
  expect((await regenerated).status()).toBe(200);
  const statusResponse = await activeStatus;
  expect(statusResponse.status()).toBe(200);
  expect((await statusResponse.json()).data.status).toBe('active');
  await expect(command).toHaveText(/^绑定 XYY-[A-Z2-7]{26}$/, { timeout: 3_000 });
  const secondCode = (await command.textContent())!.replace('绑定 ', '');
  expect(secondCode).not.toBe(firstCode);
  await expect(page.getByText('绑定成功')).toHaveCount(0);

  const preparedAgain = await hermesInternalApi('/internal/hermes-bindings/prepare', {
    code: secondCode,
    peerFingerprint,
  });
  expect(preparedAgain.response.status).toBe(200);
  expect(preparedAgain.body.data.generation).toBe(prepared.body.data.generation + 1);
  const committedAgain = await hermesInternalApi('/internal/hermes-bindings/commit', {
    userId: preparedAgain.body.data.userId,
    generation: preparedAgain.body.data.generation,
    activationId: preparedAgain.body.data.activationId,
    peerFingerprint,
  });
  expect(committedAgain.response.status).toBe(200);
  await expect(page.getByText('绑定成功')).toBeVisible({ timeout: 5_000 });
  await expect(command).toHaveCount(0);
});

test('Hermes 绑定页离开后，延迟轮询完成不会重新请求', async ({ page }) => {
  await login(page, MEMBER);
  await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await page.locator('.button').click();
  await expect(page.getByTestId('hermes-binding-command')).toBeVisible();

  let pollRequests = 0;
  let responseFulfilled = false;
  let signalPollStarted!: () => void;
  let releasePoll!: () => void;
  const pollStarted = new Promise<void>(resolve => { signalPollStarted = resolve; });
  const pollReleased = new Promise<void>(resolve => { releasePoll = resolve; });
  await page.route('**/api/hermes-binding', async route => {
    pollRequests += 1;
    signalPollStarted();
    await pollReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'pending', generation: 0, expires_at: null } }),
    });
    responseFulfilled = true;
  });

  await pollStarted;
  // 通过 SPA 路由卸载组件，不关闭旧页面，从而让已发出的 uni.request 正常完成。
  await page.evaluate(() => {
    window.history.pushState({}, '', '/pages/memo/index');
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
  await expect.poll(() => page.url()).toContain('/pages/memo/index');
  await expect(page.getByText('机器人入口尚未配置')).toHaveCount(0);
  releasePoll();
  await expect.poll(() => responseFulfilled).toBe(true);
  await page.waitForTimeout(2_300);
  expect(pollRequests).toBe(1);
  await page.unroute('**/api/hermes-binding');
});
