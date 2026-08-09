import type { FastifyInstance } from 'fastify';
import path from 'path';
import { fileURLToPath } from 'url';
import { chmodSync, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'crypto';
import { authenticate } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
// 暂存目录必须位于公开 uploads 根目录之外，且没有任何静态路由映射到它。
export const UPLOAD_STAGING_DIR = path.join(__dirname, '..', '..', 'upload-staging');
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = strictUploadLimit('UPLOAD_MAX_CONCURRENT', 4, 1, 32);
const MAX_USER_UPLOAD_BYTES = strictUploadLimit('UPLOAD_MAX_USER_BYTES', 100 * 1024 * 1024, MAX_UPLOAD_BYTES, 10 * 1024 * 1024 * 1024);
const MAX_GLOBAL_UPLOAD_BYTES = strictUploadLimit('UPLOAD_MAX_GLOBAL_BYTES', 1024 * 1024 * 1024, MAX_UPLOAD_BYTES, 100 * 1024 * 1024 * 1024);
const MAX_USER_UPLOAD_FILES = strictUploadLimit('UPLOAD_MAX_USER_FILES', 100, 1, 10_000);
const MAX_GLOBAL_UPLOAD_FILES = strictUploadLimit('UPLOAD_MAX_GLOBAL_FILES', 10_000, 1, 1_000_000);
const MIN_FREE_UPLOAD_BYTES = strictUploadLimit('UPLOAD_MIN_FREE_BYTES', 512 * 1024 * 1024, 0, 100 * 1024 * 1024 * 1024);

function strictUploadLimit(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须为整数，拒绝启动`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 超出允许范围，拒绝启动`);
  return parsed;
}

let activeUploads = 0;
const uploadWaiters: Array<() => void> = [];
let publishTail: Promise<void> = Promise.resolve();
async function acquireUploadSlot(): Promise<void> {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new UploadValidationError('上传繁忙，请稍后重试', 503);
  activeUploads += 1;
}
function releaseUploadSlot(): void { activeUploads -= 1; uploadWaiters.shift()?.(); }
async function withPublishLock<T>(work: () => T | Promise<T>): Promise<T> {
  const previous = publishTail;
  let release!: () => void;
  publishTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

for (const directory of [UPLOADS_DIR, UPLOAD_STAGING_DIR]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']);
const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
};

class UploadValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function hasPrefix(content: Buffer, prefix: readonly number[]): boolean {
  return content.length >= prefix.length && prefix.every((byte, index) => content[index] === byte);
}

function hasSuffix(content: Buffer, suffix: readonly number[]): boolean {
  return content.length >= suffix.length && suffix.every((byte, index) => content[content.length - suffix.length + index] === byte);
}

/**
 * 这里故意只接受明确、可验证的容器签名，不把任意 ISO-BMFF/RIFF 文件
 * 当作图片。文件解码不引入新的大型生产依赖；上传流截断和不完整容器均拒绝。
 */
function detectImageMime(content: Buffer): string | null {
  if (hasPrefix(content, [0xff, 0xd8, 0xff]) && hasSuffix(content, [0xff, 0xd9])) return 'image/jpeg';
  if (hasPrefix(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      && hasSuffix(content, [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])) return 'image/png';
  if ((content.subarray(0, 6).equals(Buffer.from('GIF87a')) || content.subarray(0, 6).equals(Buffer.from('GIF89a')))
      && hasSuffix(content, [0x3b])) return 'image/gif';
  if (content.length >= 12 && content.subarray(0, 4).equals(Buffer.from('RIFF'))
      && content.subarray(8, 12).equals(Buffer.from('WEBP'))
      && content.readUInt32LE(4) + 8 === content.length) return 'image/webp';
  if (content.length < 16 || !content.subarray(4, 8).equals(Buffer.from('ftyp'))) return null;

  const boxSize = content.readUInt32BE(0);
  if (boxSize < 16 || boxSize > content.length) return null;
  const brands = [content.subarray(8, 12).toString('ascii')];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(content.subarray(offset, offset + 4).toString('ascii'));
  return brands.includes('heic') ? 'image/heic' : null;
}

function rejectInvalidUpload(data: { mimetype: string; file: { truncated: boolean } }, content: Buffer): void {
  if (data.file.truncated || content.length > MAX_UPLOAD_BYTES) throw new UploadValidationError('图片大小不能超过 10MB', 413);
  if (content.length === 0) throw new UploadValidationError('图片文件不能为空');
  if (!ALLOWED_MIME.has(data.mimetype)) throw new UploadValidationError('仅支持 JPG/PNG/GIF/WebP/HEIC 图片');

  const detectedMime = detectImageMime(content);
  if (!detectedMime) throw new UploadValidationError('图片文件签名无效或内容不完整');
  if (detectedMime !== data.mimetype) throw new UploadValidationError('图片文件类型与内容不一致');
}

function removeQuietly(filepath: string | undefined): void {
  if (!filepath) return;
  try { rmSync(filepath, { force: true }); } catch { /* 清理失败不掩盖原始上传错误 */ }
}

function usageForUser(userId: number): { files: number; bytes: number; userFiles: number; userBytes: number } {
  let files = 0; let bytes = 0; let userFiles = 0; let userBytes = 0;
  const prefix = `u${userId}_`;
  for (const filename of readdirSync(UPLOADS_DIR)) {
    const filepath = path.join(UPLOADS_DIR, filename);
    let entry: ReturnType<typeof statSync>;
    try { entry = statSync(filepath); } catch { continue; }
    if (!entry.isFile()) continue;
    files += 1; bytes += entry.size;
    if (filename.startsWith(prefix)) { userFiles += 1; userBytes += entry.size; }
  }
  return { files, bytes, userFiles, userBytes };
}

function assertStorageHeadroom(): void {
  const fs = statfsSync(UPLOADS_DIR);
  const available = Number(fs.bavail) * Number(fs.bsize);
  if (!Number.isSafeInteger(available) || available < MIN_FREE_UPLOAD_BYTES) throw new UploadValidationError('存储空间不足，暂不接受上传', 503);
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/upload/image — 上传单张图片，成功响应和 URL 契约保持不变。
  app.post('/api/upload/image', { preHandler: authenticate }, async (request, reply) => {
    let stagedPath: string | undefined;
    let publishedPath: string | undefined;
    let acquired = false;
    try {
      await acquireUploadSlot(); acquired = true;
      // 关闭本请求的自动抛错，统一在管线末端检查 truncated 并清理私有暂存文件。
      const data = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES }, throwFileSizeLimit: false });
      if (!data) return reply.code(400).send({ code: 1, msg: '未收到文件', data: null });

      const stagingName = `${Date.now()}_${randomBytes(12).toString('hex')}.part`;
      stagedPath = path.join(UPLOAD_STAGING_DIR, stagingName);
      await pipeline(data.file, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }));

      const content = readFileSync(stagedPath);
      rejectInvalidUpload(data, content);

      const filename = await withPublishLock(() => {
        assertStorageHeadroom();
        const usage = usageForUser(request.user.id);
        if (usage.files + 1 > MAX_GLOBAL_UPLOAD_FILES || usage.bytes + content.length > MAX_GLOBAL_UPLOAD_BYTES) throw new UploadValidationError('全局上传配额已满，请联系管理员', 507);
        if (usage.userFiles + 1 > MAX_USER_UPLOAD_FILES || usage.userBytes + content.length > MAX_USER_UPLOAD_BYTES) throw new UploadValidationError('个人上传配额已满，请清理后重试', 413);
        const name = `u${request.user.id}_${Date.now()}_${randomBytes(12).toString('hex')}${EXT_MAP[data.mimetype]}`;
        publishedPath = path.join(UPLOADS_DIR, name);
        // 两个目录同属 server/，rename 在同一文件系统内完成原子发布。
        renameSync(stagedPath!, publishedPath);
        stagedPath = undefined;
        chmodSync(publishedPath, 0o600);
        return name;
      });

      return reply.send({
        code: 0,
        msg: '上传成功',
        data: { url: `/uploads/${filename}` },
      });
    } catch (error) {
      removeQuietly(stagedPath);
      // chmod 或发布后的其他异常不能留下一个 API 未确认成功的最终文件。
      removeQuietly(publishedPath);
      if (error instanceof UploadValidationError) {
        return reply.code(error.statusCode).send({ code: 1, msg: error.message, data: null });
      }
      throw error;
    } finally { if (acquired) releaseUploadSlot(); }
  });
}
