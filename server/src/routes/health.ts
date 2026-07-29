import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => {
    return { code: 0, msg: '服务正常', data: { status: 'ok', time: new Date().toISOString() } };
  });
}
