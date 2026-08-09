import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-security-upload-'));
process.env.JWT_SECRET = 'security-upload-test-secret-at-least-32-bytes';
process.env.DB_PATH = path.join(testDirectory, 'app.db');
process.env.ADMIN_INITIAL_USERNAME = 'security-upload-admin';
process.env.ADMIN_INITIAL_NAME = '上传测试管理员';
process.env.ADMIN_INITIAL_PASSWORD = 'security-upload-password';
process.env.NOTIFICATION_CAPTURE_ENABLED = 'false';
process.env.NOTIFICATION_WORKER_ENABLED = 'false';
process.env.NOTIFICATION_MOCK_ENABLED = 'false';
process.env.NOTIFICATION_SCHEDULER_ENABLED = 'false';
process.env.HERMES_BINDING_ENABLED = 'false';

const { closeDb, getDb } = await import('../src/db.js');
const { buildApp } = await import('../src/index.js');
const { signToken } = await import('../src/utils/jwt.js');
const { UPLOADS_DIR, UPLOAD_STAGING_DIR } = await import('../src/routes/upload.js');

const app = await buildApp();
const admin = getDb().prepare("SELECT id FROM users WHERE username = 'security-upload-admin'").get() as { id: number };
const token = await signToken({ id: admin.id });
const testPrefix = `security-upload-${process.pid}-`;
const publishedFiles: string[] = [];
const stagingBaseline = new Set(readdirSync(UPLOAD_STAGING_DIR));

function multipartFile(filename: string, contentType: string, body: Buffer) {
  const boundary = `----xiansuo-security-upload-${randomSuffix()}`;
  return {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assertStagingRestored(): void {
  assert.deepEqual([...readdirSync(UPLOAD_STAGING_DIR)].sort(), [...stagingBaseline].sort());
}

async function upload(filename: string, contentType: string, body: Buffer) {
  return app.inject({ method: 'POST', url: '/api/upload/image', ...multipartFile(filename, contentType, body) });
}

test('API、H5 与上传响应均使用同一浏览器安全头，HSTS 不由 HTTP 应用伪造', async () => {
  const expectedCsp = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:";
  const api = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(api.headers['content-security-policy'], expectedCsp);
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['x-frame-options'], 'DENY');
  assert.equal(api.headers['referrer-policy'], 'no-referrer');
  assert.equal(api.headers['permissions-policy'], 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');
  assert.equal(api.headers['strict-transport-security'], undefined);

  const nginxConfig = readFileSync(path.resolve(process.cwd(), '..', 'deploy', 'nginx.conf'), 'utf8');
  assert.match(nginxConfig, /Strict-Transport-Security "max-age=31536000" always;/);
  assert.doesNotMatch(nginxConfig, /includeSubDomains|preload/);

  const h5 = await app.inject({ method: 'GET', url: '/' });
  assert.equal(h5.headers['content-security-policy'], expectedCsp);
});

test('上传仅在 MIME 与真实签名一致时原子发布为 0600，成功包络和 URL 保持兼容', async () => {
  const imageFixtures = [
    ['image/jpeg', 'valid.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])],
    ['image/png', 'valid.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])],
    ['image/gif', 'valid.gif', Buffer.from('GIF89a;')],
    ['image/webp', 'valid.webp', Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
    ['image/heic', 'valid.heic', Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00])],
  ] as const;

  for (const [mime, filename, content] of imageFixtures) {
    const response = await upload(`${testPrefix}${filename}`, mime, content);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'msg']);
    assert.equal(body.code, 0);
    assert.equal(body.msg, '上传成功');
    assert.match(body.data.url, /^\/uploads\/\d+_[a-f0-9]{24}\.(jpg|png|gif|webp|heic)$/);

    const filepath = path.join(UPLOADS_DIR, path.basename(body.data.url));
    publishedFiles.push(filepath);
    assert.equal(statSync(filepath).mode & 0o777, 0o600);
    assertStagingRestored();
  }

  const finalUrl = `/uploads/${path.basename(publishedFiles[0])}`;
  const staticResponse = await app.inject({ method: 'GET', url: finalUrl });
  assert.equal(staticResponse.statusCode, 200);
  assert.equal(staticResponse.headers['x-content-type-options'], 'nosniff');
  assert.equal(staticResponse.headers['content-security-policy']?.includes("script-src 'self'"), true);
  assert.deepEqual(staticResponse.rawPayload, imageFixtures[0][2]);
});

test('伪造、错配、零字节、签名不足和超限上传均失败且清理私有暂存', async () => {
  const invalidCases = [
    ['forged.jpg', 'image/jpeg', Buffer.from('<script>alert(1)</script>'), 400],
    ['mismatch.jpg', 'image/jpeg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]), 400],
    ['empty.png', 'image/png', Buffer.alloc(0), 400],
    ['short.png', 'image/png', Buffer.from([0x89, 0x50]), 400],
    ['too-large.jpg', 'image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10 * 1024 * 1024)]), 413],
  ] as const;

  for (const [filename, mime, content, expectedStatus] of invalidCases) {
    const response = await upload(`${testPrefix}${filename}`, mime, content);
    assert.equal(response.statusCode, expectedStatus);
    const body = response.json();
    assert.equal(body.code, 1);
    assert.equal(body.data, null);
    assertStagingRestored();
  }
});

test('私有暂存目录没有静态映射，内容不能通过 H5 路径读取', async () => {
  const filename = `${testPrefix}not-public.part`;
  const secret = 'private-upload-staging-content';
  const filepath = path.join(UPLOAD_STAGING_DIR, filename);
  writeFileSync(filepath, secret, { mode: 0o600 });
  try {
    const response = await app.inject({ method: 'GET', url: `/upload-staging/${filename}` });
    assert.notEqual(response.body, secret);
    assert.equal(response.rawPayload.includes(Buffer.from(secret)), false);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    unlinkSync(filepath);
    assertStagingRestored();
  }
});

test.after(async () => {
  await app.close();
  closeDb();
  for (const filepath of publishedFiles) {
    try { unlinkSync(filepath); } catch { /* 已由失败分支清理或断言失败后不存在 */ }
  }
  // 只删除本测试开始后遗留的文件；基线中的用户既有暂存文件绝不触碰。
  for (const filename of readdirSync(UPLOAD_STAGING_DIR)) {
    if (!stagingBaseline.has(filename)) {
      try { unlinkSync(path.join(UPLOAD_STAGING_DIR, filename)); } catch { /* best effort */ }
    }
  }
  rmSync(testDirectory, { recursive: true, force: true });
});
