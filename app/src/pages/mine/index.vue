<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get, post } from '../../utils/request';
import { downloadFile } from '../../utils/file';
import { useUserStore } from '../../store/user';
import { THEMES, applyTheme, getThemeId } from '../../utils/theme';
import CustomTabBar from '../../components/CustomTabBar.vue';

const store = useUserStore();
const activeTheme = ref(getThemeId());
const showChangePwd = ref(false);
const unreadNoticeCount = ref(0);

async function loadUnreadNoticeCount() {
  try {
    const list = await get<{ occurred_at: string }[]>('/api/notifications');
    const lastReadAt = uni.getStorageSync('notif_last_read_at') || '';
    unreadNoticeCount.value = list.filter(n => n.occurred_at > lastReadAt).length;
  } catch {
    // 未读数只是提示性信息，接口失败不影响页面其它功能
  }
}

onShow(() => {
  loadUnreadNoticeCount();
});

function selectTheme(id: string) {
  activeTheme.value = id;
  applyTheme(id);
}
const oldPwd = ref('');
const newPwd = ref('');
const newPwd2 = ref('');
const changing = ref(false);

onMounted(() => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
  }
});

async function handleChangePwd() {
  if (!oldPwd.value || !newPwd.value || !newPwd2.value) {
    uni.showToast({ title: '请填写所有密码', icon: 'none' });
    return;
  }
  if (newPwd.value !== newPwd2.value) {
    uni.showToast({ title: '两次新密码不一致', icon: 'none' });
    return;
  }
  if (newPwd.value.length < 6) {
    uni.showToast({ title: '新密码至少6位', icon: 'none' });
    return;
  }
  changing.value = true;
  try {
    await post('/api/auth/change-password', {
      old_password: oldPwd.value,
      new_password: newPwd.value,
    });
    uni.showToast({ title: '密码修改成功', icon: 'success' });
    showChangePwd.value = false;
    oldPwd.value = '';
    newPwd.value = '';
    newPwd2.value = '';
  } finally {
    changing.value = false;
  }
}

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

function handleLogout() {
  uni.showModal({
    title: '退出登录',
    content: '确认退出登录？',
    success: (res) => {
      if (res.confirm) {
        store.logout();
        uni.reLaunch({ url: '/pages/login/index' });
      }
    },
  });
}
</script>

<template>
  <view class="mine-page">
    <!-- 用户信息 -->
    <view class="user-card">
      <view class="user-avatar">
        <text>{{ store.userInfo?.name?.charAt(0) || '?' }}</text>
      </view>
      <view class="user-info">
        <text class="user-name">{{ store.userInfo?.name }}</text>
        <view class="user-role-tag">
          <text>{{ store.userInfo?.role === 'admin' ? '管理员' : '业务员' }}</text>
        </view>
      </view>
    </view>

    <!-- 主题切换 -->
    <view class="theme-section">
      <text class="section-label">主题颜色</text>
      <view class="theme-list">
        <view
          v-for="t in THEMES"
          :key="t.id"
          class="theme-item"
          @click="selectTheme(t.id)"
        >
          <view
            class="theme-dot"
            :class="{ 'theme-dot-active': activeTheme === t.id }"
            :style="{ background: t.primary }"
          >
            <text v-if="activeTheme === t.id" class="theme-check">✓</text>
          </view>
          <text class="theme-name">{{ t.name }}</text>
        </view>
      </view>
    </view>

    <!-- 功能菜单 -->
    <view class="menu-section">
      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/notify/index' })">
        <text class="menu-icon">🔔</text>
        <text class="menu-text">消息通知</text>
        <view v-if="unreadNoticeCount > 0" class="menu-badge">{{ unreadNoticeCount > 99 ? '99+' : unreadNoticeCount }}</view>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/memo/index' })">
        <text class="menu-icon">📝</text>
        <text class="menu-text">备忘录</text>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="uni.navigateTo({ url: '/pages/admin/trash' })">
        <text class="menu-icon">🗑️</text>
        <text class="menu-text">回收站</text>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="showChangePwd = true">
        <text class="menu-icon">🔐</text>
        <text class="menu-text">修改密码</text>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item" @click="handleExport">
        <text class="menu-icon">📤</text>
        <text class="menu-text">导出线索数据</text>
        <text class="menu-arrow">›</text>
      </view>

      <view v-if="store.isAdmin()" class="menu-item" @click="uni.navigateTo({ url: '/pages/admin/index' })">
        <text class="menu-icon">⚙️</text>
        <text class="menu-text">管理后台</text>
        <text class="menu-arrow">›</text>
      </view>

      <view class="menu-item danger" @click="handleLogout">
        <text class="menu-icon">🚪</text>
        <text class="menu-text">退出登录</text>
        <text class="menu-arrow">›</text>
      </view>
    </view>

    <!-- 修改密码弹层 -->
    <view v-if="showChangePwd" class="popup-mask" @click.self="showChangePwd = false">
      <view class="popup-sheet">
        <view class="popup-header">
          <text class="popup-title">修改密码</text>
          <text class="popup-close" @click="showChangePwd = false">✕</text>
        </view>
        <view class="popup-body">
          <view class="pop-item">
            <text class="pop-label">旧密码</text>
            <input class="pop-input" v-model="oldPwd" password placeholder="请输入旧密码" />
          </view>
          <view class="pop-item">
            <text class="pop-label">新密码</text>
            <input class="pop-input" v-model="newPwd" password placeholder="至少6位" />
          </view>
          <view class="pop-item">
            <text class="pop-label">确认新密码</text>
            <input class="pop-input" v-model="newPwd2" password placeholder="再次输入新密码" />
          </view>
        </view>
        <view class="popup-footer">
          <button class="pop-submit" :disabled="changing" @click="handleChangePwd">
            {{ changing ? '提交中...' : '确认修改' }}
          </button>
        </view>
      </view>
    </view>

    <CustomTabBar v-if="!showChangePwd" :current="3" />
  </view>
</template>

<style scoped>
.mine-page { min-height: 100vh; background: #f5f7fa; padding-bottom: var(--tabbar-safe-bottom); box-sizing: border-box; }

.user-card { background: linear-gradient(135deg, var(--pd), var(--p)); padding: 40px 24px 30px; display: flex; align-items: center; gap: 16px; }
.user-avatar { width: 64px; height: 64px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; color: #fff; flex-shrink: 0; }
.user-info { display: flex; flex-direction: column; gap: 6px; }
.user-name { font-size: 20px; font-weight: 700; color: #fff; }
.user-role-tag { display: inline-block; background: rgba(255,255,255,0.2); border-radius: 12px; padding: 2px 12px; }
.user-role-tag text { font-size: 12px; color: rgba(255,255,255,0.9); }

.menu-section { background: #fff; margin: 16px 12px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.menu-item { display: flex; align-items: center; gap: 12px; padding: 16px 16px; border-bottom: 1px solid #f0f4f8; }
.menu-item:last-child { border-bottom: none; }
.menu-item.danger .menu-text { color: #e53e3e; }
.menu-icon { font-size: 20px; }
.menu-text { flex: 1; font-size: 15px; color: #1a202c; }
.menu-arrow { font-size: 18px; color: #a0aec0; }
.menu-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 100px;
  background: #e53e3e;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 弹层 */
.popup-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 300; display: flex; align-items: flex-end; }
.popup-sheet { background: #fff; border-radius: 16px 16px 0 0; width: 100%; }
.popup-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
.popup-title { font-size: 16px; font-weight: 700; }
.popup-close { font-size: 18px; color: #a0aec0; padding: 4px; }
.popup-body { padding: 16px; }
.popup-footer { padding: 12px 16px; border-top: 1px solid #e2e8f0; padding-bottom: calc(12px + var(--tabbar-safe-bottom) + env(safe-area-inset-bottom)); }

.pop-item { margin-bottom: 16px; }
.pop-label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-bottom: 8px; }
.pop-input { width: 100%; height: 44px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0 12px; font-size: 14px; background: #f7fafc; box-sizing: border-box; }
.pop-submit { width: 100%; height: 50px; background: var(--p); color: #fff; border-radius: 10px; font-size: 16px; font-weight: 600; border: none; }
.pop-submit[disabled] { opacity: 0.6; }

/* 主题选择 */
.theme-section { background: #fff; margin: 12px 12px 0; border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.section-label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-bottom: 12px; }
.theme-list { display: flex; gap: 0; justify-content: space-around; }
.theme-item { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; }
.theme-dot { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: transform 0.15s; }
.theme-dot-active { transform: scale(1.1); box-shadow: 0 0 0 2.5px #fff, 0 0 0 4.5px rgba(0,0,0,0.22); }
.theme-check { font-size: 17px; color: #fff; font-weight: 700; line-height: 1; }
.theme-name { font-size: 11px; color: #718096; }
</style>
