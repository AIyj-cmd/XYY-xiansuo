<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get, post, put, del } from '../../utils/request';
import { useUserStore } from '../../store/user';

interface Memo {
  id: number;
  content: string;
  created_at: string;
  updated_at: string;
}

const store = useUserStore();
const memos = ref<Memo[]>([]);
const loading = ref(false);

// 弹层状态
const showSheet = ref(false);
const editId = ref<number | null>(null);
const editContent = ref('');
const saving = ref(false);

onShow(async () => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  await loadMemos();
});

async function loadMemos() {
  loading.value = true;
  try {
    memos.value = await get<Memo[]>('/api/memos');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editId.value = null;
  editContent.value = '';
  showSheet.value = true;
}

function openEdit(m: Memo) {
  editId.value = m.id;
  editContent.value = m.content;
  showSheet.value = true;
}

function closeSheet() {
  showSheet.value = false;
  editContent.value = '';
  editId.value = null;
}

async function saveMemo() {
  const content = editContent.value.trim();
  if (!content) {
    uni.showToast({ title: '内容不能为空', icon: 'none' });
    return;
  }
  saving.value = true;
  try {
    if (editId.value) {
      const updated = await put<Memo>(`/api/memos/${editId.value}`, { content });
      const idx = memos.value.findIndex(m => m.id === editId.value);
      if (idx !== -1) memos.value[idx] = updated;
    } else {
      const created = await post<Memo>('/api/memos', { content });
      memos.value.unshift(created);
    }
    closeSheet();
    uni.showToast({ title: '已保存', icon: 'success', duration: 1200 });
  } finally {
    saving.value = false;
  }
}

function confirmDelete(id: number) {
  uni.showModal({
    title: '删除备忘',
    content: '确认删除这条备忘？',
    success: async (res) => {
      if (res.confirm) {
        await del(`/api/memos/${id}`);
        memos.value = memos.value.filter(m => m.id !== id);
        uni.showToast({ title: '已删除', icon: 'success', duration: 1000 });
      }
    },
  });
}

function formatTime(dt: string): string {
  const d = new Date(dt.replace(' ', 'T'));
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) {
    return `今天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  if (diffDays === 1) {
    return `昨天 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${mm}-${dd} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}
</script>

<template>
  <view class="memo-page">
    <!-- 顶部 -->
    <view class="header">
      <view class="back-btn" @click="uni.navigateBack()">
        <text class="back-icon">‹</text>
      </view>
      <text class="header-title">备忘录</text>
      <view class="add-btn" @click="openCreate">
        <text class="add-icon">＋</text>
      </view>
    </view>

    <!-- 列表 -->
    <scroll-view class="list-scroll" scroll-y>
      <view v-if="loading && memos.length === 0" class="loading-state">
        <text class="hint-text">加载中...</text>
      </view>

      <view v-else-if="memos.length === 0" class="empty-state">
        <text class="empty-icon">📝</text>
        <text class="empty-text">还没有备忘</text>
        <text class="empty-sub">点击右上角 ＋ 记录今天的想法</text>
      </view>

      <view v-else class="memo-list">
        <view
          v-for="m in memos"
          :key="m.id"
          class="memo-card"
          @click="openEdit(m)"
        >
          <view class="card-top">
            <text class="card-time">{{ formatTime(m.updated_at) }}</text>
            <view class="del-btn" @click.stop="confirmDelete(m.id)">
              <text class="del-icon">🗑</text>
            </view>
          </view>
          <text class="card-content">{{ m.content }}</text>
        </view>
      </view>

      <view style="height: 40px;"></view>
    </scroll-view>

    <!-- 编辑/新建底部弹层 -->
    <view v-if="showSheet" class="sheet-mask" @click.self="closeSheet">
      <view class="sheet">
        <view class="sheet-header">
          <text class="sheet-title">{{ editId ? '编辑备忘' : '新建备忘' }}</text>
          <text class="sheet-close" @click="closeSheet">✕</text>
        </view>
        <textarea
          class="sheet-textarea"
          v-model="editContent"
          placeholder="记录你的想法..."
          :maxlength="2000"
          auto-focus
        />
        <view class="sheet-footer">
          <text class="char-count">{{ editContent.length }} / 2000</text>
          <view class="footer-btns">
            <button class="btn-cancel" @click="closeSheet">取消</button>
            <button class="btn-save" :disabled="saving" @click="saveMemo">
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.memo-page { min-height: 100vh; background: #f5f7fa; display: flex; flex-direction: column; }

/* 头部 */
.header {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 0 4px 0 0;
  background: #fff;
  border-bottom: 1px solid #eef0f3;
  flex-shrink: 0;
}
.back-btn { width: 48px; height: 52px; display: flex; align-items: center; justify-content: center; }
.back-icon { font-size: 28px; color: #374151; line-height: 1; margin-top: -2px; }
.header-title { flex: 1; font-size: 17px; font-weight: 700; color: #111827; }
.add-btn { width: 48px; height: 52px; display: flex; align-items: center; justify-content: center; }
.add-icon { font-size: 22px; color: var(--p); line-height: 1; }

/* 列表区 */
.list-scroll { flex: 1; min-height: 0; overflow: hidden; }
.loading-state,
.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 80px 24px; gap: 10px; }
.empty-icon { font-size: 48px; }
.hint-text, .empty-text { font-size: 15px; color: #6b7280; }
.empty-sub { font-size: 13px; color: #9ca3af; margin-top: 4px; }

/* 卡片 */
.memo-list { padding: 12px 12px 0; display: flex; flex-direction: column; gap: 10px; }
.memo-card {
  background: #fff;
  border-radius: 12px;
  padding: 14px 14px 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.card-time { font-size: 12px; color: #9ca3af; }
.del-btn { padding: 2px 4px; }
.del-icon { font-size: 15px; }
.card-content { font-size: 15px; color: #1f2937; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }

/* 底部弹层 */
.sheet-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 200; display: flex; align-items: flex-end; }
.sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: calc(16px + env(safe-area-inset-bottom));
}
.sheet-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 12px; border-bottom: 1px solid #f3f4f6; }
.sheet-title { font-size: 16px; font-weight: 700; color: #111827; }
.sheet-close { font-size: 18px; color: #9ca3af; padding: 4px 6px; }
.sheet-textarea {
  display: block;
  width: 100%;
  min-height: 140px;
  max-height: 260px;
  padding: 14px 18px;
  font-size: 15px;
  color: #1f2937;
  line-height: 1.7;
  border: none;
  outline: none;
  resize: none;
  box-sizing: border-box;
  background: #fff;
}
.sheet-footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px 0; border-top: 1px solid #f3f4f6; }
.char-count { font-size: 12px; color: #9ca3af; }
.footer-btns { display: flex; gap: 10px; }
.btn-cancel {
  height: 40px;
  padding: 0 18px;
  background: #f3f4f6;
  color: #374151;
  border-radius: 8px;
  font-size: 14px;
  border: none;
  font-weight: 500;
}
.btn-save {
  height: 40px;
  padding: 0 22px;
  background: var(--p);
  color: #fff;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  border: none;
}
.btn-save[disabled] { opacity: 0.6; }
</style>
