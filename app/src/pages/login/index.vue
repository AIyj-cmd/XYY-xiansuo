<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useUserStore } from '../../store/user';

const store = useUserStore();
const username = ref('');
const password = ref('');
const submitting = ref(false);

onMounted(() => {
  store.init();
  if (store.isLoggedIn()) uni.reLaunch({ url: '/pages/desktop/index' });
});

async function submit() {
  if (!username.value.trim() || !password.value) {
    uni.showToast({ title: '请输入用户名和密码', icon: 'none' });
    return;
  }
  submitting.value = true;
  try {
    await store.login(username.value.trim(), password.value);
    uni.reLaunch({ url: '/pages/desktop/index' });
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="login-page">
    <view class="background-grid" />
    <view class="brand-side">
      <view class="brand-logo"><text>线</text></view>
      <text class="brand-title">线索与品牌管理系统</text>
      <text class="brand-subtitle">LEAD & BRAND MANAGEMENT</text>
      <view class="feature-list">
        <view class="feature"><text class="feature-icon">◎</text><view><text class="feature-name">完整线索跟进</text><text class="feature-copy">状态、负责人、跟进时间线、报价、标签和公海能力全部保留</text></view></view>
        <view class="feature"><text class="feature-icon">◇</text><view><text class="feature-name">品牌数据管理</text><text class="feature-copy">品牌、工商主体、分类、网址资源与线索建立多对多关系</text></view></view>
        <view class="feature"><text class="feature-icon">▤</text><view><text class="feature-name">持久化与审计</text><text class="feature-copy">SQLite WAL、外键检查、版本模式和操作记录共同兜底</text></view></view>
      </view>
      <text class="brand-foot">面向内部业务团队的桌面管理后台</text>
    </view>

    <view class="form-side">
      <view class="login-card">
        <text class="welcome">欢迎回来</text>
        <text class="welcome-copy">登录后进入桌面管理后台</text>
        <label class="form-item"><text class="label">用户名</text><view class="input-wrap"><text class="input-icon">♙</text><input v-model="username" class="input" placeholder="请输入用户名" confirm-type="next" /></view></label>
        <label class="form-item"><text class="label">密码</text><view class="input-wrap"><text class="input-icon">⌁</text><input v-model="password" class="input" password placeholder="请输入密码" confirm-type="done" @confirm="submit" /></view></label>
        <button class="login-btn" :disabled="submitting" :loading="submitting" @click="submit">{{ submitting ? '登录中...' : '登录系统' }}</button>
        <view class="security-note"><text class="shield">✓</text><text>登录凭据通过 HTTPS 与 Authorization Header 传输</text></view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.login-page{position:relative;width:100vw;height:100vh;height:100dvh;display:grid;grid-template-columns:minmax(480px,1.05fr) minmax(500px,.95fr);overflow:hidden;background:#f5f8fc}.background-grid{position:absolute;inset:0;opacity:.28;background-image:linear-gradient(rgba(148,163,184,.1) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.1) 1px,transparent 1px);background-size:34px 34px;pointer-events:none}.brand-side{position:relative;padding:8vh 8vw;display:flex;flex-direction:column;justify-content:center;color:#fff;background:radial-gradient(circle at 20% 15%,rgba(96,165,250,.65),transparent 32%),linear-gradient(145deg,#0f2f73,#1d4ed8 60%,#2563eb);overflow:hidden}.brand-side::after{content:'';position:absolute;width:420px;height:420px;right:-140px;bottom:-170px;border:70px solid rgba(255,255,255,.06);border-radius:50%}.brand-logo{width:54px;height:54px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.35);border-radius:17px;background:rgba(255,255,255,.16);backdrop-filter:blur(8px);font-size:22px;font-weight:800;box-shadow:0 14px 30px rgba(15,23,42,.18)}.brand-title{display:block;margin-top:25px;font-size:31px;font-weight:800;letter-spacing:.5px}.brand-subtitle{display:block;margin-top:7px;color:rgba(255,255,255,.66);font-size:10px;letter-spacing:3px}.feature-list{margin-top:58px;max-width:580px;display:flex;flex-direction:column;gap:28px}.feature{display:flex;gap:15px}.feature-icon{width:34px;height:34px;flex:0 0 34px;display:flex;align-items:center;justify-content:center;border-radius:11px;color:#dbeafe;background:rgba(255,255,255,.12);font-size:17px}.feature-name,.feature-copy{display:block}.feature-name{font-size:13px;font-weight:700}.feature-copy{margin-top:6px;color:rgba(255,255,255,.62);font-size:10px;line-height:1.65}.brand-foot{position:absolute;left:8vw;bottom:5vh;color:rgba(255,255,255,.48);font-size:9px}.form-side{position:relative;display:flex;align-items:center;justify-content:center;padding:40px}.login-card{width:420px;padding:42px 44px;background:rgba(255,255,255,.97);border:1px solid rgba(226,232,240,.9);border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.12)}.welcome,.welcome-copy{display:block}.welcome{font-size:27px;font-weight:800;color:#172033}.welcome-copy{margin-top:8px;margin-bottom:31px;color:#8a96a8;font-size:11px}.form-item{display:block;margin-bottom:19px}.label{display:block;margin-bottom:8px;color:#526078;font-size:11px;font-weight:700}.input-wrap{height:46px;display:flex;align-items:center;border:1px solid #dce4ef;border-radius:9px;background:#fafcff;transition:.15s ease}.input-wrap:focus-within{border-color:#8cb0f8;background:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.1)}.input-icon{width:42px;text-align:center;color:#94a3b8;font-size:16px}.input{flex:1;height:44px;padding-right:12px;font-size:12px}.login-btn{width:100%;height:47px;margin:10px 0 0;border-radius:9px;color:#fff;background:linear-gradient(90deg,#2563eb,#1d4ed8);font-size:13px;font-weight:700;line-height:47px;box-shadow:0 12px 25px rgba(37,99,235,.22)}.login-btn:active{transform:translateY(1px)}.security-note{margin-top:20px;display:flex;align-items:center;justify-content:center;gap:6px;color:#94a3b8;font-size:8px}.shield{width:15px;height:15px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:#16a34a;background:#eaf8ef;font-size:8px}@media(max-width:1000px){.login-page{grid-template-columns:1fr}.brand-side{display:none}.form-side{background:linear-gradient(145deg,#edf4ff,#f8fafc)}}
</style>
