export function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const diffDays = Math.floor((new Date(today()).getTime() - new Date(dateStr.slice(0, 10)).getTime()) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`;
  return `${Math.floor(diffDays / 30)}月前`;
}

export function overdueDays(date: string): number {
  return Math.floor((new Date(today()).getTime() - new Date(date).getTime()) / 86400000);
}

export function overdueTagClass(days: number): string {
  if (days >= 8) return 'overdue-critical';
  if (days >= 4) return 'overdue-high';
  return 'overdue-warn';
}

export function intentHeadColor(level: string): string {
  return ({ '高': '#E53E3E', '中': '#B7791F', '低': '#2F855A' } as Record<string, string>)[level] || '#eef1f5';
}

export function intentLabel(level: string): string {
  return level && level !== '未知' ? `${level}意向` : '未知';
}
