import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { displayName, redactedText } from './redaction.js';
import { recentFollowUps, type AiLead } from './permission-query.js';

export type ContextItem = { item_ref: string; lead_id: number; name: string; status: string; source: string; intent_level: string; demand: string; last_follow_at: string | null; next_follow_at: string | null; follow_ups: Array<{ type: string; content: string; result: string; next_follow_at: string | null; created_at: string }> };
export function buildLeadContext(db: DatabaseSync, leads: AiLead[], businessDate: string, maxContextChars = 12000, maxFollowUps = 3): { items: ContextItem[]; context: unknown; hash: string; chars: number } {
  const items: ContextItem[] = []; let chars = 0;
  for (const [index, lead] of leads.entries()) {
    const follow_ups = recentFollowUps(db, lead.id, businessDate, maxFollowUps).map((f) => ({ type: f.type, content: redactedText(f.content, 300), result: redactedText(f.result, 120), next_follow_at: f.next_follow_at, created_at: f.created_at }));
    const item: ContextItem = { item_ref: `L${index + 1}`, lead_id: lead.id, name: displayName(lead.company_name, lead.contact_name), status: lead.status, source: redactedText(lead.source, 30), intent_level: lead.intent_level, demand: redactedText(lead.demand_note, 200), last_follow_at: lead.last_follow_at, next_follow_at: lead.next_follow_at, follow_ups };
    let serialized = JSON.stringify(item);
    while (serialized.length > 1500 && item.follow_ups.length > 1) {
      item.follow_ups.pop();
      serialized = JSON.stringify(item);
    }
    if (serialized.length > 1500) continue;
    if (chars + serialized.length > maxContextChars) break;
    items.push(item); chars += serialized.length;
  }
  const context = { items: items.map(({ lead_id: _id, ...item }) => item) }; const canonical = JSON.stringify(context);
  return { items, context, hash: createHash('sha256').update(canonical).digest('hex'), chars };
}
