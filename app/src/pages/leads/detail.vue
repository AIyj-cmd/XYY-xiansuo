<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get, post, patch, put, del as apiDel } from '../../utils/request';
import { makeCall, copyText } from '../../utils/call';
import { useUserStore } from '../../store/user';

const store = useUserStore();
const leadId = ref<number>(0);
const lead = ref<any>(null);
const followUps = ref<any[]>([]);
const loading = ref(true);
const showFollowForm = ref(false);
const submittingFollow = ref(false);
const auditLogs = ref<any[]>([]);
const showAuditLogs = ref(false);
const relatedLeads = ref<any[]>([]);

const STATUS_LIST = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const STATUS_COLORS: Record<string, string> = {
  '新线索': '#1a56db', '跟进中': '#dd6b20', '已报价': '#6b46c1',
  '已成交': '#2f855a', '已流失': '#718096', '暂搁置': '#a0aec0', '停止跟进': '#c05621',
};

const followForm = ref({
  type: '电话',
  content: '',
  result: '',
  amount: '',
  status: '跟进中',
  next_mode: 'none', // tomorrow / 3days / nextmonday / custom / none
  next_follow_at: '',
});
const uploadedImages = ref<string[]>([]);
const uploadingCount = ref(0);

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

function uploadOneImage(tempPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = uni.getStorageSync('token');
    uni.uploadFile({
      url: BASE_URL + '/api/upload/image',
      filePath: tempPath,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        try {
          const body = JSON.parse(res.data as string);
          if (body.code === 0 && body.data?.url) {
            resolve(body.data.url);
          } else {
            reject(new Error(body.msg || '上传失败'));
          }
        } catch {
          reject(new Error('上传失败'));
        }
      },
      fail() {
        reject(new Error('网络异常'));
      },
    });
  });
}

async function chooseImages() {
  const max = 9 - uploadedImages.value.length;
  if (max <= 0) {
    uni.showToast({ title: '最多上传9张图片', icon: 'none' });
    return;
  }
  uni.chooseImage({
    count: max,
    sizeType: ['compressed'],
    sourceType: ['album', 'camera'],
    success: async (res) => {
      const paths = res.tempFilePaths;
      uploadingCount.value += paths.length;
      const results = await Promise.allSettled(paths.map(p => uploadOneImage(p)));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          uploadedImages.value = [...uploadedImages.value, r.value];
        } else {
          uni.showToast({ title: r.reason?.message || '部分图片上传失败', icon: 'none' });
        }
      }
      uploadingCount.value = Math.max(0, uploadingCount.value - paths.length);
    },
  });
}

function removeImage(idx: number) {
  uploadedImages.value = uploadedImages.value.filter((_, i) => i !== idx);
}

function previewImage(url: string) {
  const urls = uploadedImages.value.length
    ? uploadedImages.value.map(u => (BASE_URL || '') + u)
    : [(BASE_URL || '') + url];
  uni.previewImage({ current: (BASE_URL || '') + url, urls });
}

function previewFollowImage(url: string, images: string[]) {
  const urls = images.map(u => (BASE_URL || '') + u);
  uni.previewImage({ current: (BASE_URL || '') + url, urls });
}

const FIELD_LABELS: Record<string, string> = {
  status: '状态', owner_id: '负责人', contact_name: '联系人', phone: '手机号',
  company_name: '公司名', source: '来源', source_note: '来源备注', intent_level: '意向',
  next_follow_at: '下次跟进', demand_note: '需求', wechat: '微信号', industry: '行业',
  lead_date: '线索日期', tags: '标签',
};

function auditDesc(log: any): string {
  if (log.action === 'create') return '创建了此线索';
  if (log.action === 'delete') {
    if (log.field === 'follow_up') return '删除了一条跟进记录';
    return '删除了此线索';
  }
  if (log.action === 'restore') return '恢复了此线索';
  if (log.action === 'transfer') {
    const from = log.old_val || '无';
    const to = log.new_val || '无';
    return `将负责人从「${from}」转给「${to}」`;
  }
  if (log.action === 'follow_up') {
    const type = log.field || '跟进';
    const preview = log.new_val?.length > 30 ? log.new_val.slice(0, 30) + '…' : (log.new_val || '');
    return `【${type}跟进】${preview}`;
  }
  if (log.action === 'update' && log.field === 'follow_up') {
    return '编辑了跟进记录';
  }
  const fieldLabel = FIELD_LABELS[log.field] || log.field;
  const oldVal = log.old_val || '空';
  const newVal = log.new_val || '空';
  if (log.field === 'tags') return `更新了标签：${oldVal} → ${newVal}`;
  return `将「${fieldLabel}」从「${oldVal}」改为「${newVal}」`;
}

function parseImages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function calcNextDate(mode: string): string {
  const d = new Date();
  if (mode === 'tomorrow') { d.setDate(d.getDate() + 1); }
  else if (mode === '3days') { d.setDate(d.getDate() + 3); }
  else if (mode === 'nextmonday') {
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? 1 : 8 - day));
  }
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

const totalAmount = computed(() => {
  return followUps.value
    .filter((f: any) => f.amount)
    .reduce((sum: number, f: any) => sum + Number(f.amount), 0);
});

const nextFollowDate = computed(() => {
  if (followForm.value.next_mode === 'none') return null;
  if (followForm.value.next_mode === 'custom') return followForm.value.next_follow_at || null;
  return calcNextDate(followForm.value.next_mode);
});

onMounted(async () => {
  store.init();
  const pages = getCurrentPages();
  const cur = pages[pages.length - 1] as any;
  const options = cur.$page?.options || cur.options || {};
  leadId.value = Number(options.id);
  await loadAll();
});

onShow(async () => {
  if (leadId.value) {
    await nextTick();
    await loadAll();
  }
});

async function loadAll() {
  loading.value = true;
  try {
    const [l, f, al, lt, rl] = await Promise.all([
      get<any>(`/api/leads/${leadId.value}`),
      get<any[]>(`/api/leads/${leadId.value}/follow-ups`),
      get<any[]>(`/api/leads/${leadId.value}/audit-logs`),
      get<any[]>(`/api/leads/${leadId.value}/tags`),
      get<any[]>(`/api/leads/${leadId.value}/related`),
    ]);
    lead.value = l;
    followUps.value = f;
    auditLogs.value = al;
    leadTags.value = lt;
    relatedLeads.value = rl;
    followForm.value.status = l.status;
  } finally {
    loading.value = false;
  }
}

function goEdit() {
  uni.navigateTo({ url: `/pages/leads/form?id=${leadId.value}` });
}

async function submitFollow() {
  if (!followForm.value.content.trim()) {
    uni.showToast({ title: '请填写跟进内容', icon: 'none' });
    return;
  }
  if (uploadingCount.value > 0) {
    uni.showToast({ title: '图片上传中，请稍候', icon: 'none' });
    return;
  }
  submittingFollow.value = true;
  try {
    await post(`/api/leads/${leadId.value}/follow-ups`, {
      type: followForm.value.type,
      content: followForm.value.content.trim(),
      result: followForm.value.result.trim() || undefined,
      status: followForm.value.status,
      next_follow_at: nextFollowDate.value || undefined,
      images: uploadedImages.value.length ? uploadedImages.value : undefined,
      amount: followForm.value.amount ? Number(followForm.value.amount) : undefined,
    });
    showFollowForm.value = false;
    followForm.value.content = '';
    followForm.value.result = '';
    followForm.value.amount = '';
    followForm.value.next_mode = 'none';
    uploadedImages.value = [];
    uni.showToast({ title: '跟进已记录', icon: 'success' });
    await loadAll();
  } finally {
    submittingFollow.value = false;
  }
}

// 编辑跟进
const showEditFollow = ref(false);
const editingFollow = ref<any>(null);
const editFollowForm = ref({ type: '电话', content: '', result: '', amount: '' });
const submittingEditFollow = ref(false);

function openEditFollow(f: any) {
  editingFollow.value = f;
  editFollowForm.value = {
    type: f.type || '电话',
    content: f.content || '',
    result: f.result || '',
    amount: f.amount ? String(f.amount) : '',
  };
  showEditFollow.value = true;
}

async function submitEditFollow() {
  if (!editFollowForm.value.content.trim()) {
    uni.showToast({ title: '请填写跟进内容', icon: 'none' });
    return;
  }
  submittingEditFollow.value = true;
  try {
    await patch(`/api/follow-ups/${editingFollow.value.id}`, {
      type: editFollowForm.value.type,
      content: editFollowForm.value.content.trim(),
      result: editFollowForm.value.result.trim() || undefined,
      amount: editFollowForm.value.amount ? Number(editFollowForm.value.amount) : null,
    });
    showEditFollow.value = false;
    uni.showToast({ title: '已更新', icon: 'success' });
    await loadAll();
  } finally {
    submittingEditFollow.value = false;
  }
}

function deleteFollow(f: any) {
  uni.showModal({
    title: '删除跟进记录',
    content: '确认删除这条跟进记录？',
    success: async (res) => {
      if (!res.confirm) return;
      await apiDel(`/api/follow-ups/${f.id}`);
      uni.showToast({ title: '已删除', icon: 'success' });
      await loadAll();
    },
  });
}

async function deleteLead() {
  uni.showModal({
    title: '确认删除',
    content: '删除后可在回收站恢复，确认删除吗？',
    success: async (res) => {
      if (!res.confirm) return;
      await apiDel(`/api/leads/${leadId.value}`);
      uni.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => uni.navigateBack(), 500);
    },
  });
}

function formatTime(s: string) {
  return s?.slice(0, 16) || '';
}

// 客户标签
const leadTags = ref<any[]>([]);
const allTags = ref<any[]>([]);
const showTagPanel = ref(false);
const newTagName = ref('');
const TAG_COLORS = ['#718096','#1a56db','#2f855a','#dd6b20','#6b46c1','#e53e3e','#d69e2e'];

async function openTagPanel() {
  const [tags, all] = await Promise.all([
    get<any[]>(`/api/leads/${leadId.value}/tags`),
    get<any[]>('/api/tags'),
  ]);
  leadTags.value = tags;
  allTags.value = all;
  showTagPanel.value = true;
}

function isTagSelected(tagId: number) {
  return leadTags.value.some((t: any) => t.id === tagId);
}

async function toggleTag(tag: any) {
  const ids = leadTags.value.map((t: any) => t.id);
  const idx = ids.indexOf(tag.id);
  if (idx >= 0) ids.splice(idx, 1);
  else ids.push(tag.id);
  await put(`/api/leads/${leadId.value}/tags`, { tag_ids: ids });
  leadTags.value = allTags.value.filter((t: any) => ids.includes(t.id));
  auditLogs.value = await get<any[]>(`/api/leads/${leadId.value}/audit-logs`);
}

async function createTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  const color = TAG_COLORS[allTags.value.length % TAG_COLORS.length];
  await post('/api/tags', { name, color });
  newTagName.value = '';
  allTags.value = await get<any[]>('/api/tags');
}

// 线索转移
const showTransfer = ref(false);
const transferUsers = ref<{ id: number; name: string }[]>([]);
const transferring = ref(false);

async function openTransfer() {
  if (transferUsers.value.length === 0) {
    const res = await get<any[]>('/api/users/members').catch(() => []);
    transferUsers.value = (res || []).filter((u: any) => u.id !== lead.value?.owner_id);
  }
  showTransfer.value = true;
}

async function doTransfer(userId: number, userName: string) {
  transferring.value = true;
  try {
    await patch(`/api/leads/${leadId.value}`, { owner_id: userId });
    uni.showToast({ title: `已转给 ${userName}`, icon: 'success' });
    showTransfer.value = false;
    await loadAll();
  } finally {
    transferring.value = false;
  }
}
</script>

<template>
  <view class="detail-page">
    <view v-if="loading" class="loading-state">
      <text>加载中...</text>
    </view>

    <template v-else-if="lead">
      <scroll-view class="detail-scroll" scroll-y>
        <!-- 基本信息卡 -->
        <view class="info-card">
          <view class="info-header">
            <view>
              <text class="info-name">{{ lead.company_name || lead.contact_name }}</text>
              <view class="status-tag" :style="{ background: STATUS_COLORS[lead.status] }">
                <text>{{ lead.status }}</text>
              </view>
            </view>
            <view class="header-actions">
              <view
                v-if="store.isAdmin() || lead.owner_id === store.userInfo?.id"
                class="edit-btn"
                @click="goEdit"
              >编辑</view>
              <view
                v-if="store.isAdmin() || lead.owner_id === store.userInfo?.id"
                class="delete-btn"
                @click="deleteLead"
              >删除</view>
            </view>
          </view>

          <view class="info-grid">
            <view class="info-item"><text class="info-key">联系人</text><text class="info-val">{{ lead.contact_name }}</text></view>
            <view v-if="lead.phone" class="info-item"><text class="info-key">手机号</text><text class="info-val">{{ lead.phone }}</text></view>
            <view v-if="lead.wechat" class="info-item"><text class="info-key">微信号</text><text class="info-val">{{ lead.wechat }}</text></view>
            <view v-if="lead.industry" class="info-item"><text class="info-key">行业</text><text class="info-val">{{ lead.industry }}</text></view>
            <view class="info-item"><text class="info-key">来源</text><text class="info-val">{{ lead.source }}</text></view>
            <view v-if="lead.source_note" class="info-item"><text class="info-key">来源细分</text><text class="info-val">{{ lead.source_note }}</text></view>
            <view class="info-item"><text class="info-key">意向</text><text class="info-val">{{ lead.intent_level }}</text></view>
            <view class="info-item"><text class="info-key">负责人</text><text class="info-val">{{ lead.owner_name }}</text></view>
            <view class="info-item"><text class="info-key">线索日期</text><text class="info-val">{{ lead.lead_date }}</text></view>
            <view v-if="lead.next_follow_at" class="info-item"><text class="info-key">下次跟进</text><text class="info-val">{{ lead.next_follow_at }}</text></view>
            <view v-if="lead.demand_note" class="info-item full"><text class="info-key">需求概况</text><text class="info-val">{{ lead.demand_note }}</text></view>
            <view v-if="totalAmount > 0" class="info-item"><text class="info-key">累计报价</text><text class="info-val amount-val">¥{{ totalAmount.toLocaleString() }}</text></view>
          </view>

          <!-- 标签 -->
          <view class="tag-row-display" v-if="leadTags.length > 0 || true">
            <view class="lead-tag-list">
              <view v-for="t in leadTags" :key="t.id" class="lead-tag-chip" :style="{ background: t.color }">
                <text>{{ t.name }}</text>
              </view>
              <view
                v-if="store.isAdmin() || lead.owner_id === store.userInfo?.id"
                class="lead-tag-add"
                @click="openTagPanel"
              >{{ leadTags.length ? '+ 管理' : '+ 添加标签' }}</view>
            </view>
          </view>

        </view>

        <!-- 同公司其他联系人 -->
        <view v-if="relatedLeads.length > 0" class="timeline-section">
          <text class="section-title">{{ lead.company_name }} 的其他联系人（{{ relatedLeads.length }}）</text>
          <view
            v-for="r in relatedLeads" :key="r.id"
            class="related-item"
            @click="uni.navigateTo({ url: `/pages/leads/detail?id=${r.id}` })"
          >
            <view class="related-info">
              <text class="related-name">{{ r.contact_name }}</text>
              <text class="related-phone">{{ r.phone }}</text>
            </view>
            <view class="related-right">
              <view class="status-tag" :style="{ background: STATUS_COLORS[r.status] || '#718096' }">
                <text>{{ r.status }}</text>
              </view>
              <text class="related-owner">{{ r.owner_name }}</text>
            </view>
          </view>
        </view>

        <!-- 跟进时间线 -->
        <view class="timeline-section">
          <text class="section-title">跟进记录</text>

          <view v-if="followUps.length === 0" class="empty-follow">
            <text>还没有跟进记录</text>
          </view>

          <view v-for="f in followUps" :key="f.id" class="follow-item">
            <view class="follow-dot"></view>
            <view class="follow-content-wrap">
              <view class="follow-meta">
                <text class="follow-user">{{ f.user_name }}</text>
                <text class="follow-time">{{ formatTime(f.created_at) }}</text>
                <view class="follow-type-tag">{{ f.type }}</view>
                <view v-if="store.isAdmin() || f.user_id === store.userInfo?.id" class="follow-actions">
                  <text class="follow-act-btn" @click="openEditFollow(f)">编辑</text>
                  <text class="follow-act-btn danger" @click="deleteFollow(f)">删除</text>
                </view>
              </view>
              <text class="follow-content">{{ f.content }}</text>
              <view v-if="f.result" class="follow-result">结果：{{ f.result }}</view>
              <view v-if="f.amount" class="follow-amount">报价：¥{{ Number(f.amount).toLocaleString() }}</view>
              <view v-if="f.next_follow_at" class="follow-next">约定下次：{{ f.next_follow_at }}</view>
              <view v-if="parseImages(f.images).length" class="follow-images">
                <image
                  v-for="(img, idx) in parseImages(f.images)"
                  :key="idx"
                  class="follow-img-thumb"
                  :src="(BASE_URL || '') + img"
                  mode="aspectFill"
                  @click="previewFollowImage(img, parseImages(f.images))"
                />
              </view>
            </view>
          </view>
        </view>
        <!-- 操作日志 -->
        <view class="timeline-section" style="margin-top:0;">
          <view class="audit-header" @click="showAuditLogs = !showAuditLogs">
            <text class="section-title" style="margin-bottom:0;">操作日志</text>
            <text class="audit-toggle">{{ showAuditLogs ? '收起 ▲' : '展开 ▼' }}</text>
          </view>
          <template v-if="showAuditLogs">
            <view v-if="auditLogs.length === 0" class="empty-follow"><text>暂无操作记录</text></view>
            <view v-for="log in auditLogs" :key="log.id" class="audit-item">
              <text class="audit-user">{{ log.user_name }}</text>
              <text class="audit-action">{{ auditDesc(log) }}</text>
              <text class="audit-time">{{ formatTime(log.created_at) }}</text>
            </view>
          </template>
        </view>
      </scroll-view>

      <!-- 底部操作条 -->
      <view class="action-bar">
        <view v-if="lead.phone" class="action-btn" @click="makeCall(lead.phone)">
          <text class="action-icon">📞</text>
          <text class="action-label">拨打</text>
        </view>
        <view v-if="lead.wechat" class="action-btn" @click="copyText(lead.wechat, '微信号已复制')">
          <text class="action-icon">💬</text>
          <text class="action-label">复制微信</text>
        </view>
        <view
          v-if="store.isAdmin() || lead.owner_id === store.userInfo?.id"
          class="action-btn"
          @click="showFollowForm = true"
        >
          <text class="action-icon">✏️</text>
          <text class="action-label">写跟进</text>
        </view>
        <view
          v-if="store.isAdmin() || lead.owner_id === store.userInfo?.id"
          class="action-btn"
          @click="openTransfer"
        >
          <text class="action-icon">👤</text>
          <text class="action-label">转移</text>
        </view>
      </view>

      <!-- 线索转移弹层 -->
      <view v-if="showTransfer" class="popup-mask" @click.self="showTransfer = false">
        <view class="popup-sheet">
          <view class="popup-header">
            <text class="popup-title">转移给</text>
            <text class="popup-close" @click="showTransfer = false">✕</text>
          </view>
          <scroll-view class="popup-body" scroll-y>
            <view class="popup-inner">
              <view v-if="transferUsers.length === 0" style="text-align:center;padding:24px;color:#a0aec0;font-size:14px;">没有其他可转移成员</view>
              <view
                v-for="u in transferUsers"
                :key="u.id"
                class="transfer-user-item"
                @click="doTransfer(u.id, u.name)"
              >
                <view class="transfer-avatar">{{ u.name.slice(0, 1) }}</view>
                <text class="transfer-name">{{ u.name }}</text>
                <text class="transfer-arrow">›</text>
              </view>
            </view>
          </scroll-view>
        </view>
      </view>

      <!-- 标签管理弹层 -->
      <view v-if="showTagPanel" class="popup-mask" @click.self="showTagPanel = false">
        <view class="popup-sheet">
          <view class="popup-header">
            <text class="popup-title">管理标签</text>
            <text class="popup-close" @click="showTagPanel = false">✕</text>
          </view>
          <scroll-view class="popup-body" scroll-y>
            <view class="popup-inner">
              <view class="tag-chip-grid">
                <view
                  v-for="t in allTags" :key="t.id"
                  class="tag-select-chip"
                  :style="isTagSelected(t.id) ? { background: t.color, color: '#fff', borderColor: t.color } : {}"
                  @click="toggleTag(t)"
                >{{ t.name }}</view>
              </view>
              <view class="new-tag-row">
                <input class="new-tag-input" v-model="newTagName" placeholder="新建标签名" />
                <view class="new-tag-btn" @click="createTag">创建</view>
              </view>
            </view>
          </scroll-view>
        </view>
      </view>

      <!-- 写跟进弹层 -->
      <view v-if="showFollowForm" class="popup-mask" @click.self="showFollowForm = false">
        <view class="popup-sheet">
          <view class="popup-header">
            <text class="popup-title">写跟进记录</text>
            <text class="popup-close" @click="showFollowForm = false">✕</text>
          </view>

          <scroll-view class="popup-body" scroll-y>
            <view class="popup-inner">
            <view class="pop-item">
              <text class="pop-label">跟进方式</text>
              <view class="tag-row">
                <view
                  v-for="t in ['电话','微信','拜访','其他']"
                  :key="t"
                  class="pop-tag"
                  :class="{ active: followForm.type === t }"
                  @click="followForm.type = t"
                >{{ t }}</view>
              </view>
            </view>

            <view class="pop-item">
              <text class="pop-label">跟进内容 *</text>
              <textarea
                class="pop-textarea"
                v-model="followForm.content"
                placeholder="本次跟进情况..."
                :auto-height="true"
                style="min-height: 80px;"
              />
            </view>

            <view class="pop-item">
              <text class="pop-label">本次结果（选填）</text>
              <input class="pop-input" v-model="followForm.result" placeholder="如：已报价，客户考虑中" />
            </view>

            <view class="pop-item">
              <text class="pop-label">报价金额（选填，元）</text>
              <input class="pop-input" v-model="followForm.amount" type="digit" placeholder="如：12800" />
            </view>

            <view class="pop-item">
              <text class="pop-label">更新状态</text>
              <view class="tag-row wrap">
                <view
                  v-for="s in STATUS_LIST"
                  :key="s"
                  class="pop-tag"
                  :class="{ active: followForm.status === s }"
                  @click="followForm.status = s"
                >{{ s }}</view>
              </view>
            </view>

            <view class="pop-item">
              <text class="pop-label">下次跟进</text>
              <view class="tag-row wrap">
                <view
                  v-for="m in [{ label: '明天', val: 'tomorrow' }, { label: '3天后', val: '3days' }, { label: '下周一', val: 'nextmonday' }, { label: '自定义', val: 'custom' }, { label: '不需要', val: 'none' }]"
                  :key="m.val"
                  class="pop-tag"
                  :class="{ active: followForm.next_mode === m.val }"
                  @click="followForm.next_mode = m.val"
                >{{ m.label }}</view>
              </view>
              <picker v-if="followForm.next_mode === 'custom'" mode="date" :value="followForm.next_follow_at" @change="(e: any) => followForm.next_follow_at = e.detail.value">
                <view class="picker-field mt-8">
                  <text>{{ followForm.next_follow_at || '选择日期' }}</text>
                  <text class="picker-arrow">▼</text>
                </view>
              </picker>
              <view v-if="nextFollowDate" class="next-date-tip">已设定：{{ nextFollowDate }}</view>
            </view>

            <view class="pop-item">
              <text class="pop-label">截图（选填，最多9张）</text>
              <view class="img-grid">
                <view
                  v-for="(url, i) in uploadedImages"
                  :key="i"
                  class="img-thumb-wrap"
                >
                  <image
                    class="img-thumb"
                    :src="(BASE_URL || '') + url"
                    mode="aspectFill"
                    @click="previewImage(url)"
                  />
                  <view class="img-remove" @click="removeImage(i)">✕</view>
                </view>
                <view
                  v-if="uploadedImages.length < 9"
                  class="img-add-btn"
                  @click="chooseImages"
                >
                  <text v-if="uploadingCount > 0" class="img-add-icon">⟳</text>
                  <text v-else class="img-add-icon">+</text>
                  <text class="img-add-text">{{ uploadingCount > 0 ? '上传中' : '添加截图' }}</text>
                </view>
              </view>
            </view>
            </view>
          </scroll-view>

          <view class="popup-footer">
            <button
              class="pop-submit"
              :disabled="submittingFollow"
              @click="submitFollow"
            >{{ submittingFollow ? '提交中...' : '提交跟进' }}</button>
          </view>
        </view>
      </view>

      <!-- 编辑跟进弹窗 -->
      <view v-if="showEditFollow" class="popup-mask" @click.self="showEditFollow = false">
        <view class="popup-sheet">
          <view class="popup-header">
            <text class="popup-title">编辑跟进记录</text>
            <text class="popup-close" @click="showEditFollow = false">✕</text>
          </view>

          <scroll-view class="popup-body" scroll-y>
            <view class="popup-inner">
              <view class="pop-item">
                <text class="pop-label">跟进方式</text>
                <view class="tag-row">
                  <view
                    v-for="t in ['电话','微信','拜访','其他']"
                    :key="t"
                    class="pop-tag"
                    :class="{ active: editFollowForm.type === t }"
                    @click="editFollowForm.type = t"
                  >{{ t }}</view>
                </view>
              </view>

              <view class="pop-item">
                <text class="pop-label">跟进内容 *</text>
                <textarea
                  class="pop-textarea"
                  v-model="editFollowForm.content"
                  placeholder="本次跟进情况..."
                  :auto-height="true"
                  style="min-height: 80px;"
                />
              </view>

              <view class="pop-item">
                <text class="pop-label">本次结果（选填）</text>
                <input class="pop-input" v-model="editFollowForm.result" placeholder="如：已报价，客户考虑中" />
              </view>

              <view class="pop-item">
                <text class="pop-label">报价金额（选填，元）</text>
                <input class="pop-input" v-model="editFollowForm.amount" type="digit" placeholder="如：12800" />
              </view>
            </view>
          </scroll-view>

          <view class="popup-footer">
            <button
              class="pop-submit"
              :disabled="submittingEditFollow"
              @click="submitEditFollow"
            >{{ submittingEditFollow ? '保存中...' : '保存修改' }}</button>
          </view>
        </view>
      </view>
    </template>
  </view>
</template>

<style scoped>
/* 100vh 在手机上不等于真正可见的视口高度（地址栏/工具条会占掉一截），
   100dvh 会跟着浏览器地址栏收起/展开动态变化，不支持的老浏览器自动忽略、退回 100vh */
.detail-page { display: flex; flex-direction: column; height: 100vh; height: 100dvh; background: #f0f4fa; }
.loading-state { display: flex; align-items: center; justify-content: center; height: 100vh; height: 100dvh; font-size: 14px; color: #718096; }
.detail-scroll { flex: 1; min-height: 0; overflow: hidden; padding-bottom: calc(96px + env(safe-area-inset-bottom)); box-sizing: border-box; }

.info-card { background: #fff; margin: 10px 12px; border-radius: 8px; padding: 14px; box-shadow: 0 1px 3px rgba(15,23,42,0.06); border: 1px solid #e8edf5; }
.info-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
.info-name { font-size: 16px; font-weight: 700; color: #0d1421; display: block; margin-bottom: 5px; }
.status-tag { display: inline-block; border-radius: 4px; padding: 2px 10px; font-size: 12px; color: #fff; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.edit-btn { padding: 5px 14px; border: 1.5px solid var(--p); border-radius: 6px; font-size: 12px; color: var(--p); font-weight: 600; }
.delete-btn { padding: 5px 14px; border: 1.5px solid #e53e3e; border-radius: 6px; font-size: 12px; color: #e53e3e; font-weight: 600; }

.info-grid { display: flex; flex-direction: column; gap: 8px; }
.info-item { display: flex; gap: 8px; }
.info-item.full { flex-direction: column; gap: 4px; }
.info-key { font-size: 12px; color: #718096; min-width: 60px; flex-shrink: 0; }
.info-val { font-size: 14px; color: #1a202c; flex: 1; }


.timeline-section { margin: 8px 12px; background: #fff; border-radius: 8px; padding: 14px; box-shadow: 0 1px 3px rgba(15,23,42,0.06); border: 1px solid #e8edf5; }
.section-title { font-size: 13px; font-weight: 700; color: #0d1421; margin-bottom: 12px; padding-left: 8px; border-left: 3px solid var(--p); line-height: 1; }
.empty-follow { text-align: center; padding: 24px; font-size: 14px; color: #a0aec0; }

.follow-item { display: flex; gap: 12px; margin-bottom: 20px; padding-left: 8px; }
.follow-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--p); flex-shrink: 0; margin-top: 4px; }
.follow-content-wrap { flex: 1; }
.follow-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.follow-user { font-size: 13px; font-weight: 600; color: #2d3748; }
.follow-time { font-size: 12px; color: #a0aec0; }
.follow-type-tag { background: var(--pl); border-radius: 4px; padding: 1px 8px; font-size: 11px; color: var(--p); }
.follow-actions { display: flex; gap: 8px; margin-left: auto; }
.follow-act-btn { font-size: 11px; color: var(--p); padding: 1px 8px; border: 1px solid var(--p); border-radius: 4px; }
.follow-act-btn.danger { color: #e53e3e; border-color: #e53e3e; }
.follow-content { font-size: 14px; color: #1a202c; line-height: 1.6; }
.follow-result { font-size: 12px; color: #dd6b20; margin-top: 4px; }
.follow-amount { font-size: 12px; color: #6b46c1; font-weight: 700; margin-top: 4px; }
.follow-next { font-size: 12px; color: #2f855a; margin-top: 4px; }
.amount-val { color: #6b46c1; font-weight: 700; }

.action-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; display: flex; gap: 10px; padding: 12px 16px; background: #fff; border-top: 1px solid #e2e8f0; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
.action-btn { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px 0; background: var(--p); border: 1.5px solid var(--p); border-radius: 10px; gap: 4px; box-shadow: 0 2px 8px var(--ps); }
.action-icon { font-size: 20px; }
.action-label { font-size: 12px; color: #fff; }

/* 弹层 */
.popup-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 300; display: flex; align-items: flex-end; }
.popup-sheet { background: #fff; border-radius: 16px 16px 0 0; width: 100%; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden; }
.popup-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
.popup-title { font-size: 16px; font-weight: 700; }
.popup-close { font-size: 18px; color: #a0aec0; padding: 4px; }
.popup-body { flex: 1; overflow-y: auto; overflow-x: hidden; }
.popup-inner { padding: 16px; box-sizing: border-box; width: 100%; }
.popup-footer { padding: 12px 16px; border-top: 1px solid #e2e8f0; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }

.pop-item { margin-bottom: 18px; }
.pop-label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-bottom: 8px; }
.tag-row { display: flex; gap: 8px; }
.tag-row.wrap { flex-wrap: wrap; }
.pop-tag { padding: 6px 14px; border: 1.5px solid #e2e8f0; border-radius: 20px; font-size: 13px; color: #4a5568; }
.pop-tag.active { background: var(--pl); border-color: var(--p); color: var(--p); font-weight: 600; }
.pop-textarea { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; font-size: 14px; background: #f7fafc; box-sizing: border-box; }
.pop-input { width: 100%; height: 44px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0 12px; font-size: 14px; background: #f7fafc; box-sizing: border-box; }
.picker-field { display: flex; justify-content: space-between; height: 44px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0 12px; background: #f7fafc; font-size: 14px; color: #1a202c; align-items: center; }
.picker-arrow { font-size: 11px; color: #a0aec0; }
.mt-8 { margin-top: 8px; }
.next-date-tip { font-size: 12px; color: #2f855a; margin-top: 6px; padding: 4px 10px; background: #f0fff4; border-radius: 6px; }
.pop-submit { width: 100%; height: 46px; background: var(--p); color: #fff; border-radius: 8px; font-size: 15px; font-weight: 600; border: none; }
.pop-submit[disabled] { opacity: 0.6; }

/* 同公司联系人 */
.related-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f0f4f8; }
.related-item:last-child { border-bottom: none; }
.related-info { display: flex; flex-direction: column; gap: 2px; }
.related-name { font-size: 14px; font-weight: 600; color: #1a202c; }
.related-phone { font-size: 12px; color: #718096; }
.related-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.related-owner { font-size: 11px; color: #a0aec0; }

/* 客户标签 */
.tag-row-display { margin-top: 12px; }
.lead-tag-list { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lead-tag-chip { border-radius: 12px; padding: 3px 10px; font-size: 12px; color: #fff; }
.lead-tag-add { border: 1.5px dashed #cbd5e0; border-radius: 12px; padding: 3px 10px; font-size: 12px; color: #718096; }
.tag-chip-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tag-select-chip { border: 1.5px solid #e2e8f0; border-radius: 20px; padding: 6px 14px; font-size: 13px; color: #4a5568; }
.new-tag-row { display: flex; gap: 10px; align-items: center; }
.new-tag-input { flex: 1; min-width: 0; height: 44px; border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 0 12px; font-size: 14px; color: #1a202c; background: #f7fafc; box-sizing: border-box; }
.new-tag-btn { padding: 0 16px; height: 44px; background: var(--p); border-radius: 8px; font-size: 14px; color: #fff; display: flex; align-items: center; flex-shrink: 0; }

/* 操作日志 */
.audit-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.audit-toggle { font-size: 12px; color: var(--p); }
.audit-item { padding: 8px 0; border-bottom: 1px solid #f0f4f8; display: flex; flex-direction: column; gap: 2px; }
.audit-item:last-child { border-bottom: none; }
.audit-user { font-size: 12px; font-weight: 600; color: #2d3748; }
.audit-action { font-size: 13px; color: #4a5568; }
.audit-time { font-size: 11px; color: #a0aec0; }

/* 线索转移 */
.transfer-user-item { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #f0f4f8; }
.transfer-user-item:last-child { border-bottom: none; }
.transfer-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--p); color: #fff; font-size: 15px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.transfer-name { flex: 1; font-size: 15px; color: #1a202c; }
.transfer-arrow { font-size: 20px; color: #a0aec0; }

/* 图片上传 */
.img-grid { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.img-thumb-wrap { position: relative; width: 80px; height: 80px; }
.img-thumb { width: 80px; height: 80px; border-radius: 8px; background: #e2e8f0; object-fit: cover; }
.img-remove { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; background: #e53e3e; color: #fff; font-size: 11px; display: flex; align-items: center; justify-content: center; z-index: 10; }
.img-add-btn { width: 80px; height: 80px; border: 1.5px dashed #cbd5e0; border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; background: #f7fafc; }
.img-add-icon { font-size: 22px; color: #a0aec0; }
.img-add-text { font-size: 11px; color: #a0aec0; }

/* 时间线图片 */
.follow-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.follow-img-thumb { width: 70px; height: 70px; border-radius: 6px; background: #e2e8f0; object-fit: cover; }
</style>
