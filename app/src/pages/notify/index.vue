<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get } from '../../utils/request';
import { useUserStore } from '../../store/user';

interface NotificationItem {
  id: string;
  type: 'transfer' | 'overdue';
  lead_id: number;
  company_name: string | null;
  contact_name: string;
  occurred_at: string;
  from_name?: string | null;
  operator_name?: string | null;
  overdue_days?: number;
}

const store = useUserStore();
const list = ref<NotificationItem[]>([]);
const loading = ref(false);

onShow(async () => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  await loadList();
});

async function loadList() {
  loading.value = true;
  try {
    list.value = await get<NotificationItem[]>('/api/notifications');
    // 打开列表即视为已读，清空「我的」页面的未读角标
    if (list.value.length > 0) {
      uni.setStorageSync('notif_last_read_at', list.value[0].occurred_at);
    }
  } finally {
    loading.value = false;
  }
}

function goDetail(leadId: number) {
  uni.navigateTo({ url: `/pages/leads/detail?id=${leadId}` });
}

function relativeTime(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'));
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}天前`;
  return dateStr.slice(0, 10);
}
</script>

<template>
  <view class="notify-page">
    <view v-if="loading && list.length === 0" class="loading-state">
      <text>加载中...</text>
    </view>

    <view v-else-if="list.length === 0" class="empty-state">
      <text class="empty-icon">🔔</text>
      <text class="empty-text">还没有消息通知</text>
    </view>

    <view v-else class="notice-list">
      <view
        v-for="item in list"
        :key="item.id"
        class="notice-card"
        @click="goDetail(item.lead_id)"
      >
        <template v-if="item.type === 'transfer'">
          <view class="notice-icon">📥</view>
          <view class="notice-body">
            <text class="notice-title">
              {{ item.operator_name || '管理员' }} 把「{{ item.company_name || item.contact_name }}」转给了你
            </text>
            <text class="notice-sub" v-if="item.from_name">原负责人：{{ item.from_name }}</text>
            <text class="notice-time">{{ relativeTime(item.occurred_at) }}</text>
          </view>
        </template>
        <template v-else>
          <view class="notice-icon notice-icon--warn">⏰</view>
          <view class="notice-body">
            <text class="notice-title">
              「{{ item.company_name || item.contact_name }}」已逾期 {{ item.overdue_days }} 天未跟进
            </text>
            <text class="notice-sub">原定跟进日期：{{ item.occurred_at }}</text>
          </view>
        </template>
        <text class="chevron">›</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.notify-page { min-height: 100vh; background: #f5f7fa; }

.loading-state, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px;
  gap: 10px;
}
.loading-state text { font-size: 14px; color: #8d9aae; }
.empty-icon { font-size: 40px; }
.empty-text { font-size: 14px; color: #8d9aae; }

.notice-list { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }

.notice-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background: #fff;
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.05);
}
.notice-icon { font-size: 20px; flex-shrink: 0; }
.notice-icon--warn { filter: saturate(1.3); }
.notice-body { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.notice-title { font-size: 14px; font-weight: 600; color: #1a202c; line-height: 1.5; }
.notice-sub { font-size: 12px; color: #718096; }
.notice-time { font-size: 11px; color: #a0aec0; margin-top: 2px; }
.chevron { font-size: 18px; color: #d1d5db; flex-shrink: 0; }
</style>
