import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getDb } from '../db.js';
import { assertActiveOwner } from '../services/lead-owner.js';
import { todayDate } from '../utils/datetime.js';

const INTEGRATION_SOURCE = 'website_integration';

const trimmedRequired = (max: number, message: string) =>
  z.string().max(max, `长度不能超过 ${max} 个字符`).transform((value) => value.trim()).pipe(z.string().min(1, message));

const nullableText = (max: number) =>
  z.string().max(max, `长度不能超过 ${max} 个字符`).transform((value) => value.trim()).nullable().optional()
    .transform((value) => value || null);

function normalizeWebsitePhone(value: string): string {
  return value.replace(/[\s-]/g, '');
}

function isWebsitePhone(value: string): boolean {
  return /^1[3-9]\d{9}$|^\d{3,4}\d{7,8}$/.test(value);
}

const websiteLeadSchema = z.object({
  name: trimmedRequired(80, '联系人不能为空'),
  phone: trimmedRequired(40, '电话不能为空').transform(normalizeWebsitePhone).refine(isWebsitePhone, '电话格式不正确'),
  company: nullableText(120),
  email: nullableText(120).refine(
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    '邮箱格式不正确',
  ),
  service: nullableText(80),
  message: trimmedRequired(1200, '需求描述不能为空'),
}).strict();

type WebsiteLead = z.infer<typeof websiteLeadSchema>;

function isExpectedToken(expected: string, supplied: string | undefined): boolean {
  const configured = expected.trim();
  if (Buffer.byteLength(configured, 'utf8') < 32 || !supplied) return false;
  const expectedDigest = createHash('sha256').update(configured, 'utf8').digest();
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function integrationToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  return match?.[1];
}

async function authenticateWebsiteIntegration(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isExpectedToken(process.env.WEBSITE_LEAD_INGEST_TOKEN || '', integrationToken(request))) {
    reply.code(401).send({ code: 1, msg: '无效的集成凭据', data: null });
  }
}

function configuredOwnerId(): number | null {
  const raw = process.env.WEBSITE_LEAD_OWNER_ID || '';
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const ownerId = Number(raw);
  return Number.isSafeInteger(ownerId) ? ownerId : null;
}

function sourceNote(lead: WebsiteLead): string | null {
  const lines = [
    lead.service ? `咨询服务：${lead.service}` : null,
    lead.email ? `邮箱：${lead.email}` : null,
  ].filter((line): line is string => line !== null);
  return lines.length ? lines.join('\n') : null;
}

function duplicateReply(reply: FastifyReply) {
  return reply.send({ code: 0, msg: '线索已存在', data: { duplicate: true } });
}

export async function websiteLeadIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const options = { preHandler: authenticateWebsiteIntegration };

  app.get('/api/integrations/website-leads/health', options, async (_request, reply) => {
    const ownerId = configuredOwnerId();
    if (!ownerId) return reply.code(503).send({ code: 1, msg: '集成服务未就绪', data: null });
    try {
      const db = getDb();
      assertActiveOwner(db, ownerId);
      db.prepare('SELECT 1').get();
      return reply.send({ code: 0, msg: 'ok', data: { status: 'ok' } });
    } catch {
      return reply.code(503).send({ code: 1, msg: '集成服务未就绪', data: null });
    }
  });

  app.post('/api/integrations/website-leads', options, async (request, reply) => {
    const parsed = websiteLeadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 1, msg: parsed.error.issues[0].message, data: null });
    }

    const ownerId = configuredOwnerId();
    if (!ownerId) return reply.code(503).send({ code: 1, msg: '集成服务未就绪', data: null });

    const db = getDb();
    try {
      assertActiveOwner(db, ownerId);
    } catch {
      return reply.code(503).send({ code: 1, msg: '集成服务未就绪', data: null });
    }

    const lead = parsed.data;
    if (db.prepare('SELECT id FROM leads WHERE phone = ?').get(lead.phone)) {
      return duplicateReply(reply);
    }

    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare(`
        INSERT INTO leads (company_name, contact_name, phone, source, source_note, demand_note, intent_level, status, owner_id, lead_date, created_by)
        VALUES (?, ?, ?, '官网留言', ?, ?, '未知', '新线索', ?, ?, ?)
      `).run(
        lead.company,
        lead.name,
        lead.phone,
        sourceNote(lead),
        lead.message,
        ownerId,
        todayDate(),
        ownerId,
      );
      const leadId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO audit_logs (lead_id, user_id, action, field, old_val, new_val, source)
        VALUES (?, ?, 'create', NULL, NULL, NULL, ?)
      `).run(leadId, ownerId, INTEGRATION_SOURCE);
      db.exec('COMMIT');
      return reply.send({ code: 0, msg: 'ok', data: { id: leadId, duplicate: false } });
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original storage error is intentionally not exposed to an integration caller.
        }
      }
      if (error instanceof Error && /UNIQUE constraint failed.*leads\.phone/.test(error.message)) {
        return duplicateReply(reply);
      }
      return reply.code(500).send({ code: 1, msg: '线索接收失败', data: null });
    }
  });
}
