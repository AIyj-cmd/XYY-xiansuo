<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { get, post } from '../../utils/request';

interface Lead { id: number; company_name: string | null; contact_name: string; phone: string; source: string; owner_name: string | null; updated_at: string; }

const list = ref<Lead[]>([]);
const loading = ref(true);

onMounted(async () => {
  await load();
});

async function load() {
  loading.value = true;
  try {
    list.value = await get<Lead[]>('/api/trash');
  } finally {
    loading.value = false;
  }
}

async function restore(item: Lead) {
  uni.showModal({
    title: '恢复线索',
    content: `确认恢复【${item.company_name || item.contact_name}】？`,
    success: async (res) => {
      if (!res.confirm) return;
      await post(`/api/leads/${item.id}/restore`);
      uni.showToast({ title: '已恢复', icon: 'success' });
      await load();
    },
  });
}
</script>

<template>
  <view class="trash-page">
    <view v-if="loading" class="loading-state"><text>加载中...</text></view>
    <view v-else-if="list.length === 0" class="empty-state">
      <text class="empty-icon">🗑️</text>
      <text class="empty-text">回收站为空</text>
    </view>
    <view v-else class="trash-list">
      <view v-for="item in list" :key="item.id" class="trash-item">
        <view class="trash-info">
          <text class="trash-name">{{ item.company_name || item.contact_name }}</text>
          <text class="trash-sub">{{ item.contact_name }} · {{ item.phone }} · {{ item.source }}</text>
          <text class="trash-time">负责人：{{ item.owner_name || '-' }} · 删除于 {{ item.updated_at?.slice(0, 10) }}</text>
        </view>
        <view class="restore-btn" @click="restore(item)">恢复</view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.trash-page { min-height: 100vh; background: #f5f7fa; padding: 12px; }
.loading-state { text-align: center; padding: 40px; color: #718096; }
.empty-state { display: flex; flex-direction: column; align-items: center; padding: 80px 24px; gap: 12px; }
.empty-icon { font-size: 48px; }
.empty-text { font-size: 14px; color: #a0aec0; }
.trash-list { display: flex; flex-direction: column; gap: 8px; }
.trash-item { background: #fff; border-radius: 10px; padding: 14px; display: flex; align-items: center; gap: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.trash-info { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.trash-name { font-size: 15px; font-weight: 600; color: #1a202c; }
.trash-sub { font-size: 12px; color: #718096; }
.trash-time { font-size: 11px; color: #a0aec0; }
.restore-btn { padding: 8px 16px; background: #2f855a; border-radius: 8px; font-size: 13px; color: #fff; font-weight: 600; flex-shrink: 0; }
</style>
