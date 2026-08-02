import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { todayDate } from '../utils/datetime.js';

export interface LeadListQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: string;
  source?: string;
  owner_id?: number;
  industry?: string;
  intent?: string;
  tag_id?: number;
  sort?: 'last_follow' | 'lead_date' | 'next_follow' | 'created_new';
  order?: 'asc' | 'desc';
  date?: string;
  favorite_only?: string;
}

export function listLeads(db: DatabaseSync, query: LeadListQuery, requesterId: number) {
  const offset = (query.page - 1) * query.pageSize;
  const conditions: string[] = ['l.is_deleted = 0'];
  const params: SQLInputValue[] = [];
  if (query.keyword) {
    conditions.push('(l.company_name LIKE ? OR l.contact_name LIKE ? OR l.phone LIKE ?)');
    const keyword = `%${query.keyword}%`;
    params.push(keyword, keyword, keyword);
  }
  if (query.status) {
    const statuses = query.status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length) {
      conditions.push(`l.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (query.source) { conditions.push('l.source = ?'); params.push(query.source); }
  if (query.owner_id) { conditions.push('l.owner_id = ?'); params.push(query.owner_id); }
  if (query.industry) { conditions.push('l.industry = ?'); params.push(query.industry); }
  if (query.intent) { conditions.push('l.intent_level = ?'); params.push(query.intent); }
  if (query.tag_id) {
    conditions.push('EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id=l.id AND lt.tag_id=?)');
    params.push(query.tag_id);
  }
  if (query.date) { conditions.push('l.lead_date = ?'); params.push(query.date); }
  if (query.sort === 'created_new') { conditions.push('DATE(l.created_at) = ?'); params.push(todayDate()); }
  if (query.favorite_only === '1') {
    conditions.push('EXISTS (SELECT 1 FROM favorites f WHERE f.lead_id = l.id AND f.user_id = ?)');
    params.push(requesterId);
  }
  const sortMap: Record<string, string> = {
    last_follow: 'l.last_follow_at', lead_date: 'l.lead_date', next_follow: 'l.next_follow_at', created_new: 'l.created_at',
  };
  const where = conditions.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM leads l WHERE ${where}`).get(...params) as { cnt: number }).cnt;
  const list = db.prepare(`
    SELECT l.*, u.name AS owner_name,
      (SELECT content FROM follow_ups WHERE lead_id = l.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_follow_content,
      EXISTS(SELECT 1 FROM favorites f WHERE f.lead_id = l.id AND f.user_id = ?) AS is_favorited
    FROM leads l LEFT JOIN users u ON l.owner_id = u.id
    WHERE ${where}
    ORDER BY ${sortMap[query.sort || ''] || 'l.last_follow_at'} ${query.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST
    LIMIT ? OFFSET ?
  `).all(requesterId, ...params, query.pageSize, offset);
  return { total, page: query.page, pageSize: query.pageSize, list };
}

export function getLeadDetail(db: DatabaseSync, leadId: number, requesterId: number) {
  return db.prepare(`
    SELECT l.*, u.name AS owner_name, c.name AS creator_name,
      EXISTS(SELECT 1 FROM favorites f WHERE f.lead_id = l.id AND f.user_id = ?) AS is_favorited
    FROM leads l LEFT JOIN users u ON l.owner_id = u.id LEFT JOIN users c ON l.created_by = c.id
    WHERE l.id = ? AND l.is_deleted = 0
  `).get(requesterId, leadId);
}
