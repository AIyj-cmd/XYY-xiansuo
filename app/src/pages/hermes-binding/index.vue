<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onUnload } from '@dcloudio/uni-app';
import { hermesBotEntry } from '../../config/hermes-bot-entry';
import { get, post, request } from '../../utils/request';

type Binding = { status: 'unbound' | 'pending' | 'active' | 'disabled'; generation: number; expires_at: string | null };
const binding = ref<Binding>({ status: 'unbound', generation: 0, expires_at: null });
const code = ref('');
const expiresAt = ref('');
const loading = ref(false);
const currentTime = ref(Date.now());
const bindingConfirmed = ref(false);
const labels: Record<Binding['status'], string> = { unbound: '未绑定', pending: '等待绑定', active: '已绑定', disabled: '已停用' };
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let trackingGeneration = 0;
let disposed = false;

const command = computed(() => code.value ? `绑定 ${code.value}` : '');
const expiresAtMs = computed(() => {
  if (!expiresAt.value) return 0;
  const normalized = expiresAt.value.replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
});
const isExpired = computed(() => Boolean(code.value) && (!Number.isFinite(expiresAtMs.value) || currentTime.value >= expiresAtMs.value));
const remainingTime = computed(() => {
  const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs.value - currentTime.value) / 1000));
  return `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`;
});
const generateLabel = computed(() => {
  if (loading.value) return '生成中…';
  if (code.value || binding.value.status === 'active') return '重新生成绑定码';
  return '生成绑定码';
});

function clearPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function clearCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

function stopTracking(): void {
  trackingGeneration += 1;
  clearCountdown();
  clearPolling();
}

function canTrack(generation: number): boolean {
  return !disposed && generation === trackingGeneration && !isExpired.value && !bindingConfirmed.value;
}

function updateTracking(generation: number): void {
  if (!canTrack(generation)) return;
  currentTime.value = Date.now();
  if (!canTrack(generation)) {
    stopTracking();
    return;
  }
  clearPolling();
  pollTimer = setTimeout(async () => {
    if (!canTrack(generation)) return;
    try {
      await load(true);
    } finally {
      // 请求本身无法中止时，仍不可在卸载、成功、过期或重开后重排轮询。
      updateTracking(generation);
    }
  }, 2_000);
}

function startTracking(): void {
  stopTracking();
  const generation = ++trackingGeneration;
  currentTime.value = Date.now();
  countdownTimer = setInterval(() => {
    if (!canTrack(generation)) return;
    currentTime.value = Date.now();
    if (isExpired.value) stopTracking();
  }, 1_000);
  updateTracking(generation);
}

async function load(silent = false): Promise<void> {
  try {
    binding.value = silent
      ? await request<Binding>('/api/hermes-binding', { showError: false })
      : await get<Binding>('/api/hermes-binding');
    // 发放重绑码时服务端会保留旧绑定的 active 状态，并同时保留本次码的
    // expires_at；只有 commit 清空 expires_at 后才代表本次两步式绑定完成。
    if (code.value && binding.value.status === 'active' && binding.value.expires_at === null) {
      bindingConfirmed.value = true;
      stopTracking();
    }
  } catch (error) {
    if (!silent) throw error;
  }
}

async function generate() {
  loading.value = true;
  try {
    const result = await post<{ code: string; expires_at: string }>('/api/hermes-binding/code');
    code.value = result.code;
    expiresAt.value = result.expires_at;
    bindingConfirmed.value = false;
    await load();
    startTracking();
  }
  finally { loading.value = false; }
}

function copyToClipboard(value: string, successMessage: string): void {
  uni.setClipboardData({
    data: value,
    success: () => uni.showToast({ title: successMessage, icon: 'success' }),
    fail: () => uni.showToast({ title: '复制失败，请手动复制', icon: 'none' }),
  });
}

function copyCommand(): void { copyToClipboard(command.value, '完整命令已复制'); }
function copyEntryUrl(): void { if (hermesBotEntry.url) copyToClipboard(hermesBotEntry.url, '入口链接已复制'); }

function disposeTracking(): void {
  disposed = true;
  stopTracking();
  // H5 浏览器后退会先触发 popstate；即使页面容器延迟回收，也立即停止轮询。
  window.removeEventListener('popstate', disposeTracking);
}

onMounted(() => {
  disposed = false;
  window.addEventListener('popstate', disposeTracking);
  void load();
});
onUnmounted(disposeTracking);
onUnload(disposeTracking);
</script>

<template>
  <view class="page">
    <view class="card">
      <text class="title">微信通知绑定</text>
      <text class="desc">将当前网站账号与您的微信一对一绑定。绑定码仅能使用一次，10 分钟内有效。</text>
      <view class="status"><text>当前状态</text><text class="value">{{ labels[binding.status] }}</text></view>
      <view v-if="binding.status === 'active'" class="status"><text>当前绑定代次</text><text class="value">{{ binding.generation }}</text></view>
      <button class="button" :disabled="loading || binding.status === 'disabled'" @click="generate">{{ generateLabel }}</button>
    </view>
    <view v-if="hermesBotEntry.url || hermesBotEntry.imageUrl" class="card entry-card">
      <text class="label">已验证的 Hermes 机器人入口</text>
      <image v-if="hermesBotEntry.imageUrl" class="entry-image" :src="hermesBotEntry.imageUrl" mode="aspectFit" />
      <button v-if="hermesBotEntry.url" class="link-button" @click="copyEntryUrl">复制机器人入口链接</button>
      <text class="hint">此入口仅用于添加长期机器人联系人，不是 Hermes/iLink 登录二维码。</text>
    </view>
    <view v-else class="card entry-card">
      <text class="label">机器人入口尚未配置</text>
      <text class="hint">请向管理员获取已验证的长期 Hermes 机器人联系人入口；本页不会生成或展示登录二维码。</text>
    </view>
    <view v-if="bindingConfirmed" class="card success-card">
      <text class="success-title">绑定成功</text>
      <text class="hint">当前微信已与此网站账号绑定，可关闭本页。</text>
    </view>
    <view v-else-if="code" class="card code-card">
      <text class="label">请向 Hermes 微信账号发送以下完整内容</text>
      <template v-if="!isExpired">
        <text data-testid="hermes-binding-command" selectable class="code">{{ command }}</text>
        <button class="copy-button" @click="copyCommand">复制完整命令</button>
        <text class="hint">剩余 {{ remainingTime }}，有效至 {{ expiresAt }}。请勿转发给他人。</text>
      </template>
      <template v-else>
        <text class="expired">绑定码已过期</text>
        <text class="hint">请重新生成绑定码后再发送。</text>
      </template>
    </view>
  </view>
</template>

<style scoped>
.page { min-height: 100vh; box-sizing: border-box; padding: 18px 14px; background: #f5f7fa; }
.card { background: #fff; border-radius: 12px; padding: 20px 18px; box-shadow: 0 1px 4px rgba(0,0,0,.06); margin-bottom: 14px; }
.title { display:block; font-size: 20px; font-weight:700; color:#1a202c; margin-bottom:12px; }.desc,.hint { display:block; color:#718096; font-size:14px; line-height:1.65; }.status { display:flex; justify-content:space-between; margin-top:16px; color:#4a5568; font-size:14px; }.value { color:#2b6cb0; font-weight:600; }.button { margin-top:22px; background:var(--p); color:#fff; border-radius:9px; font-size:16px; }.code-card,.entry-card,.success-card { text-align:center; }.label { display:block; color:#4a5568; font-size:14px; font-weight:600; }.code { display:block; overflow-wrap:anywhere; margin:16px 0 12px; padding:14px 10px; border-radius:8px; background:#edf2f7; color:#1a202c; font-size:17px; font-weight:700; letter-spacing:.4px; }.copy-button,.link-button { margin:0 0 12px; color:#2b6cb0; border:1px solid #2b6cb0; background:#fff; border-radius:8px; font-size:14px; }.entry-image { display:block; width:180px; height:180px; margin:16px auto 12px; background:#edf2f7; }.success-title { display:block; color:#2f855a; font-size:18px; font-weight:700; margin-bottom:8px; }.expired { display:block; color:#c53030; font-size:17px; font-weight:700; margin:16px 0 8px; }
</style>
