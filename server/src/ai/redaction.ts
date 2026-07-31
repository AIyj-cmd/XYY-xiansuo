const control = /[\u0000-\u001f\u007f]/g;
const phone = /(?:\+?86[- ]?)?1[3-9]\d{9}/g;
const wechat = /(?:微信(?:号)?\s*[:：]?\s*|wxid[_-]?)[A-Za-z][A-Za-z0-9_-]{5,}/gi;
export function redactedText(value: unknown, max: number): string {
  return String(value ?? '').replace(control, ' ').replace(phone, '[已移除]').replace(wechat, '[已移除]').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Names are still business data, never a contact identifier; control text and long values are removed. */
export function displayName(company: unknown, contact: unknown): string { return redactedText(company || contact || '未命名线索', 40); }
