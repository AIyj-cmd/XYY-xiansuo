<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post } from '../../utils/request';

type Binding = { status: 'unbound' | 'pending' | 'active' | 'disabled'; generation: number; expires_at: string | null };
const binding = ref<Binding>({ status: 'unbound', generation: 0, expires_at: null });
const code = ref(''); const expiresAt = ref(''); const loading = ref(false);
const labels: Record<Binding['status'], string> = { unbound: '未绑定', pending: '等待绑定', active: '已绑定', disabled: '已停用' };
async function load() { binding.value = await get<Binding>('/api/hermes-binding'); }
async function generate() {
  loading.value = true;
  try { const result = await post<{ code: string; expires_at: string }>('/api/hermes-binding/code'); code.value = result.code; expiresAt.value = result.expires_at; await load(); }
  finally { loading.value = false; }
}
onMounted(() => { void load(); });
</script>

<template>
  <view class="page">
    <view class="card">
      <text class="title">微信通知绑定</text>
      <text class="desc">将当前网站账号与您的微信一对一绑定。绑定码仅能使用一次，10 分钟内有效。</text>
      <view class="status"><text>当前状态</text><text class="value">{{ labels[binding.status] }}</text></view>
      <view v-if="binding.status === 'active'" class="status"><text>当前绑定代次</text><text class="value">{{ binding.generation }}</text></view>
      <button class="button" :disabled="loading || binding.status === 'disabled'" @click="generate">{{ loading ? '生成中…' : binding.status === 'active' ? '重新生成绑定码' : '生成绑定码' }}</button>
    </view>
    <view v-if="code" class="card code-card">
      <text class="label">请向 Hermes 微信账号发送以下完整内容</text>
      <text selectable class="code">绑定 {{ code }}</text>
      <text class="hint">有效至 {{ expiresAt }}。请勿转发给他人。</text>
    </view>
  </view>
</template>

<style scoped>
.page { min-height: 100vh; box-sizing: border-box; padding: 18px 14px; background: #f5f7fa; }
.card { background: #fff; border-radius: 12px; padding: 20px 18px; box-shadow: 0 1px 4px rgba(0,0,0,.06); margin-bottom: 14px; }
.title { display:block; font-size: 20px; font-weight:700; color:#1a202c; margin-bottom:12px; }.desc,.hint { display:block; color:#718096; font-size:14px; line-height:1.65; }.status { display:flex; justify-content:space-between; margin-top:16px; color:#4a5568; font-size:14px; }.value { color:#2b6cb0; font-weight:600; }.button { margin-top:22px; background:var(--p); color:#fff; border-radius:9px; font-size:16px; }.code-card { text-align:center; }.label { display:block; color:#4a5568; font-size:14px; }.code { display:block; overflow-wrap:anywhere; margin:16px 0; padding:14px 10px; border-radius:8px; background:#edf2f7; color:#1a202c; font-size:17px; font-weight:700; letter-spacing:.4px; }
</style>
