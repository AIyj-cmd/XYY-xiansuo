<script setup lang="ts">
import { onMounted } from 'vue';
import { useUserStore } from '../../store/user';
import { downloadFile } from '../../utils/file';

const store = useUserStore();

onMounted(() => {
  store.init();
  if (!store.isAdmin()) {
    uni.showToast({ title: '无管理员权限', icon: 'none' });
    uni.navigateBack();
  }
});

async function handleExport() {
  // #ifdef H5
  uni.showToast({ title: '导出中...', icon: 'loading', mask: true });
  try {
    const today = new Date().toISOString().slice(0, 10);
    await downloadFile('/api/export', `leads_export_${today}.xlsx`);
    uni.hideToast();
    uni.showToast({ title: '导出成功', icon: 'success' });
  } catch {
    uni.hideToast();
    uni.showToast({ title: '导出失败，请重试', icon: 'none' });
  }
  // #endif
  // #ifndef H5
  uni.showToast({ title: '请在 H5 环境使用导出功能', icon: 'none' });
  // #endif
}
</script>

<template>
  <view class="admin-page">
    <view class="menu-section">
      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/admin/users' })">
        <text class="menu-icon">👥</text>
        <view class="menu-info">
          <text class="menu-title">用户管理</text>
          <text class="menu-desc">添加账号、停用启用、重置密码</text>
        </view>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/admin/import' })">
        <text class="menu-icon">📥</text>
        <view class="menu-info">
          <text class="menu-title">数据导入</text>
          <text class="menu-desc">从 Excel/CSV 导入历史线索</text>
        </view>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="handleExport">
        <text class="menu-icon">📤</text>
        <view class="menu-info">
          <text class="menu-title">数据导出</text>
          <text class="menu-desc">导出全量线索与跟进记录 xlsx</text>
        </view>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/admin/trash' })">
        <text class="menu-icon">🗑️</text>
        <view class="menu-info">
          <text class="menu-title">回收站</text>
          <text class="menu-desc">查看已删除线索，可恢复</text>
        </view>
        <text class="menu-arrow">›</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.admin-page { min-height: 100vh; background: #f5f7fa; padding-top: 12px; }
.menu-section { background: #fff; margin: 0 12px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.menu-item { display: flex; align-items: center; gap: 14px; padding: 16px; border-bottom: 1px solid #f0f4f8; }
.menu-item:last-child { border-bottom: none; }
.menu-icon { font-size: 24px; }
.menu-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.menu-title { font-size: 15px; font-weight: 600; color: #1a202c; }
.menu-desc { font-size: 12px; color: #718096; }
.menu-arrow { font-size: 18px; color: #a0aec0; }
</style>
