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
      HERMES_BINDING_ENABLED: 'false',
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

test('Hermes runtime capability 关闭或请求失败时，菜单和深链均 fail-closed，且不创建/解绑/轮询', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/api/hermes-binding/qr-attempts') || (path === '/api/hermes-binding' && request.method() === 'DELETE')) mutations.push(`${request.method()} ${path}`);
  });
  await login(page, MEMBER);
  await page.goto(`${baseUrl}/pages/mine/index`);
  await expect(page.getByText('微信通知绑定')).toHaveCount(0);
  await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await expect(page.getByTestId('hermes-binding-disabled')).toBeVisible();
  await expect(page.getByTestId('hermes-qr-create')).toHaveCount(0);
  await expect(page.getByTestId('hermes-binding-remove')).toHaveCount(0);
  await page.waitForTimeout(2_300);
  expect(mutations).toEqual([]);

  await page.route('**/api/hermes-binding', route => route.abort('failed'));
  await page.goto(`${baseUrl}/pages/mine/index`);
  await expect(page.getByText('微信通知绑定')).toHaveCount(0);
  await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await expect(page.getByTestId('hermes-binding-disabled')).toBeVisible();
  expect(mutations).toEqual([]);
});

test('Hermes QR 页面展示受限 data QR，确认命令状态可即时查询', async ({ page, context }) => {
  const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqAAAAAElFTkSuQmCC';
  let attemptStatus: 'waiting' | 'scanned' | 'awaiting_context' | 'active' = 'waiting'; let bindingStatus: 'unbound' | 'active' = 'unbound'; let failAttemptGet = false; const attemptGetTimes: number[] = [];
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await page.route('**/api/hermes-binding**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.includes('/qr-attempts/')) { attemptGetTimes.push(Date.now()); if (failAttemptGet) return route.abort('failed'); }
    const data = request.method() === 'POST' ? { id: '12345678-1234-4234-a234-123456789012', status: 'waiting', generation: 3, expires_at: '2099-08-09 10:00:00', qr_data_url: qrDataUrl } : url.pathname.includes('/qr-attempts/') ? { id: '12345678-1234-4234-a234-123456789012', status: attemptStatus, generation: 3, expires_at: '2099-08-09 10:00:00', ...(attemptStatus === 'waiting' ? { qr_data_url: qrDataUrl } : { confirmation_command: '确认 12345678-1234-4234-a234-123456789012' }) } : { status: bindingStatus, generation: bindingStatus === 'active' ? 3 : 0, enabled: true };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ code: 0, msg: 'ok', data }) });
  });
  await login(page, ADMIN); await page.goto(`${baseUrl}/pages/hermes-binding/index`); await page.getByTestId('hermes-qr-create').click();
  const renderedQr = page.getByTestId('hermes-qr-image').locator('img');
  await expect(renderedQr).toBeVisible();
  await expect(renderedQr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.getByText(/^剩余 \d+:\d{2}$/)).toBeVisible();
  attemptStatus = 'scanned';
  await expect(page.getByText('已扫码，等待确认')).toBeVisible({ timeout: 5_000 });
  const sent = page.getByTestId('hermes-confirmation-sent'); await expect(sent).toBeVisible();
  const scannedClickAt = Date.now(); await sent.click();
  await expect.poll(() => attemptGetTimes.some(time => time >= scannedClickAt && time - scannedClickAt < 500)).toBe(true);
  await expect(page.getByTestId('hermes-confirmation-feedback')).toHaveText('正在等待确认命令，请确认已发送到新机器人会话。');
  await expect(page.getByText('绑定成功。此机器人现在只用于当前网站账号。')).toHaveCount(0);
  attemptStatus = 'awaiting_context';
  const command = page.getByTestId('hermes-confirmation-command'); await expect(command).toHaveText('确认 12345678-1234-4234-a234-123456789012', { timeout: 5_000 });
  await page.getByText('复制确认命令').click(); await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('确认 12345678-1234-4234-a234-123456789012');
  const pendingClickAt = Date.now(); await sent.click();
  await expect.poll(() => attemptGetTimes.some(time => time >= pendingClickAt && time - pendingClickAt < 500)).toBe(true);
  await expect(page.getByTestId('hermes-confirmation-feedback')).toHaveText('正在等待确认命令被新机器人会话接收，请确认发送位置正确。');
  await expect(page.getByText('绑定成功。此机器人现在只用于当前网站账号。')).toHaveCount(0);
  failAttemptGet = true; await sent.click();
  await expect(page.getByTestId('hermes-confirmation-feedback')).toHaveText('查询绑定状态失败，请稍后重试。');
  await expect(page.getByText('绑定成功。此机器人现在只用于当前网站账号。')).toHaveCount(0);
  failAttemptGet = false;
  attemptStatus = 'active'; bindingStatus = 'active'; await page.getByTestId('hermes-confirmation-sent').click();
  await expect(page.getByText('绑定成功。此机器人现在只用于当前网站账号。')).toBeVisible();
  await expect(page.getByText('已绑定', { exact: true })).toBeVisible();
});

test('Hermes QR 页面取消后停止轮询', async ({ page }) => {
  let polls = 0; let deletes = 0;
  const qrDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqAAAAAElFTkSuQmCC';
  await page.route('**/api/hermes-binding**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') { deletes += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'cancelled' } }) }); }
    const data = request.method() === 'POST' ? { id: '12345678-1234-4234-a234-123456789012', status: 'waiting', generation: 1, expires_at: '2099-08-09 10:00:00', qr_data_url: qrDataUrl } : path.includes('/qr-attempts/') ? (polls += 1, { id: '12345678-1234-4234-a234-123456789012', status: 'waiting', generation: 1, expires_at: '2099-08-09 10:00:00', qr_data_url: qrDataUrl }) : { status: 'unbound', generation: 0, enabled: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data }) });
  });
  await login(page, MEMBER); await page.goto(`${baseUrl}/pages/hermes-binding/index`); await page.getByTestId('hermes-qr-create').click();
  await page.getByTestId('hermes-qr-cancel').click(); await expect.poll(() => deletes).toBe(1);
  await page.waitForTimeout(2_300); expect(polls).toBe(0);
});

test('Hermes 已绑定页二次确认后才解除，取消不发请求且成功恢复未绑定', async ({ page }) => {
  let bindingStatus: 'active' | 'unbound' = 'active'; let removes = 0;
  await page.route('**/api/hermes-binding', async route => {
    if (route.request().method() === 'DELETE') { removes += 1; bindingStatus = 'unbound'; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'unbound' } }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: bindingStatus, generation: bindingStatus === 'active' ? 3 : 4, expires_at: null, mode: 'per_user_qr', enabled: true } }) });
  });
  await login(page, ADMIN); await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await expect(page.getByTestId('hermes-binding-remove')).toBeVisible(); await expect(page.getByTestId('hermes-qr-create')).toHaveCount(0);
  await page.getByTestId('hermes-binding-remove').click(); await expect(page.getByText('解除后将停止该机器人的通知，并需要重新绑定才能恢复。')).toBeVisible();
  await page.getByText('取消', { exact: true }).last().click(); await page.waitForTimeout(100); expect(removes).toBe(0);
  await page.getByTestId('hermes-binding-remove').click(); await page.getByText('解除绑定', { exact: true }).click(); await expect.poll(() => removes).toBe(1);
  await expect(page.getByText('未绑定', { exact: true })).toBeVisible(); await expect(page.getByTestId('hermes-qr-create')).toBeVisible();
});

test('Hermes 解除请求失败时保持已绑定且不显示生成二维码', async ({ page }) => {
  let removes = 0;
  await page.route('**/api/hermes-binding', async route => {
    if (route.request().method() === 'DELETE') { removes += 1; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 1, msg: '内部错误', data: null }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'active', generation: 3, expires_at: null, mode: 'per_user_qr', enabled: true } }) });
  });
  await login(page, MEMBER); await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await page.getByTestId('hermes-binding-remove').click(); await page.getByText('解除绑定', { exact: true }).click(); await expect.poll(() => removes).toBe(1);
  await expect(page.getByText('已绑定', { exact: true })).toBeVisible(); await expect(page.getByTestId('hermes-binding-remove')).toBeVisible(); await expect(page.getByTestId('hermes-qr-create')).toHaveCount(0);
});

test('Hermes 二次确认及请求进行中全程禁用按钮，双击不重复 DELETE', async ({ page }) => {
  let removes = 0; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/hermes-binding', async route => {
    if (route.request().method() === 'DELETE') { removes += 1; await held; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'unbound' } }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'active', generation: 3, expires_at: null, mode: 'per_user_qr', enabled: true } }) });
  });
  await login(page, MEMBER); await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  const remove = page.getByTestId('hermes-binding-remove'); await remove.click();
  await expect(remove).toHaveAttribute('disabled', 'true'); await remove.click({ force: true });
  await page.getByText('解除绑定', { exact: true }).click(); await expect.poll(() => removes).toBe(1);
  await expect(remove).toHaveAttribute('disabled', 'true'); await remove.click({ force: true }); await page.waitForTimeout(100); expect(removes).toBe(1);
  release(); await expect(page.getByTestId('hermes-qr-create')).toBeVisible();
});

test('Hermes 旧绑定需重绑时只允许解除，不生成并行二维码', async ({ page }) => {
  await page.route('**/api/hermes-binding', async route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, msg: 'ok', data: { status: 'rebind_required', generation: 3, expires_at: null, mode: 'per_user_qr', enabled: true } }) }));
  await login(page, MEMBER); await page.goto(`${baseUrl}/pages/hermes-binding/index`);
  await expect(page.getByText('旧绑定需重新绑定', { exact: true })).toBeVisible(); await expect(page.getByTestId('hermes-binding-remove')).toBeVisible(); await expect(page.getByTestId('hermes-qr-create')).toHaveCount(0);
});

test('自助改密成功立即清除本地会话并返回登录页', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto(`${baseUrl}/pages/mine/index`);
  await page.getByText('修改密码', { exact: true }).click();
  const inputs = page.locator('input.uni-input-input');
  await inputs.nth(0).fill(ADMIN.password);
  await inputs.nth(1).fill('h5-admin-new-password');
  await inputs.nth(2).fill('h5-admin-new-password');
  await page.getByText('确认修改', { exact: true }).click();
  await expect(page.getByText('账号登录')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({ token: localStorage.getItem('token'), userInfo: localStorage.getItem('userInfo') })))
    .toEqual({ token: null, userInfo: null });
});
