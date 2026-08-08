import { FastifyInstance } from 'fastify';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { authenticate } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']);
const EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
};

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/upload/image — 上传单张图片，返回访问路径
  app.post('/api/upload/image', { preHandler: authenticate }, async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ code: 1, msg: '未收到文件', data: null });

    const mime = data.mimetype;
    if (!ALLOWED_MIME.has(mime)) {
      return reply.code(400).send({ code: 1, msg: '仅支持 JPG/PNG/GIF/WebP/HEIC 图片', data: null });
    }

    const ext = EXT_MAP[mime] || '.jpg';
    const filename = `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(filepath);
      data.file.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    return reply.send({
      code: 0,
      msg: '上传成功',
      data: { url: `/uploads/${filename}` },
    });
  });
}
