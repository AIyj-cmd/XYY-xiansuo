import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const testDirectory = mkdtempSync(path.join(tmpdir(), 'xiansuo-startup-failure-'));
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-bytes-long';
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(testDirectory, 'failed.db');

test('迁移校验和冲突时 buildApp 拒绝启动 HTTP 服务', async () => {
  const database = new DatabaseSync(process.env.DB_PATH!);
  database.exec(`CREATE TABLE schema_migrations (
    version TEXT PRIMARY KEY, description TEXT NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );`);
  database.prepare('INSERT INTO schema_migrations (version, description, checksum) VALUES (?,?,?)')
    .run('001', 'create baseline schema', 'incorrect-checksum');
  database.close();
  const { buildApp } = await import('../src/index.js');
  await assert.rejects(buildApp(), /校验和不匹配/);
});

test.after(() => rmSync(testDirectory, { recursive: true, force: true }));
