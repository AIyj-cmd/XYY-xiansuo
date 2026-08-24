import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ecosystemPath = path.resolve(process.cwd(), '..', 'deploy', 'ecosystem.config.cjs');

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('PM2 ecosystem 透传网站线索 Integration 配置且不提供默认值', () => {
  const serverDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-ecosystem-'));
  const token = randomBytes(32).toString('base64url');
  const ownerId = '42';
  const original = new Map([
    ['XIANSUO_SERVER_DIR', process.env.XIANSUO_SERVER_DIR],
    ['WEBSITE_LEAD_INGEST_TOKEN', process.env.WEBSITE_LEAD_INGEST_TOKEN],
    ['WEBSITE_LEAD_OWNER_ID', process.env.WEBSITE_LEAD_OWNER_ID],
  ]);
  const resolved = require.resolve(ecosystemPath);
  const previousModule = require.cache[resolved];

  try {
    process.env.XIANSUO_SERVER_DIR = serverDirectory;
    process.env.WEBSITE_LEAD_INGEST_TOKEN = token;
    process.env.WEBSITE_LEAD_OWNER_ID = ownerId;
    delete require.cache[resolved];
    const ecosystem = require(ecosystemPath) as { apps: Array<{ env: Record<string, string | undefined> }> };

    assert.equal(ecosystem.apps[0].env.WEBSITE_LEAD_INGEST_TOKEN, token);
    assert.equal(ecosystem.apps[0].env.WEBSITE_LEAD_OWNER_ID, ownerId);
  } finally {
    for (const [name, value] of original) restoreEnv(name, value);
    if (previousModule) require.cache[resolved] = previousModule;
    else delete require.cache[resolved];
    rmSync(serverDirectory, { recursive: true, force: true });
  }
});
