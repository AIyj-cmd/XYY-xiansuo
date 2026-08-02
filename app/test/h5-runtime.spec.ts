import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const ADMIN = { username: 'h5-admin', password: 'h5-admin-password' };
const MEMBER = { username: 'h5-member', password: 'h5-member-password' };
const RECIPIENT = { username: 'h5-recipient', password: 'h5-recipient-password' };

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
