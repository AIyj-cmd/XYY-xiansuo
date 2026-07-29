<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { post } from '../../utils/request';
import { useUserStore } from '../../store/user';
import { prefetchTabPages } from '../../utils/prefetch';

const store = useUserStore();
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

onMounted(() => {
  store.init();
  if (store.isLoggedIn()) {
    prefetchTabPages();
    uni.reLaunch({ url: '/pages/leads/list' });
  }
});

async function handleLogin() {
  if (!username.value.trim()) { error.value = '请输入用户名'; return; }
  if (!password.value.trim()) { error.value = '请输入密码'; return; }
  error.value = '';
  loading.value = true;
  try {
    const data = await post<{ token: string; user: any }>('/api/auth/login', {
      username: username.value.trim(),
      password: password.value,
    });
    store.login(data.token, data.user);
    prefetchTabPages();
    uni.reLaunch({ url: '/pages/leads/list' });
  } catch (e: any) {
    error.value = e.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <view class="login-page">
    <!-- 品牌头部 -->
    <view class="brand-header">
      <image class="login-logo-img" src="/static/logo.png" mode="aspectFit" />
      <text class="login-sub">高效管理每一条销售线索</text>
    </view>

    <!-- 表单区域 -->
    <view class="form-area">
      <view class="login-card">
        <text class="card-title">账号登录</text>

        <view class="form-item">
          <text class="form-label">用户名</text>
          <input
            class="form-input"
            v-model="username"
            placeholder="请输入用户名"
            :disabled="loading"
            @confirm="handleLogin"
          />
        </view>

        <view class="form-item">
          <text class="form-label">密码</text>
          <input
            class="form-input"
            v-model="password"
            placeholder="请输入密码"
            password
            :disabled="loading"
            @confirm="handleLogin"
          />
        </view>

        <view v-if="error" class="error-tip">{{ error }}</view>

        <button
          class="login-btn"
          :disabled="loading"
          :loading="loading"
          @click="handleLogin"
        >
          {{ loading ? '登录中...' : '登 录' }}
        </button>
      </view>
    </view>
  </view>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  background: #f0f4fa;
  display: flex;
  flex-direction: column;
}

/* 品牌头部：蓝色短条 */
.brand-header {
  background: linear-gradient(135deg, var(--pd) 0%, var(--p) 100%);
  padding: 56px 24px 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.login-logo-img {
  width: 260px;
  height: 96px;
  margin-bottom: 14px;
}

.login-sub {
  font-size: 15px;
  color: rgba(255,255,255,0.75);
  letter-spacing: 1px;
}

/* 表单区：圆角顶部上拉，盖住蓝条底部 */
.form-area {
  flex: 1;
  background: #f0f4fa;
  border-radius: 20px 20px 0 0;
  margin-top: -20px;
  padding: 20px 20px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.login-card {
  background: #ffffff;
  border-radius: 12px;
  padding: 20px 20px 16px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 2px 12px rgba(15,23,42,0.08);
  box-sizing: border-box;
}

.card-title {
  display: block;
  font-size: 16px;
  font-weight: 700;
  color: #0d1421;
  margin-bottom: 20px;
}

.form-item {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  height: 44px;
  border: 1.5px solid #dde1e7;
  border-radius: 8px;
  padding: 0 12px;
  font-size: 14px;
  color: #0d1421;
  background: #f8fafd;
  box-sizing: border-box;
}

.form-input:focus {
  border-color: var(--p);
  background: #ffffff;
}

.error-tip {
  color: #d93025;
  font-size: 12px;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: #fce8e6;
  border-radius: 6px;
  border-left: 3px solid #d93025;
}

.login-btn {
  width: 100%;
  height: 46px;
  background: var(--p);
  color: #ffffff;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  border: none;
  margin-top: 10px;
  letter-spacing: 2px;
}

.login-btn:active {
  background: var(--pd);
}

.login-btn[disabled] {
  opacity: 0.6;
}
</style>
