import type { DatabaseSync } from 'node:sqlite';
import { captureOwnerChanged } from './notification.js';

export const OWNER_TRANSFER_SOURCES = ['single_edit', 'batch_transfer', 'pool_claim'] as const;
export type OwnerTransferSource = typeof OWNER_TRANSFER_SOURCES[number];

export class OwnerTransferError extends Error {
  constructor(
    public readonly kind: 'lead_not_found' | 'owner_invalid' | 'concurrent_change',
    message: string,
  ) {
    super(message);
  }
}

export function assertActiveOwner(database: DatabaseSync, ownerId: number): void {
  const user = database.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(ownerId);
  if (!user) throw new OwnerTransferError('owner_invalid', '负责人不存在或已停用');
}

export function transferLeadOwner(
  database: DatabaseSync,
  command: {
    leadId: number;
    newOwnerId: number;
    actorUserId: number;
    source: OwnerTransferSource;
    operationId: string;
    updatedAt: string;
  },
): { changed: boolean; oldOwnerId: number | null } {
  assertActiveOwner(database, command.newOwnerId);
  const lead = database.prepare(
    'SELECT id, owner_id FROM leads WHERE id = ? AND is_deleted = 0',
  ).get(command.leadId) as { id: number; owner_id: number | null } | undefined;
  if (!lead) throw new OwnerTransferError('lead_not_found', '线索不存在');
  if (lead.owner_id === command.newOwnerId) return { changed: false, oldOwnerId: lead.owner_id };

  const result = database.prepare(`
    UPDATE leads SET owner_id = ?, updated_at = ?
    WHERE id = ? AND owner_id IS ? AND is_deleted = 0
  `).run(command.newOwnerId, command.updatedAt, command.leadId, lead.owner_id);
  if (result.changes !== 1) {
    throw new OwnerTransferError('concurrent_change', '线索负责人刚刚发生变化，请刷新后重试');
  }
  database.prepare(`
    INSERT INTO audit_logs (lead_id, user_id, action, field, old_val, new_val, source, operation_id)
    VALUES (?, ?, 'transfer', 'owner_id', ?, ?, ?, ?)
  `).run(
    command.leadId,
    command.actorUserId,
    String(lead.owner_id ?? ''),
    String(command.newOwnerId),
    command.source,
    command.operationId,
  );
  if (command.source === 'single_edit' || command.source === 'batch_transfer') {
    captureOwnerChanged(database, {
      schemaVersion: 1, eventType: 'owner_changed', operationId: command.operationId,
      source: command.source, occurredAt: command.updatedAt, leadId: command.leadId,
      actorUserId: command.actorUserId, oldOwnerId: lead.owner_id, newOwnerId: command.newOwnerId,
    });
  }
  return { changed: true, oldOwnerId: lead.owner_id };
}
