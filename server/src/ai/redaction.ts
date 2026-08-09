const control = /[\u0000-\u001f\u007f]/g;
const phone = /(?:(?:\+|00)?86[\s().-]*)?(?:1[3-9][\s().-]*)\d(?:[\s().-]*\d){8}/g;
const email = /(?<![\w.+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}(?![\w.-])/gi;
const wechat = /(?:微信(?:号)?\s*[:：]?\s*|wxid[_-]?)[A-Za-z][A-Za-z0-9_-]{5,}/gi;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const credentialAssignment = /\b(?:password|passwd|pwd|secret|token|api[ _-]?key|access[ _-]?key|私钥|密钥|密码|令牌|凭据)\b\s*(?:[:=：]|为)\s*["']?[^\s,;，；}"']{6,}/gi;
const commonKey = /\b(?:sk|rk|pk|api|xox[baprs]|ghp|github_pat)_[A-Za-z0-9_\-]{16,}\b/gi;
const highEntropy = /\b[A-Za-z0-9+/_=-]{32,}\b/g;

function looksHighEntropy(token: string): boolean {
  return ((/[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) && new Set(token).size >= 12) || /[+/_=-]/.test(token));
}

export function containsSensitiveText(value: unknown): boolean {
  const text = String(value ?? '');
  const patterns = [phone, email, wechat, jwt, credentialAssignment, commonKey];
  if (patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text); })) return true;
  highEntropy.lastIndex = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = highEntropy.exec(text))) if (looksHighEntropy(candidate[0])) return true;
  return false;
}

export function redactSensitiveText(value: unknown): string {
  return String(value ?? '').replace(control, ' ').replace(phone, '[已移除]').replace(email, '[已移除]').replace(wechat, '[已移除]').replace(jwt, '[已移除]').replace(credentialAssignment, '[已移除]').replace(commonKey, '[已移除]').replace(highEntropy, (token) => looksHighEntropy(token) ? '[已移除]' : token);
}
export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactUnknown(item)]));
  return value;
}
export function redactedText(value: unknown, max: number): string { return redactSensitiveText(value).replace(/\s+/g, ' ').trim().slice(0, max); }
/** Names are still business data, never a contact identifier; control text and long values are removed. */
export function displayName(company: unknown, contact: unknown): string { return redactedText(company || contact || '未命名线索', 40); }
