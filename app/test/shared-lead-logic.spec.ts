import { expect, test } from '@playwright/test';
import {
  intentHeadColor,
  intentLabel,
  overdueDays,
  overdueTagClass,
  relativeTime,
  today,
} from '../src/utils/lead-display';
import { useLeadListState } from '../src/composables/useLeadListState';

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test.describe('线索展示共享逻辑', () => {
  test('日期与逾期展示保持统一边界', () => {
    const currentDate = today();

    expect(relativeTime(null)).toBe('');
    expect(relativeTime(`${currentDate} 12:00:00`)).toBe('今天');
    expect(relativeTime(shiftDate(currentDate, -1))).toBe('昨天');
    expect(relativeTime(shiftDate(currentDate, -6))).toBe('6天前');
    expect(relativeTime(shiftDate(currentDate, -14))).toBe('2周前');
    expect(relativeTime(shiftDate(currentDate, -60))).toBe('2月前');

    expect(overdueDays(currentDate)).toBe(0);
    expect(overdueDays(shiftDate(currentDate, -8))).toBe(8);
    expect(overdueTagClass(3)).toBe('overdue-warn');
    expect(overdueTagClass(4)).toBe('overdue-high');
    expect(overdueTagClass(8)).toBe('overdue-critical');
  });

  test('意向展示保持统一颜色与文案', () => {
    expect(intentHeadColor('高')).toBe('#E53E3E');
    expect(intentHeadColor('中')).toBe('#B7791F');
    expect(intentHeadColor('低')).toBe('#2F855A');
    expect(intentHeadColor('未知')).toBe('#eef1f5');
    expect(intentLabel('高')).toBe('高意向');
    expect(intentLabel('未知')).toBe('未知');
    expect(intentLabel('')).toBe('未知');
  });
});

test.describe('线索列表共享状态', () => {
  test('分页重置清空旧列表并恢复第一页', () => {
    const state = useLeadListState<{ id: number }>();
    state.page.value = 3;
    state.items.value = [{ id: 1 }, { id: 2 }];

    state.resetPagination();

    expect(state.page.value).toBe(1);
    expect(state.items.value).toEqual([]);
  });

  test('筛选重置仅清空筛选面板字段', () => {
    const state = useLeadListState();
    state.filterStatus.value = ['跟进中'];
    state.filterSource.value = '官网';
    state.filterIndustry.value = '制造业';
    state.filterIntent.value = '高';
    state.keyword.value = '保留搜索词';
    state.filterDate.value = '2026-08-01';
    state.sortMode.value = 'next_follow';

    state.resetFilters();

    expect(state.filterStatus.value).toEqual([]);
    expect(state.filterSource.value).toBe('');
    expect(state.filterIndustry.value).toBe('');
    expect(state.filterIntent.value).toBe('');
    expect(state.keyword.value).toBe('保留搜索词');
    expect(state.filterDate.value).toBe('2026-08-01');
    expect(state.sortMode.value).toBe('next_follow');
  });

  test('hasMore 随已载入数量和总数同步变化', () => {
    const state = useLeadListState<number>();
    state.total.value = 2;

    expect(state.hasMore.value).toBe(true);
    state.items.value.push(1);
    expect(state.hasMore.value).toBe(true);
    state.items.value.push(2);
    expect(state.hasMore.value).toBe(false);
    state.total.value = 3;
    expect(state.hasMore.value).toBe(true);
  });
});
