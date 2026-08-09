<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { onUnload } from '@dcloudio/uni-app';
import { get, post, request } from '../../utils/request';

type Binding = { status: 'unbound' | 'pending' | 'active' | 'disabled' | 'rebind_required'; generation: number };
type Attempt = { id: string; status: 'waiting' | 'scanned' | 'awaiting_context' | 'active' | 'expired' | 'failed' | 'cancelled'; generation: number; expires_at: string; qr_data_url?: string; confirmation_command?: string; error_code?: string };
const binding = ref<Binding>({ status: 'unbound', generation: 0 });
const attempt = ref<Attempt | null>(null); const loading = ref(false); const now = ref(Date.now()); let timer: ReturnType<typeof setInterval> | null = null; let poll: ReturnType<typeof setTimeout> | null = null; let disposed = false;
const remaining = computed(() => { const raw = attempt.value?.expires_at; if (!raw) return '00:00'; const ms = Date.parse(`${raw.replace(' ', 'T')}+08:00`) - now.value; const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; });
const terminal = computed(() => !attempt.value || ['active','expired','failed','cancelled'].includes(attempt.value.status));
const label: Record<NonNullable<Attempt>['status'], string> = { waiting: '等待扫码', scanned: '已扫码，等待确认', awaiting_context: '请在新机器人会话发送确认命令', active: '绑定成功', expired: '二维码已过期', failed: '绑定失败', cancelled: '已取消' };
function clear(): void { if (timer) clearInterval(timer); if (poll) clearTimeout(poll); timer = null; poll = null; }
function track(): void { clear(); timer = setInterval(() => { now.value = Date.now(); if (remaining.value === '00:00') clear(); }, 1000); const again = async () => { if (disposed || !attempt.value || terminal.value) return; try { const latest = await request<Attempt>(`/api/hermes-binding/qr-attempts/${attempt.value.id}`, { showError: false }); attempt.value = latest; if (latest.status === 'active') binding.value.status = 'active'; } finally { if (!disposed && !terminal.value) poll = setTimeout(again, 2000); } }; poll = setTimeout(again, 2000); }
async function load(): Promise<void> { binding.value = await get<Binding>('/api/hermes-binding'); }
async function create(): Promise<void> { loading.value = true; try { attempt.value = await post<Attempt>('/api/hermes-binding/qr-attempts'); now.value = Date.now(); track(); } finally { loading.value = false; } }
async function cancel(): Promise<void> { if (!attempt.value) return; await request(`/api/hermes-binding/qr-attempts/${attempt.value.id}`, { method: 'DELETE' }); attempt.value = { ...attempt.value, status: 'cancelled', qr_data_url: undefined }; clear(); }
function copy(): void { if (!attempt.value?.confirmation_command) return; uni.setClipboardData({ data: attempt.value.confirmation_command, success: () => uni.showToast({ title: '确认命令已复制', icon: 'success' }), fail: () => uni.showToast({ title: '复制失败，请手动复制', icon: 'none' }) }); }
function dispose(): void { disposed = true; clear(); }
onMounted(async () => { disposed = false; await load(); }); onUnmounted(dispose); onUnload(dispose);
</script>

<template>
  <view class="page"><view class="card"><text class="title">微信通知绑定</text><text class="desc">每个网站账号使用独立 Hermes 机器人账号。二维码仅 5 分钟有效，不会自动刷新。</text><view class="status"><text>当前状态</text><text>{{ binding.status === 'active' ? '已绑定' : binding.status === 'rebind_required' ? '旧绑定需重新绑定' : binding.status === 'disabled' ? '已停用' : '未绑定' }}</text></view><button data-testid="hermes-qr-create" class="primary" :disabled="loading || binding.status === 'disabled' || (!!attempt && !terminal)" @click="create">{{ loading ? '生成中…' : '生成登录二维码' }}</button></view>
    <view v-if="attempt" class="card center"><text class="state">{{ label[attempt.status] }}</text><text class="hint">剩余 {{ remaining }}</text><image v-if="attempt.status === 'waiting' && attempt.qr_data_url" data-testid="hermes-qr-image" class="qr" :src="attempt.qr_data_url" mode="aspectFit" /><text v-else-if="attempt.status === 'waiting'" class="hint">二维码加载中，请保持本页打开。</text><template v-if="attempt.status === 'scanned' || attempt.status === 'awaiting_context'"><text class="hint">请在刚登录的新机器人会话发送以下一次性确认命令：</text><text data-testid="hermes-confirmation-command" selectable class="command">{{ attempt.confirmation_command || '确认命令加载中…' }}</text><button class="secondary" :disabled="!attempt.confirmation_command" @click="copy">复制确认命令</button></template><text v-if="attempt.status === 'active'" class="success">绑定成功。此机器人现在只用于当前网站账号。</text><text v-if="attempt.status === 'expired' || attempt.status === 'failed'" class="error">{{ attempt.status === 'expired' ? '请重新生成二维码。' : '请重新生成二维码或联系管理员。' }}</text><button v-if="!terminal" data-testid="hermes-qr-cancel" class="cancel" @click="cancel">取消本次绑定</button></view>
  </view>
</template>
<style scoped>
.page{min-height:100vh;padding:18px 14px;box-sizing:border-box;background:#f5f7fa}.card{padding:20px 18px;margin-bottom:14px;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06)}.title,.state{display:block;font-weight:700;font-size:20px;color:#1a202c}.desc,.hint{display:block;color:#718096;font-size:14px;line-height:1.65;margin-top:10px}.status{display:flex;justify-content:space-between;margin-top:16px;color:#4a5568}.primary{margin-top:22px;background:var(--p);color:#fff;border-radius:9px}.center{text-align:center}.qr{width:240px;height:240px;margin:18px auto;display:block;background:#fff}.command{display:block;margin:14px 0;padding:12px;background:#edf2f7;border-radius:8px;color:#1a202c;overflow-wrap:anywhere}.secondary,.cancel{margin-top:12px;border:1px solid #2b6cb0;background:#fff;color:#2b6cb0;border-radius:8px}.cancel{border-color:#c53030;color:#c53030}.success{display:block;color:#2f855a;margin-top:16px}.error{display:block;color:#c53030;margin-top:16px}
</style>
