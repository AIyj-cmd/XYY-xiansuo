// 统一按 Asia/Shanghai 处理时间

export function nowDatetime(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');
}

export function todayDate(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}
