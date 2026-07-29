<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { get, post, patch } from '../../utils/request';

interface User { id: number; username: string; name: string; phone: string; role: string; is_active: number; }

const users = ref<User[]>([]);
const loading = ref(true);
const showAddForm = ref(false);
const submitting = ref(false);

const newUser = ref({ username: '', name: '', password: '', role: 'member', phone: '' });

onMounted(async () => {
  await loadUsers();
});

async function loadUsers() {
  loading.value = true;
  try {
    users.value = await get<User[]>('/api/users');
  } finally {
    loading.value = false;
  }
}

async function handleAddUser() {
  if (!newUser.value.username || !newUser.value.name || !newUser.value.password) {
    uni.showToast({ title: '请填写必填项', icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    await post('/api/users', newUser.value);
    uni.showToast({ title: '用户创建成功', icon: 'success' });
    showAddForm.value = false;
    newUser.value = { username: '', name: '', password: '', role: 'member', phone: '' };
    await loadUsers();
  } finally {
    submitting.value = false;
  }
}

async function toggleActive(user: User) {
  const action = user.is_active ? '停用' : '启用';
  uni.showModal({
    title: `${action}账号`,
    content: `确认${action}【${user.name}】的账号？`,
    success: async (res) => {
      if (!res.confirm) return;
      await patch(`/api/users/${user.id}`, { is_active: user.is_active ? 0 : 1 });
      uni.showToast({ title: `${action}成功`, icon: 'success' });
      await loadUsers();
    },
  });
}

async function resetPassword(user: User) {
  uni.showModal({
    title: '重置密码',
    editable: true,
    placeholderText: '请输入新密码',
    success: async (res) => {
      if (!res.confirm || !res.content) return;
      if (res.content.length < 6) {
        uni.showToast({ title: '密码至少6位', icon: 'none' });
        return;
      }
      await patch(`/api/users/${user.id}`, { password: res.content });
      uni.showToast({ title: '密码已重置', icon: 'success' });
    },
  });
}
</script>

<template>
  <view class="users-page">
    <view class="add-btn-wrap">
      <button class="add-btn" @click="showAddForm = true">+ 新增用户</button>
    </view>

    <view v-if="loading" class="loading-state"><text>加载中...</text></view>

    <view v-else class="user-list">
      <view v-for="u in users" :key="u.id" class="user-item">
        <view class="user-main">
          <text class="user-name">{{ u.name }}</text>
          <view class="user-badges">
            <view class="role-tag" :class="u.role">{{ u.role === 'admin' ? '管理员' : '业务员' }}</view>
            <view v-if="!u.is_active" class="status-tag disabled">已停用</view>
          </view>
        </view>
        <text class="user-username">@{{ u.username }}</text>
        <view class="user-actions">
          <text class="action-link" @click="toggleActive(u)">{{ u.is_active ? '停用' : '启用' }}</text>
          <text class="action-link" @click="resetPassword(u)">重置密码</text>
        </view>
      </view>
    </view>

    <!-- 新增用户弹层 -->
    <view v-if="showAddForm" class="popup-mask" @click.self="showAddForm = false">
      <view class="popup-sheet">
        <view class="popup-header">
          <text class="popup-title">新增用户</text>
          <text class="popup-close" @click="showAddForm = false">✕</text>
        </view>
        <view class="popup-body">
          <view class="pop-item">
            <text class="pop-label">用户名 *</text>
            <input class="pop-input" v-model="newUser.username" placeholder="登录账号" />
          </view>
          <view class="pop-item">
            <text class="pop-label">姓名 *</text>
            <input class="pop-input" v-model="newUser.name" placeholder="显示姓名" />
          </view>
          <view class="pop-item">
            <text class="pop-label">初始密码 *</text>
            <input class="pop-input" v-model="newUser.password" password placeholder="至少6位" />
          </view>
          <view class="pop-item">
            <text class="pop-label">角色</text>
            <view class="tag-row">
              <view class="pop-tag" :class="{ active: newUser.role === 'member' }" @click="newUser.role = 'member'">业务员</view>
              <view class="pop-tag" :class="{ active: newUser.role === 'admin' }" @click="newUser.role = 'admin'">管理员</view>
            </view>
          </view>
          <view class="pop-item">
            <text class="pop-label">手机（选填）</text>
            <input class="pop-input" v-model="newUser.phone" placeholder="可选" type="number" />
          </view>
        </view>
        <view class="popup-footer">
          <button class="pop-submit" :disabled="submitting" @click="handleAddUser">
            {{ submitting ? '创建中...' : '创建账号' }}
          </button>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.users-page { min-height: 100vh; background: #f5f7fa; }
.add-btn-wrap { padding: 12px; }
.add-btn { background: #2b6cb0; color: #fff; border-radius: 10px; font-size: 15px; font-weight: 600; height: 44px; border: none; }
.loading-state { text-align: center; padding: 40px; color: #718096; }
.user-list { padding: 0 12px; display: flex; flex-direction: column; gap: 8px; }
.user-item { background: #fff; border-radius: 10px; padding: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.user-main { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.user-name { font-size: 15px; font-weight: 700; color: #1a202c; }
.user-badges { display: flex; gap: 6px; }
.role-tag { padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #fff; background: #718096; }
.role-tag.admin { background: #6b46c1; }
.status-tag.disabled { background: #e2e8f0; color: #718096; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.user-username { font-size: 12px; color: #a0aec0; margin-bottom: 10px; display: block; }
.user-actions { display: flex; gap: 16px; }
.action-link { font-size: 13px; color: #2b6cb0; font-weight: 600; }

/* 弹层 */
.popup-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 300; display: flex; align-items: flex-end; }
.popup-sheet { background: #fff; border-radius: 16px 16px 0 0; width: 100%; }
.popup-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
.popup-title { font-size: 16px; font-weight: 700; }
.popup-close { font-size: 18px; color: #a0aec0; }
.popup-body { padding: 16px; }
.popup-footer { padding: 12px 16px; border-top: 1px solid #e2e8f0; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
.pop-item { margin-bottom: 14px; }
.pop-label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
.pop-input { width: 100%; height: 44px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0 12px; font-size: 14px; background: #f7fafc; box-sizing: border-box; }
.tag-row { display: flex; gap: 8px; }
.pop-tag { padding: 6px 16px; border: 1.5px solid #e2e8f0; border-radius: 20px; font-size: 13px; color: #4a5568; }
.pop-tag.active { background: #ebf4ff; border-color: #2b6cb0; color: #2b6cb0; font-weight: 600; }
.pop-submit { width: 100%; height: 50px; background: #2b6cb0; color: #fff; border-radius: 10px; font-size: 16px; font-weight: 600; border: none; }
.pop-submit[disabled] { opacity: 0.6; }
</style>
