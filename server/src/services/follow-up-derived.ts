import type { DatabaseSync } from 'node:sqlite';
import { nowDatetime } from '../utils/datetime.js';

/**
 * `leads.last_follow_at` 与 `leads.next_follow_at` 始终镜像最新跟进。
 * 最新的判定固定为 created_at DESC、id DESC；删除最后一条跟进时按方案 B 清空两者。
 */
export function recomputeFollowUpDerived(
  database: DatabaseSync,
  leadId: number,
  updatedAt = nowDatetime(),
): { followUpId: number | null; lastFollowAt: string | null; nextFollowAt: string | null } {
  const latest = database.prepare(`
    SELECT id, created_at, next_follow_at
    FROM follow_ups
    WHERE lead_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(leadId) as { id: number; created_at: string; next_follow_at: string | null } | undefined;

  database.prepare(`
    UPDATE leads
    SET last_follow_at = ?, next_follow_at = ?, next_follow_at_source = ?, updated_at = ?
    WHERE id = ?
  `).run(
    latest?.created_at ?? null,
    latest?.next_follow_at ?? null,
    latest ? 'follow_up' : null,
    updatedAt,
    leadId,
  );
  return {
    followUpId: latest?.id ?? null,
    lastFollowAt: latest?.created_at ?? null,
    nextFollowAt: latest?.next_follow_at ?? null,
  };
}
