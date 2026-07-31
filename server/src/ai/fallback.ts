import type { DailyReportOutput, ScheduledFollowOutput } from './output-schemas.js';
import type { ContextItem } from './context-builder.js';
export function scheduledFallback(items: ContextItem[]): ScheduledFollowOutput { return { title: '到期跟进提醒', summary: `当前有 ${items.length} 条待关注线索，请按到期时间依次处理。`, items: items.map((item) => ({ item_ref: item.item_ref, reason: '已到跟进时间，建议优先确认当前进展。', suggested_focus: '结合最近沟通记录确认下一步安排。' })), closing: '请以实际客户沟通情况为准。' }; }
export function dailyFallback(metrics: Record<string, number>): DailyReportOutput { return { title: '每日工作摘要', summary: '以下统计由系统按当前权限范围生成。', highlights: [`今日新增 ${metrics.today_new_count} 条`, `今日已跟进 ${metrics.today_follow_up_count} 条`], actions: ['优先处理已到期线索。', '确认下一业务日待跟进安排。'], closing: '请以实际客户沟通情况为准。' }; }
