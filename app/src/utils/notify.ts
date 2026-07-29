// 跟进提醒推送：浏览器 Notification API（仅 H5）+ tabbar 角标

export async function requestNotifyPermission(): Promise<boolean> {
  // #ifdef H5
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
  // #endif
  return false;
}

export function sendFollowUpReminder(todayCount: number, overdueCount: number) {
  // tabbar 角标：有逾期或今日任务就显示红点
  // 这两个接口要求当前页面就是 tabBar 页面；工作台数据是异步拉回来的，
  // 如果用户在请求还没返回时就跳到了详情页等非 tabBar 页面，调用会失败——
  // 角标本来就是非关键提示，失败就跳过，不让它变成控制台里的未捕获异常
  const total = todayCount + overdueCount;
  const badgeAction = total > 0
    ? uni.setTabBarBadge({ index: 1, text: total > 99 ? '99+' : String(total) })
    : uni.removeTabBarBadge({ index: 1 });
  badgeAction?.catch?.(() => {});

  // #ifdef H5
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const parts: string[] = [];
  if (overdueCount > 0) parts.push(`逾期未跟进 ${overdueCount} 条`);
  if (todayCount > 0) parts.push(`今日待跟进 ${todayCount} 条`);
  if (parts.length === 0) return;

  // 避免同一会话重复弹
  const key = `notify_sent_${new Date().toLocaleDateString('sv-SE')}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');

  new Notification('线索跟进提醒', {
    body: parts.join('，'),
    icon: '/favicon.ico',
    tag: 'follow-up-reminder',
  });
  // #endif
}
