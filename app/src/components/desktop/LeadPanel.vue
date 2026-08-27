<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { del, get, patch, post, put } from '../../utils/request';
import { useUserStore } from '../../store/user';

interface LeadRow {
  id: number;
  company_name: string | null;
  contact_name: string;
  phone: string | null;
  wechat: string | null;
  industry: string | null;
  source: string;
  source_note?: string | null;
  demand_note?: string | null;
  status: string;
  intent_level: string;
  owner_id: number | null;
  owner_name: string | null;
  lead_date: string;
  next_follow_at: string | null;
  last_follow_at: string | null;
  last_follow_content: string | null;
  is_favorited?: number | boolean;
  idle_days?: number;
}
interface UserOption { id: number; name: string; }
interface Tag { id: number; name: string; color: string; }
interface BrandLookup { id: number; name: string; }
interface CompanyLookup { id: number; name: string; }

const props = defineProps<{ scope: 'mine' | 'all' }>();
const store = useUserStore();
const loading = ref(false);
const submitting = ref(false);
const list = ref<LeadRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const users = ref<UserOption[]>([]);
const allTags = ref<Tag[]>([]);
const brandOptions = ref<BrandLookup[]>([]);
const companyOptions = ref<CompanyLookup[]>([]);
const selectedIds = ref<number[]>([]);
const viewMode = ref<'all' | 'public'>('all');
const poolDays = ref(7);
const poolMinimum = ref(7);
const poolDisabled = ref(false);

const STATUS_LIST = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const SOURCE_LIST = ['小红书', '抖音', '视频号', '知乎', '微信公众号', 'B站', '百度', '官网', '官网留言', '转介绍', '其他'];
const INDUSTRY_LIST = ['女装', '男装', '童装', '鞋类', '内衣', '美妆', '家居', '食品', '其他'];
const INTENT_LIST = ['高', '中', '低', '未知'];
const FOLLOW_TYPES = ['电话', '微信', '拜访', '其他'];

const filters = ref({ keyword: '', status: [] as string[], source: '', industry: '', intent: '', owner_id: '', date: '', sort: 'last_follow', favorite_only: false });
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const allSelected = computed(() => list.value.length > 0 && list.value.every((item) => selectedIds.value.includes(item.id)));
const selectedCount = computed(() => selectedIds.value.length);

const detail = ref<any>(null);
const followUps = ref<any[]>([]);
const auditLogs = ref<any[]>([]);
const leadTags = ref<Tag[]>([]);
const leadRelations = ref<{ brands: BrandLookup[]; companies: CompanyLookup[] }>({ brands: [], companies: [] });
const showDrawer = ref(false);
const showAudit = ref(false);
const canEditDetail = computed(() => !!detail.value && (store.isAdmin() || detail.value.owner_id === store.userInfo?.id));
const totalAmount = computed(() => followUps.value.reduce((sum, item) => sum + Number(item.amount || 0), 0));

const showLeadForm = ref(false);
const editingLeadId = ref<number | null>(null);
const leadForm = ref({
  contact_name: '', phone: '', wechat: '', company_name: '', industry: '', source: '', source_note: '', demand_note: '',
  intent_level: '未知', status: '新线索', owner_id: 0, lead_date: '', next_follow_at: '',
});

const showFollowForm = ref(false);
const followForm = ref({ type: '电话', content: '', result: '', amount: '', status: '跟进中', next_follow_at: '', images: [] as string[] });
const uploadingCount = ref(0);
const editingFollow = ref<any>(null);
const showEditFollow = ref(false);
const editFollowForm = ref({ type: '电话', content: '', result: '', amount: '', next_follow_at: '' });

const showRelationForm = ref(false);
const relationForm = ref({ brand_ids: [] as number[], company_ids: [] as number[], sync_company_name: false });
const showBatchPanel = ref(false);
const batchForm = ref({ action: 'status' as 'status' | 'transfer', status: '', owner_id: '' });
const newTagName = ref('');
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
function formatTime(value: string | null | undefined) { return value ? value.slice(0, 16) : '-'; }
function parseImages(raw: string | null | undefined): string[] { if (!raw) return []; try { return JSON.parse(raw); } catch { return []; } }
function isTerminal(status: string) { return ['已成交', '已流失', '停止跟进'].includes(status); }
function intentClass(intent: string) { return intent === '高' ? 'high' : intent === '中' ? 'medium' : intent === '低' ? 'low' : 'unknown'; }
function statusClass(status: string) { return status === '已成交' ? 'success' : status === '已流失' || status === '停止跟进' ? 'muted' : status === '已报价' ? 'quote' : status === '跟进中' ? 'progress' : 'new'; }
function relativeFollow(value: string | null) {
  if (!value) return '尚未跟进';
  const date = new Date(value.replace(' ', 'T'));
  const diff = Math.max(0, Date.now() - date.getTime());
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天跟进';
  if (days === 1) return '昨天跟进';
  return `${days} 天前跟进`;
}
function overdueDays(value: string | null) {
  if (!value) return 0;
  const current = new Date(`${today()}T00:00:00`).getTime();
  const target = new Date(`${value}T00:00:00`).getTime();
  return Math.max(0, Math.floor((current - target) / 86400000));
}

async function loadLookups() {
  const [members, tags, lookup] = await Promise.all([
    get<UserOption[]>('/api/users/members').catch(() => []),
    get<Tag[]>('/api/tags').catch(() => []),
    get<{ brands: BrandLookup[]; companies: CompanyLookup[] }>('/api/brand-domain/lookup', { keyword: '' }).catch(() => ({ brands: [], companies: [], leads: [] } as any)),
  ]);
  users.value = members || [];
  allTags.value = tags || [];
  brandOptions.value = lookup.brands || [];
  companyOptions.value = lookup.companies || [];
}

async function load(reset = false) {
  if (reset) page.value = 1;
  selectedIds.value = [];
  loading.value = true;
  try {
    if (props.scope === 'all' && viewMode.value === 'public') {
      try {
        const data = await get<{ minimum_days: number; threshold_days: number; total: number; list: LeadRow[] }>('/api/pool', { days: poolDays.value });
        poolDisabled.value = false;
        poolMinimum.value = data.minimum_days;
        poolDays.value = data.threshold_days;
        list.value = data.list;
        total.value = data.total;
      } catch {
        poolDisabled.value = true;
        list.value = [];
        total.value = 0;
      }
      return;
    }
    const data = await get<{ total: number; list: LeadRow[] }>('/api/leads', {
      page: page.value, pageSize,
      keyword: filters.value.keyword || undefined,
      status: filters.value.status.join(',') || undefined,
      source: filters.value.source || undefined,
      industry: filters.value.industry || undefined,
      intent: filters.value.intent || undefined,
      owner_id: props.scope === 'mine' ? store.userInfo?.id : filters.value.owner_id || undefined,
      date: filters.value.date || undefined,
      sort: filters.value.sort,
      favorite_only: filters.value.favorite_only ? '1' : undefined,
    });
    list.value = data.list;
    total.value = data.total;
  } finally { loading.value = false; }
}

function resetFilters() {
  filters.value = { keyword: '', status: [], source: '', industry: '', intent: '', owner_id: '', date: '', sort: 'last_follow', favorite_only: false };
  load(true);
}
function toggleStatusFilter(status: string) {
  const index = filters.value.status.indexOf(status);
  if (index >= 0) filters.value.status.splice(index, 1); else filters.value.status.push(status);
}
function goPage(next: number) { if (next < 1 || next > pageCount.value || next === page.value) return; page.value = next; load(); }
function setViewMode(mode: 'all' | 'public') { viewMode.value = mode; load(true); }
function setSearch(value: string) { filters.value.keyword = value; viewMode.value = 'all'; load(true); }

function toggleSelect(id: number) {
  const index = selectedIds.value.indexOf(id);
  if (index >= 0) selectedIds.value.splice(index, 1); else selectedIds.value.push(id);
}
function toggleSelectAll() { selectedIds.value = allSelected.value ? [] : list.value.map((item) => item.id); }

async function toggleFavorite(item: LeadRow) {
  const old = !!item.is_favorited;
  item.is_favorited = !old;
  try {
    if (old) await del(`/api/leads/${item.id}/favorite`); else await post(`/api/leads/${item.id}/favorite`);
    if (filters.value.favorite_only && old) await load();
  } catch { item.is_favorited = old; }
}

async function openLead(id: number) {
  loading.value = true;
  try {
    const [lead, follows, logs, tags, relations] = await Promise.all([
      get<any>(`/api/leads/${id}`), get<any[]>(`/api/leads/${id}/follow-ups`),
      get<any[]>(`/api/leads/${id}/audit-logs`), get<Tag[]>(`/api/leads/${id}/tags`),
      get<{ brands: BrandLookup[]; companies: CompanyLookup[] }>(`/api/leads/${id}/brand-relations`),
    ]);
    detail.value = lead;
    followUps.value = follows;
    auditLogs.value = logs;
    leadTags.value = tags;
    leadRelations.value = relations;
    showDrawer.value = true;
    showAudit.value = false;
  } finally { loading.value = false; }
}

function openCreate() {
  editingLeadId.value = null;
  leadForm.value = {
    contact_name: '', phone: '', wechat: '', company_name: '', industry: '', source: '', source_note: '', demand_note: '',
    intent_level: '未知', status: '新线索', owner_id: store.userInfo?.id || 0, lead_date: today(), next_follow_at: '',
  };
  showLeadForm.value = true;
}

function openEditLead() {
  if (!detail.value) return;
  editingLeadId.value = detail.value.id;
  leadForm.value = {
    contact_name: detail.value.contact_name || '', phone: detail.value.phone || '', wechat: detail.value.wechat || '',
    company_name: detail.value.company_name || '', industry: detail.value.industry || '', source: detail.value.source || '',
    source_note: detail.value.source_note || '', demand_note: detail.value.demand_note || '', intent_level: detail.value.intent_level || '未知',
    status: detail.value.status || '新线索', owner_id: detail.value.owner_id || store.userInfo?.id || 0,
    lead_date: detail.value.lead_date || today(), next_follow_at: detail.value.next_follow_at || '',
  };
  showLeadForm.value = true;
}

async function saveLead() {
  if (!leadForm.value.contact_name.trim()) { uni.showToast({ title: '请填写联系人', icon: 'none' }); return; }
  if (!leadForm.value.phone.trim() && !leadForm.value.wechat.trim()) { uni.showToast({ title: '手机号和微信号至少填写一项', icon: 'none' }); return; }
  if (!leadForm.value.source) { uni.showToast({ title: '请选择线索来源', icon: 'none' }); return; }
  if (leadForm.value.phone && !/^1\d{10}$/.test(leadForm.value.phone)) { uni.showToast({ title: '手机号格式错误', icon: 'none' }); return; }
  if (leadForm.value.phone) {
    const duplicate = await get<any>('/api/leads/check-phone', { phone: leadForm.value.phone, exclude_id: editingLeadId.value || undefined });
    if (duplicate) { uni.showToast({ title: `手机号已属于 ${duplicate.company_name || duplicate.contact_name}`, icon: 'none' }); return; }
  }
  const payload = {
    contact_name: leadForm.value.contact_name.trim(), phone: leadForm.value.phone.trim() || undefined,
    wechat: leadForm.value.wechat.trim() || undefined, company_name: leadForm.value.company_name.trim() || undefined,
    industry: leadForm.value.industry || undefined, source: leadForm.value.source,
    source_note: leadForm.value.source_note.trim() || undefined, demand_note: leadForm.value.demand_note.trim() || undefined,
    intent_level: leadForm.value.intent_level, status: leadForm.value.status, owner_id: Number(leadForm.value.owner_id),
    lead_date: leadForm.value.lead_date, next_follow_at: leadForm.value.next_follow_at || null,
  };
  submitting.value = true;
  try {
    if (editingLeadId.value) await patch(`/api/leads/${editingLeadId.value}`, payload);
    else await post('/api/leads', payload);
    uni.showToast({ title: editingLeadId.value ? '线索已更新' : '线索已创建', icon: 'success' });
    showLeadForm.value = false;
    await load();
    if (editingLeadId.value && showDrawer.value) await openLead(editingLeadId.value);
  } finally { submitting.value = false; }
}

function deleteLead() {
  if (!detail.value) return;
  uni.showModal({
    title: '删除线索', content: '删除后可从回收站恢复，确认继续？',
    success: async (result) => {
      if (!result.confirm) return;
      await del(`/api/leads/${detail.value.id}`);
      uni.showToast({ title: '线索已删除', icon: 'success' });
      showDrawer.value = false;
      await load();
    },
  });
}

function openFollow() {
  followForm.value = { type: '电话', content: '', result: '', amount: '', status: detail.value?.status || '跟进中', next_follow_at: '', images: [] };
  showFollowForm.value = true;
}

function uploadOneImage(tempPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = uni.getStorageSync('token');
    uni.uploadFile({
      url: `${BASE_URL}/api/upload/image`, filePath: tempPath, name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(result) {
        try {
          const body = JSON.parse(result.data as string);
          if (body.code === 0 && body.data?.url) resolve(body.data.url); else reject(new Error(body.msg || '上传失败'));
        } catch { reject(new Error('上传失败')); }
      }, fail: () => reject(new Error('上传失败')),
    });
  });
}

function chooseImages() {
  const count = 9 - followForm.value.images.length;
  if (count <= 0) { uni.showToast({ title: '最多上传9张图片', icon: 'none' }); return; }
  uni.chooseImage({
    count, sizeType: ['compressed'], sourceType: ['album', 'camera'],
    success: async (result) => {
      uploadingCount.value += result.tempFilePaths.length;
      const uploaded = await Promise.allSettled(result.tempFilePaths.map(uploadOneImage));
      for (const item of uploaded) if (item.status === 'fulfilled') followForm.value.images.push(item.value);
      uploadingCount.value = Math.max(0, uploadingCount.value - result.tempFilePaths.length);
    },
  });
}

function previewImages(current: string, images: string[]) {
  const urls = images.map((item) => `${BASE_URL}${item}`);
  uni.previewImage({ current: `${BASE_URL}${current}`, urls });
}

async function saveFollow() {
  if (!followForm.value.content.trim()) { uni.showToast({ title: '请填写跟进内容', icon: 'none' }); return; }
  if (uploadingCount.value) { uni.showToast({ title: '图片仍在上传', icon: 'none' }); return; }
  submitting.value = true;
  try {
    await post(`/api/leads/${detail.value.id}/follow-ups`, {
      type: followForm.value.type, content: followForm.value.content.trim(), result: followForm.value.result.trim() || undefined,
      amount: followForm.value.amount ? Number(followForm.value.amount) : undefined, status: followForm.value.status,
      next_follow_at: followForm.value.next_follow_at || undefined,
      images: followForm.value.images.length ? followForm.value.images : undefined,
    });
    showFollowForm.value = false;
    uni.showToast({ title: '跟进已记录', icon: 'success' });
    await openLead(detail.value.id);
    await load();
  } finally { submitting.value = false; }
}

function openEditFollow(item: any) {
  editingFollow.value = item;
  editFollowForm.value = { type: item.type || '电话', content: item.content || '', result: item.result || '', amount: item.amount ? String(item.amount) : '', next_follow_at: item.next_follow_at || '' };
  showEditFollow.value = true;
}

async function saveEditFollow() {
  if (!editFollowForm.value.content.trim()) { uni.showToast({ title: '请填写跟进内容', icon: 'none' }); return; }
  await patch(`/api/follow-ups/${editingFollow.value.id}`, {
    type: editFollowForm.value.type, content: editFollowForm.value.content.trim(), result: editFollowForm.value.result.trim() || undefined,
    amount: editFollowForm.value.amount ? Number(editFollowForm.value.amount) : null,
    next_follow_at: editFollowForm.value.next_follow_at || null,
  });
  showEditFollow.value = false;
  await openLead(detail.value.id);
  await load();
}

function deleteFollow(item: any) {
  uni.showModal({
    title: '删除跟进记录', content: '确认删除这条跟进记录？',
    success: async (result) => { if (!result.confirm) return; await del(`/api/follow-ups/${item.id}`); await openLead(detail.value.id); await load(); },
  });
}

async function toggleTag(tag: Tag) {
  if (!canEditDetail.value) return;
  const ids = leadTags.value.map((item) => item.id);
  const index = ids.indexOf(tag.id);
  if (index >= 0) ids.splice(index, 1); else ids.push(tag.id);
  await put(`/api/leads/${detail.value.id}/tags`, { tag_ids: ids });
  leadTags.value = allTags.value.filter((item) => ids.includes(item.id));
  auditLogs.value = await get<any[]>(`/api/leads/${detail.value.id}/audit-logs`);
}

async function createTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  await post('/api/tags', { name });
  newTagName.value = '';
  allTags.value = await get<Tag[]>('/api/tags');
}

function openRelations() {
  relationForm.value = {
    brand_ids: leadRelations.value.brands.map((item) => item.id),
    company_ids: leadRelations.value.companies.map((item) => item.id),
    sync_company_name: false,
  };
  showRelationForm.value = true;
}
function toggleRelation(kind: 'brand_ids' | 'company_ids', id: number) {
  const values = relationForm.value[kind];
  const index = values.indexOf(id);
  if (index >= 0) values.splice(index, 1); else values.push(id);
}
async function saveRelations() {
  await put(`/api/leads/${detail.value.id}/brand-relations`, relationForm.value);
  showRelationForm.value = false;
  await openLead(detail.value.id);
}

function openBatch(action: 'status' | 'transfer') {
  if (!selectedIds.value.length) { uni.showToast({ title: '请先选择线索', icon: 'none' }); return; }
  batchForm.value = { action, status: '', owner_id: '' };
  showBatchPanel.value = true;
}
async function submitBatch() {
  if (batchForm.value.action === 'status' && !batchForm.value.status) { uni.showToast({ title: '请选择状态', icon: 'none' }); return; }
  if (batchForm.value.action === 'transfer' && !batchForm.value.owner_id) { uni.showToast({ title: '请选择负责人', icon: 'none' }); return; }
  await post('/api/leads/batch', {
    ids: selectedIds.value, action: batchForm.value.action,
    status: batchForm.value.action === 'status' ? batchForm.value.status : undefined,
    owner_id: batchForm.value.action === 'transfer' ? Number(batchForm.value.owner_id) : undefined,
  });
  showBatchPanel.value = false;
  uni.showToast({ title: `已更新 ${selectedIds.value.length} 条`, icon: 'success' });
  await load();
}

async function claim(item: LeadRow) {
  await post(`/api/pool/${item.id}/claim`);
  uni.showToast({ title: '认领成功', icon: 'success' });
  await load();
}

function callPhone(phone: string) { uni.makePhoneCall({ phoneNumber: phone }); }
function copyWechat(wechat: string) { uni.setClipboardData({ data: wechat }); }
function auditDescription(log: any) {
  const labels: Record<string, string> = { status: '状态', owner_id: '负责人', contact_name: '联系人', phone: '手机号', company_name: '公司/品牌名', source: '来源', source_note: '来源细分', intent_level: '意向', next_follow_at: '下次跟进', demand_note: '需求', wechat: '微信号', industry: '行业', lead_date: '线索日期', tags: '标签' };
  if (log.action === 'create') return '创建了此线索';
  if (log.action === 'delete') return log.field === 'follow_up' ? '删除了一条跟进记录' : '删除了此线索';
  if (log.action === 'restore') return '恢复了此线索';
  if (log.action === 'transfer') return `将负责人从「${log.old_val || '无'}」转给「${log.new_val || '无'}」`;
  if (log.action === 'follow_up') return `记录了${log.field || ''}跟进：${log.new_val || ''}`;
  if (log.field === 'follow_up') return '编辑了跟进记录';
  return `将「${labels[log.field] || log.field}」从「${log.old_val || '空'}」改为「${log.new_val || '空'}」`;
}

watch(() => props.scope, () => { viewMode.value = 'all'; load(true); });
onMounted(async () => { await loadLookups(); await load(true); });
defineExpose({ openCreate, setSearch, openLead, refresh: load });
</script>

<template>
  <view class="lead-panel">
    <view v-if="scope==='all'" class="mode-tabs"><text class="mode-tab" :class="{active:viewMode==='all'}" @click="setViewMode('all')">全部线索</text><text class="mode-tab" :class="{active:viewMode==='public'}" @click="setViewMode('public')">公海待认领</text></view>

    <view v-if="viewMode==='all'" class="filter-card">
      <view class="filter-row top"><view class="search-wrap"><input v-model="filters.keyword" class="field" placeholder="搜索公司、联系人或手机号" confirm-type="search" @confirm="load(true)" /></view><view class="quick-status"><text v-for="status in STATUS_LIST" :key="status" class="status-filter" :class="{active:filters.status.includes(status)}" @click="toggleStatusFilter(status)">{{ status }}</text></view><button class="filter-btn" @click="load(true)">查询</button><button class="filter-btn ghost" @click="resetFilters">重置</button></view>
      <view class="filter-row bottom"><picker :range="['全部来源',...SOURCE_LIST]" @change="(e:any)=>filters.source=e.detail.value===0?'':SOURCE_LIST[e.detail.value-1]"><view class="select-field">来源：{{ filters.source||'全部' }} ⌄</view></picker><picker :range="['全部行业',...INDUSTRY_LIST]" @change="(e:any)=>filters.industry=e.detail.value===0?'':INDUSTRY_LIST[e.detail.value-1]"><view class="select-field">行业：{{ filters.industry||'全部' }} ⌄</view></picker><picker :range="['全部意向',...INTENT_LIST]" @change="(e:any)=>filters.intent=e.detail.value===0?'':INTENT_LIST[e.detail.value-1]"><view class="select-field">意向：{{ filters.intent||'全部' }} ⌄</view></picker><picker v-if="scope==='all'" :range="['全部负责人',...users.map(u=>u.name)]" @change="(e:any)=>filters.owner_id=e.detail.value===0?'':String(users[e.detail.value-1]?.id||'')"><view class="select-field">负责人：{{ users.find(u=>String(u.id)===filters.owner_id)?.name||'全部' }} ⌄</view></picker><input v-model="filters.date" class="select-field date-field" placeholder="线索日期 YYYY-MM-DD" /><picker :range="['最近跟进','下次跟进','今日新增']" @change="(e:any)=>filters.sort=['last_follow','next_follow','created_new'][e.detail.value]"><view class="select-field">排序：{{ filters.sort==='next_follow'?'下次跟进':filters.sort==='created_new'?'今日新增':'最近跟进' }} ⌄</view></picker><text class="favorite-toggle" :class="{active:filters.favorite_only}" @click="filters.favorite_only=!filters.favorite_only;load(true)">★ 只看收藏</text></view>
    </view>

    <view v-else class="pool-banner"><view><text class="pool-title">公海待认领</text><text class="pool-copy">超过阈值未跟进且未终结的线索。服务端开关关闭时，这里不会自作主张绕过。</text></view><view v-if="!poolDisabled" class="pool-options"><text v-for="days in [poolMinimum,15,30]" :key="days" class="pool-day" :class="{active:poolDays===days}" @click="poolDays=days;load(true)">{{ days }} 天</text></view><text v-else class="disabled-note">公海功能当前已关闭</text></view>

    <view class="table-card">
      <view class="table-head"><view><text class="card-title">{{ scope==='mine'?'我的线索':'线索池' }}</text><text class="card-sub">{{ viewMode==='public'?'满足公海条件的线索':`共 ${total} 条` }}</text></view><view class="table-tools"><template v-if="selectedCount"><text class="selected-count">已选 {{ selectedCount }} 条</text><button class="small-btn" @click="openBatch('status')">批量改状态</button><button class="small-btn" @click="openBatch('transfer')">批量转负责人</button></template><button class="small-btn primary" @click="openCreate">＋ 新增线索</button></view></view>
      <scroll-view class="table-scroll" scroll-x><view class="data-table"><view class="tr th"><view class="td check"><view class="checkbox" :class="{checked:allSelected}" @click="toggleSelectAll">{{ allSelected?'✓':'' }}</view></view><text class="td name">公司 / 品牌</text><text class="td contact">联系人</text><text class="td source">来源</text><text class="td intent">意向</text><text class="td status">状态</text><text class="td owner">负责人</text><text class="td follow">最近跟进</text><text class="td next">下次跟进</text><text class="td actions">操作</text></view>
        <view v-if="!list.length&&!loading" class="empty-row">{{ poolDisabled?'公海功能未开启':'暂无线索数据' }}</view>
        <view v-for="item in list" :key="item.id" class="tr" :class="{terminal:isTerminal(item.status)}"><view class="td check"><view class="checkbox" :class="{checked:selectedIds.includes(item.id)}" @click="toggleSelect(item.id)">{{ selectedIds.includes(item.id)?'✓':'' }}</view></view><view class="td name"><view class="name-row"><text class="lead-name" @click="openLead(item.id)">{{ item.company_name||item.contact_name }}</text><text class="favorite" :class="{active:item.is_favorited}" @click="toggleFavorite(item)">★</text></view><text class="sub-info">{{ item.phone||item.wechat||'无联系方式' }}</text></view><view class="td contact"><text>{{ item.contact_name }}</text><text v-if="item.industry" class="sub-info">{{ item.industry }}</text></view><view class="td source"><text class="source-chip">{{ item.source }}</text></view><view class="td intent"><text class="intent-chip" :class="intentClass(item.intent_level)">{{ item.intent_level }}</text></view><view class="td status"><text class="status-chip" :class="statusClass(item.status)">{{ item.status }}</text></view><text class="td owner">{{ item.owner_name||'-' }}</text><view class="td follow"><text>{{ relativeFollow(item.last_follow_at) }}</text><text class="sub-info ellipsis">{{ item.last_follow_content||'暂无记录' }}</text></view><view class="td next"><text v-if="item.next_follow_at" :class="overdueDays(item.next_follow_at)?'overdue':''">{{ item.next_follow_at }}</text><text v-if="overdueDays(item.next_follow_at)" class="sub-info overdue">逾期 {{ overdueDays(item.next_follow_at) }} 天</text><text v-else-if="!item.next_follow_at" class="muted">未安排</text></view><view class="td actions"><text class="action-link" @click="openLead(item.id)">查看</text><text v-if="viewMode==='public'&&!poolDisabled" class="action-link" @click="claim(item)">认领</text><text v-else class="action-link" @click="openLead(item.id);setTimeout(openFollow,150)">写跟进</text></view></view>
      </view></scroll-view>
      <view v-if="viewMode==='all'" class="pagination"><text>共 {{ total }} 条</text><view class="pages"><button class="page-btn" :disabled="page<=1" @click="goPage(page-1)">‹</button><button v-for="n in Math.min(pageCount,5)" :key="n" class="page-btn" :class="{active:page===n}" @click="goPage(n)">{{ n }}</button><text v-if="pageCount>5">… {{ pageCount }}</text><button class="page-btn" :disabled="page>=pageCount" @click="goPage(page+1)">›</button></view></view>
    </view>

    <view v-if="showDrawer" class="drawer-mask" @click.self="showDrawer=false"><aside class="drawer"><view class="drawer-head"><view><text class="drawer-title">线索详情</text><view class="drawer-name-row"><text class="drawer-name">{{ detail?.company_name||detail?.contact_name }}</text><text class="status-chip" :class="statusClass(detail?.status)">{{ detail?.status }}</text></view></view><text class="close" @click="showDrawer=false">×</text></view><scroll-view class="drawer-body" scroll-y>
      <view class="detail-section"><view class="section-head-row"><text class="section-title"><b>A</b> 基本信息</text><view v-if="canEditDetail" class="section-actions"><text @click="openEditLead">编辑</text><text class="danger" @click="deleteLead">删除</text></view></view><view class="detail-grid"><text class="key">联系人</text><text class="value">{{ detail?.contact_name }}</text><text class="key">手机号</text><text class="value link" @click="detail?.phone&&callPhone(detail.phone)">{{ detail?.phone||'-' }}</text><text class="key">微信号</text><text class="value link" @click="detail?.wechat&&copyWechat(detail.wechat)">{{ detail?.wechat||'-' }}</text><text class="key">行业</text><text class="value">{{ detail?.industry||'-' }}</text><text class="key">来源</text><text class="value">{{ detail?.source }}{{ detail?.source_note?` / ${detail.source_note}`:'' }}</text><text class="key">意向</text><text class="value">{{ detail?.intent_level }}</text><text class="key">负责人</text><text class="value">{{ detail?.owner_name }}</text><text class="key">线索日期</text><text class="value">{{ detail?.lead_date }}</text><text class="key">下次跟进</text><text class="value">{{ detail?.next_follow_at||'-' }}</text><text class="key">需求概况</text><text class="value full long">{{ detail?.demand_note||'-' }}</text><text v-if="totalAmount" class="key">累计报价</text><text v-if="totalAmount" class="value amount">¥{{ totalAmount.toLocaleString() }}</text></view></view>
      <view class="detail-section"><view class="section-head-row"><text class="section-title"><b>B</b> 标签</text></view><view class="tag-list"><text v-for="tag in allTags" :key="tag.id" class="tag-chip" :class="{selected:leadTags.some(t=>t.id===tag.id)}" :style="leadTags.some(t=>t.id===tag.id)?{background:tag.color,borderColor:tag.color}:{}" @click="toggleTag(tag)">{{ tag.name }}</text></view><view v-if="canEditDetail" class="new-tag"><input v-model="newTagName" class="mini-input" placeholder="新标签" /><button class="mini-btn" @click="createTag">创建</button></view></view>
      <view class="detail-section"><view class="section-head-row"><text class="section-title"><b>C</b> 品牌与工商关联</text><text v-if="canEditDetail" class="section-link" @click="openRelations">管理关联</text></view><view class="relation-block"><text class="relation-label">品牌</text><view class="relation-tags"><text v-for="brand in leadRelations.brands" :key="brand.id" class="relation-chip">{{ brand.name }}</text><text v-if="!leadRelations.brands.length" class="muted">暂无</text></view></view><view class="relation-block"><text class="relation-label">工商主体</text><view class="relation-tags"><text v-for="company in leadRelations.companies" :key="company.id" class="relation-chip company">{{ company.name }}</text><text v-if="!leadRelations.companies.length" class="muted">暂无</text></view></view></view>
      <view class="detail-section"><view class="section-head-row"><text class="section-title"><b>D</b> 跟进记录 ({{ followUps.length }})</text><button v-if="canEditDetail" class="mini-btn primary" @click="openFollow">＋ 写跟进</button></view><view v-if="!followUps.length" class="section-empty">暂无跟进记录</view><view v-for="follow in followUps" :key="follow.id" class="follow-item"><view class="timeline-dot"/><view class="follow-main"><view class="follow-head"><view><text class="follow-user">{{ follow.user_name }}</text><text class="follow-time">{{ formatTime(follow.created_at) }}</text></view><view class="follow-head-actions"><text class="follow-type">{{ follow.type }}</text><template v-if="store.isAdmin()||follow.user_id===store.userInfo?.id"><text class="tiny-link" @click="openEditFollow(follow)">编辑</text><text class="tiny-link danger" @click="deleteFollow(follow)">删除</text></template></view></view><text class="follow-content">{{ follow.content }}</text><text v-if="follow.result" class="follow-result">结果：{{ follow.result }}</text><view class="follow-foot"><text v-if="follow.amount" class="amount">报价 ¥{{ Number(follow.amount).toLocaleString() }}</text><text v-if="follow.next_follow_at">下次 {{ follow.next_follow_at }}</text></view><view v-if="parseImages(follow.images).length" class="image-list"><image v-for="image in parseImages(follow.images)" :key="image" class="thumb" :src="`${BASE_URL}${image}`" mode="aspectFill" @click="previewImages(image,parseImages(follow.images))" /></view></view></view></view>
      <view class="detail-section"><view class="section-head-row" @click="showAudit=!showAudit"><text class="section-title"><b>E</b> 操作日志</text><text class="section-link">{{ showAudit?'收起':'展开' }}</text></view><view v-if="showAudit"><view v-if="!auditLogs.length" class="section-empty">暂无日志</view><view v-for="log in auditLogs" :key="log.id" class="audit-row"><text class="audit-user">{{ log.user_name }}</text><text class="audit-copy">{{ auditDescription(log) }}</text><text class="audit-time">{{ formatTime(log.created_at) }}</text></view></view></view>
    </scroll-view><view class="drawer-actions"><button v-if="detail?.phone" class="drawer-btn ghost" @click="callPhone(detail.phone)">拨打电话</button><button v-if="detail?.wechat" class="drawer-btn ghost" @click="copyWechat(detail.wechat)">复制微信</button><button v-if="canEditDetail" class="drawer-btn primary" @click="openFollow">写跟进</button></view></aside></view>

    <view v-if="showLeadForm" class="modal-mask" @click.self="showLeadForm=false"><view class="modal lead-modal"><view class="modal-head"><text class="modal-title">{{ editingLeadId?'编辑线索':'新增线索' }}</text><text class="close" @click="showLeadForm=false">×</text></view><scroll-view class="modal-body" scroll-y><view class="form-grid"><label class="form-item required"><text>联系人</text><input v-model="leadForm.contact_name" class="field" /></label><label class="form-item"><text>公司 / 品牌名</text><input v-model="leadForm.company_name" class="field" /></label><label class="form-item"><text>手机号</text><input v-model="leadForm.phone" class="field" maxlength="11" /></label><label class="form-item"><text>微信号</text><input v-model="leadForm.wechat" class="field" /></label><label class="form-item"><text>行业</text><picker :range="INDUSTRY_LIST" @change="(e:any)=>leadForm.industry=INDUSTRY_LIST[e.detail.value]"><view class="field select">{{ leadForm.industry||'请选择' }}⌄</view></picker></label><label class="form-item required"><text>来源</text><picker :range="SOURCE_LIST" @change="(e:any)=>leadForm.source=SOURCE_LIST[e.detail.value]"><view class="field select">{{ leadForm.source||'请选择' }}⌄</view></picker></label><label class="form-item"><text>来源细分</text><input v-model="leadForm.source_note" class="field" /></label><label class="form-item"><text>意向等级</text><view class="choice-row"><text v-for="intent in INTENT_LIST" :key="intent" class="choice" :class="{active:leadForm.intent_level===intent}" @click="leadForm.intent_level=intent">{{ intent }}</text></view></label><label class="form-item"><text>状态</text><picker :range="STATUS_LIST" @change="(e:any)=>leadForm.status=STATUS_LIST[e.detail.value]"><view class="field select">{{ leadForm.status }}⌄</view></picker></label><label class="form-item"><text>负责人</text><picker :range="users" range-key="name" @change="(e:any)=>leadForm.owner_id=users[e.detail.value]?.id||leadForm.owner_id"><view class="field select">{{ users.find(u=>u.id===leadForm.owner_id)?.name||'请选择' }}⌄</view></picker></label><label class="form-item"><text>线索日期</text><input v-model="leadForm.lead_date" class="field" placeholder="YYYY-MM-DD" /></label><label class="form-item"><text>下次跟进</text><input v-model="leadForm.next_follow_at" class="field" placeholder="YYYY-MM-DD" /></label><label class="form-item wide"><text>需求概况</text><textarea v-model="leadForm.demand_note" class="textarea" /></label></view></scroll-view><view class="modal-actions"><button class="modal-btn ghost" @click="showLeadForm=false">取消</button><button class="modal-btn primary" :disabled="submitting" @click="saveLead">保存线索</button></view></view></view>

    <view v-if="showFollowForm" class="modal-mask" @click.self="showFollowForm=false"><view class="modal follow-modal"><view class="modal-head"><text class="modal-title">写跟进记录</text><text class="close" @click="showFollowForm=false">×</text></view><scroll-view class="modal-body" scroll-y><label class="form-item"><text>跟进方式</text><view class="choice-row"><text v-for="type in FOLLOW_TYPES" :key="type" class="choice" :class="{active:followForm.type===type}" @click="followForm.type=type">{{ type }}</text></view></label><label class="form-item required"><text>跟进内容</text><textarea v-model="followForm.content" class="textarea large" /></label><label class="form-item"><text>本次结果</text><input v-model="followForm.result" class="field" /></label><view class="form-grid"><label class="form-item"><text>报价金额（元）</text><input v-model="followForm.amount" class="field" type="digit" /></label><label class="form-item"><text>下次跟进</text><input v-model="followForm.next_follow_at" class="field" placeholder="YYYY-MM-DD" /></label></view><label class="form-item"><text>更新状态</text><picker :range="STATUS_LIST" @change="(e:any)=>followForm.status=STATUS_LIST[e.detail.value]"><view class="field select">{{ followForm.status }}⌄</view></picker></label><view class="form-item"><text>跟进图片（最多 9 张）</text><view class="upload-list"><image v-for="image in followForm.images" :key="image" class="upload-thumb" :src="`${BASE_URL}${image}`" mode="aspectFill" @click="previewImages(image,followForm.images)"/><view v-if="followForm.images.length<9" class="upload-add" @click="chooseImages">{{ uploadingCount?'上传中':'＋' }}</view></view></view></scroll-view><view class="modal-actions"><button class="modal-btn ghost" @click="showFollowForm=false">取消</button><button class="modal-btn primary" :disabled="submitting||uploadingCount>0" @click="saveFollow">保存跟进</button></view></view></view>

    <view v-if="showEditFollow" class="modal-mask" @click.self="showEditFollow=false"><view class="modal small-modal"><view class="modal-head"><text class="modal-title">编辑跟进</text><text class="close" @click="showEditFollow=false">×</text></view><view class="modal-body"><label class="form-item"><text>方式</text><picker :range="FOLLOW_TYPES" @change="(e:any)=>editFollowForm.type=FOLLOW_TYPES[e.detail.value]"><view class="field select">{{ editFollowForm.type }}⌄</view></picker></label><label class="form-item"><text>内容</text><textarea v-model="editFollowForm.content" class="textarea large" /></label><label class="form-item"><text>结果</text><input v-model="editFollowForm.result" class="field" /></label><label class="form-item"><text>报价金额</text><input v-model="editFollowForm.amount" class="field" type="digit" /></label><label class="form-item"><text>下次跟进</text><input v-model="editFollowForm.next_follow_at" class="field" placeholder="YYYY-MM-DD" /></label></view><view class="modal-actions"><button class="modal-btn ghost" @click="showEditFollow=false">取消</button><button class="modal-btn primary" @click="saveEditFollow">保存</button></view></view></view>

    <view v-if="showRelationForm" class="modal-mask" @click.self="showRelationForm=false"><view class="modal relation-modal"><view class="modal-head"><text class="modal-title">关联品牌与工商主体</text><text class="close" @click="showRelationForm=false">×</text></view><scroll-view class="modal-body" scroll-y><text class="group-title">品牌（可多选）</text><view class="option-grid"><text v-for="brand in brandOptions" :key="brand.id" class="option-chip" :class="{active:relationForm.brand_ids.includes(brand.id)}" @click="toggleRelation('brand_ids',brand.id)">{{ brand.name }}</text></view><text class="group-title">工商主体（可多选）</text><view class="option-grid"><text v-for="company in companyOptions" :key="company.id" class="option-chip" :class="{active:relationForm.company_ids.includes(company.id)}" @click="toggleRelation('company_ids',company.id)">{{ company.name }}</text></view><label class="sync-row" @click="relationForm.sync_company_name=!relationForm.sync_company_name"><view class="checkbox" :class="{checked:relationForm.sync_company_name}">{{ relationForm.sync_company_name?'✓':'' }}</view><text>将第一个品牌或工商主体名称同步到旧字段“公司/品牌名”</text></label></scroll-view><view class="modal-actions"><button class="modal-btn ghost" @click="showRelationForm=false">取消</button><button class="modal-btn primary" @click="saveRelations">保存关联</button></view></view></view>

    <view v-if="showBatchPanel" class="modal-mask" @click.self="showBatchPanel=false"><view class="modal small-modal"><view class="modal-head"><text class="modal-title">{{ batchForm.action==='status'?'批量修改状态':'批量转移负责人' }}</text><text class="close" @click="showBatchPanel=false">×</text></view><view class="modal-body"><view v-if="batchForm.action==='status'" class="option-grid"><text v-for="status in STATUS_LIST" :key="status" class="option-chip" :class="{active:batchForm.status===status}" @click="batchForm.status=status">{{ status }}</text></view><view v-else class="option-grid"><text v-for="user in users" :key="user.id" class="option-chip" :class="{active:batchForm.owner_id===String(user.id)}" @click="batchForm.owner_id=String(user.id)">{{ user.name }}</text></view></view><view class="modal-actions"><button class="modal-btn ghost" @click="showBatchPanel=false">取消</button><button class="modal-btn primary" @click="submitBatch">确认更新 {{ selectedCount }} 条</button></view></view></view>
    <view v-if="loading" class="loading-layer">加载中...</view>
  </view>
</template>

<style scoped>
.lead-panel{position:relative}.mode-tabs{height:48px;margin-bottom:12px;padding:0 5px;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--line);border-radius:10px}.mode-tab{height:36px;padding:0 18px;display:flex;align-items:center;border-radius:8px;color:#64748b;font-size:11px;cursor:pointer}.mode-tab.active{color:#2563eb;background:#edf4ff;font-weight:700}.filter-card{padding:14px 16px;margin-bottom:14px;background:#fff;border:1px solid var(--line);border-radius:11px}.filter-row{display:flex;align-items:center;gap:9px}.filter-row.top{margin-bottom:12px}.search-wrap{width:255px;flex:0 0 255px}.field{width:100%;height:38px;padding:0 11px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:11px}.quick-status{flex:1;display:flex;gap:5px;overflow-x:auto}.status-filter{padding:7px 9px;border:1px solid #e0e6ef;border-radius:7px;color:#64748b;background:#fff;font-size:9px;white-space:nowrap;cursor:pointer}.status-filter.active{color:#2563eb;border-color:#a9c3f8;background:#edf4ff}.filter-btn{height:34px;padding:0 13px;margin:0;border-radius:7px;color:#fff;background:var(--p);font-size:10px;line-height:34px}.filter-btn.ghost{color:#526078;background:#fff;border:1px solid #dce4ef}.filter-row.bottom{padding-top:10px;border-top:1px solid #f0f3f7;flex-wrap:wrap}.select-field{height:32px;padding:0 10px;display:flex;align-items:center;border:1px solid #e0e6ef;border-radius:6px;color:#526078;background:#fff;font-size:9px}.date-field{width:155px}.favorite-toggle{padding:6px 9px;border-radius:7px;color:#94a3b8;font-size:9px;cursor:pointer}.favorite-toggle.active{color:#d97706;background:#fff7e6}.pool-banner{min-height:78px;padding:15px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(110deg,#fff,#f7faff);border:1px solid #dce7f7;border-radius:11px}.pool-title,.pool-copy{display:block}.pool-title{font-size:14px;font-weight:800}.pool-copy{margin-top:5px;color:#718096;font-size:10px}.pool-options{display:flex;gap:7px}.pool-day{padding:7px 11px;border:1px solid #dce4ef;border-radius:7px;color:#64748b;background:#fff;font-size:10px;cursor:pointer}.pool-day.active{color:#2563eb;border-color:#a9c3f8;background:#edf4ff}.disabled-note{color:#dc2626;font-size:10px}
.table-card{background:#fff;border:1px solid var(--line);border-radius:11px;overflow:hidden}.table-head{height:62px;padding:0 17px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.card-title,.card-sub{display:block}.card-title{font-size:14px;font-weight:800}.card-sub{margin-top:3px;color:#94a3b8;font-size:10px}.table-tools{display:flex;align-items:center;gap:8px}.selected-count{color:#64748b;font-size:10px}.small-btn{height:31px;padding:0 11px;margin:0;border:1px solid #dce4ef;border-radius:7px;color:#526078;background:#fff;font-size:10px;line-height:31px}.small-btn.primary,.modal-btn.primary,.drawer-btn.primary,.mini-btn.primary{color:#fff;background:var(--p)}.data-table{min-width:1300px}.tr{min-height:60px;display:grid;grid-template-columns:42px 190px 115px 80px 65px 85px 85px 180px 125px 105px;align-items:center;border-bottom:1px solid #edf1f6}.tr:not(.th):hover{background:#f8fbff}.tr.terminal{opacity:.64}.tr.th{min-height:43px;background:#f8fafc;color:#536176;font-size:10px;font-weight:700}.td{padding:9px 11px;font-size:10px;min-width:0}.checkbox{width:17px;height:17px;display:flex;align-items:center;justify-content:center;border:1px solid #cbd5e1;border-radius:4px;color:#fff;background:#fff;cursor:pointer}.checkbox.checked{border-color:var(--p);background:var(--p)}.name-row{display:flex;align-items:center;gap:7px}.lead-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:700;cursor:pointer}.favorite{color:#cbd5e1;cursor:pointer}.favorite.active{color:#f59e0b}.sub-info{display:block;margin-top:3px;color:#94a3b8;font-size:8px}.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-chip,.intent-chip,.status-chip{display:inline-flex;padding:4px 7px;border-radius:11px;font-size:8px}.source-chip{color:#526078;background:#f1f5f9}.intent-chip.high{color:#dc2626;background:#fff0f0}.intent-chip.medium{color:#d97706;background:#fff7e6}.intent-chip.low{color:#2563eb;background:#edf4ff}.intent-chip.unknown{color:#64748b;background:#f1f5f9}.status-chip.new{color:#2563eb;background:#edf4ff}.status-chip.progress{color:#d97706;background:#fff7e6}.status-chip.quote{color:#7c3aed;background:#f3edff}.status-chip.success{color:#15803d;background:#eaf8ef}.status-chip.muted{color:#64748b;background:#f1f5f9}.overdue{color:#dc2626}.muted{color:#94a3b8}.actions{display:flex;gap:10px}.action-link,.link,.section-link,.tiny-link{color:var(--p);cursor:pointer}.empty-row{height:120px;display:flex;align-items:center;justify-content:center;color:#94a3b8}.pagination{height:58px;padding:0 17px;display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:10px}.pages{display:flex;align-items:center;gap:6px}.page-btn{width:29px;height:29px;padding:0;margin:0;border:1px solid #e0e6ef;border-radius:6px;background:#fff;color:#475569;font-size:10px;line-height:29px}.page-btn.active{color:#fff;background:var(--p);border-color:var(--p)}
.drawer-mask,.modal-mask{position:fixed;inset:0;z-index:100;background:rgba(15,23,42,.28);display:flex;justify-content:flex-end}.drawer{width:590px;height:100%;display:flex;flex-direction:column;background:#fff;box-shadow:-15px 0 35px rgba(15,23,42,.12)}.drawer-head{min-height:92px;padding:20px 24px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}.drawer-title{display:block;font-size:17px;font-weight:800}.drawer-name-row{margin-top:9px;display:flex;align-items:center;gap:9px}.drawer-name{font-size:14px;font-weight:700}.close{font-size:27px;color:#64748b;cursor:pointer}.drawer-body{flex:1;min-height:0;padding:14px}.detail-section{margin-bottom:13px;padding:15px;background:#f9fbfe;border:1px solid #edf1f6;border-radius:10px}.section-head-row{display:flex;align-items:center;justify-content:space-between}.section-title{display:flex;align-items:center;gap:7px;margin-bottom:13px;font-size:12px;font-weight:800}.section-title b{width:21px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#2563eb;background:#e6efff;font-size:11px}.section-actions{display:flex;gap:12px;color:#2563eb;font-size:9px;cursor:pointer}.danger{color:#dc2626!important}.detail-grid{display:grid;grid-template-columns:86px 1fr;gap:9px 10px}.key{color:#718096;font-size:9px}.value{font-size:10px;word-break:break-all}.value.full{grid-column:2}.value.long{line-height:1.6;white-space:pre-wrap}.amount{color:#dc2626;font-weight:700}.tag-list,.relation-tags,.option-grid,.choice-row{display:flex;flex-wrap:wrap;gap:7px}.tag-chip,.relation-chip,.option-chip,.choice{padding:5px 8px;border:1px solid #dce4ef;border-radius:7px;color:#64748b;background:#fff;font-size:8px;cursor:pointer}.tag-chip.selected{color:#fff}.relation-chip{color:#2563eb;background:#edf4ff;border-color:#d5e4ff}.relation-chip.company{color:#15803d;background:#eaf8ef;border-color:#d1f0db}.new-tag{display:flex;gap:7px;margin-top:10px}.mini-input{height:30px;flex:1;padding:0 9px;border:1px solid #dce4ef;border-radius:6px;font-size:9px}.mini-btn{height:30px;padding:0 10px;margin:0;border:1px solid #dce4ef;border-radius:6px;background:#fff;color:#526078;font-size:9px;line-height:30px}.relation-block{display:grid;grid-template-columns:65px 1fr;gap:8px;margin-top:9px}.relation-label{color:#718096;font-size:9px}.section-empty{padding:18px;text-align:center;color:#94a3b8;font-size:9px}.follow-item{position:relative;padding:10px 0 10px 22px;border-bottom:1px solid #edf1f6}.follow-item:last-child{border-bottom:0}.timeline-dot{position:absolute;left:2px;top:15px;width:8px;height:8px;border-radius:50%;background:#60a5fa;box-shadow:0 0 0 4px #eaf2ff}.follow-main{min-width:0}.follow-head{display:flex;align-items:center;justify-content:space-between}.follow-user,.follow-time{margin-right:8px;font-size:9px}.follow-user{font-weight:700}.follow-time{color:#94a3b8}.follow-head-actions{display:flex;align-items:center;gap:8px}.follow-type{padding:3px 6px;border-radius:9px;color:#2563eb;background:#edf4ff;font-size:8px}.tiny-link{font-size:8px}.follow-content{display:block;margin-top:7px;font-size:10px;line-height:1.55}.follow-result{display:block;margin-top:6px;padding:6px 8px;border-radius:6px;color:#526078;background:#fff;font-size:9px}.follow-foot{display:flex;gap:14px;margin-top:7px;color:#718096;font-size:8px}.image-list,.upload-list{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}.thumb,.upload-thumb,.upload-add{width:56px;height:56px;border-radius:7px}.thumb,.upload-thumb{background:#eef2f7}.upload-add{display:flex;align-items:center;justify-content:center;border:1px dashed #aebbd0;color:#64748b;background:#fff;font-size:20px;cursor:pointer}.audit-row{padding:8px 0;display:grid;grid-template-columns:65px 1fr 105px;gap:8px;border-bottom:1px solid #edf1f6;font-size:8px}.audit-user{font-weight:700}.audit-copy{color:#526078}.audit-time{color:#94a3b8;text-align:right}.drawer-actions{height:68px;padding:12px 18px;display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line)}.drawer-btn{height:40px;padding:0 17px;margin:0;border-radius:8px;font-size:11px;line-height:40px}.drawer-btn.ghost{color:#526078;background:#fff;border:1px solid #dce4ef}
.modal-mask{align-items:center;justify-content:center;padding:30px}.modal{width:620px;max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:13px;box-shadow:0 20px 60px rgba(15,23,42,.22);overflow:hidden}.lead-modal{width:min(850px,90vw)}.relation-modal{width:min(760px,90vw)}.small-modal{width:520px}.modal-head{height:68px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.modal-title{font-size:16px;font-weight:800}.modal-body{flex:1;min-height:0;padding:20px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form-item{display:block;margin-bottom:14px}.form-item.wide{grid-column:1/-1}.form-item>text{display:block;margin-bottom:7px;color:#526078;font-size:10px;font-weight:700}.form-item.required>text::after{content:' *';color:#dc2626}.field.select{display:flex;align-items:center;justify-content:space-between;line-height:38px}.textarea{width:100%;min-height:70px;padding:9px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:11px}.textarea.large{min-height:105px}.choice.active,.option-chip.active{color:#2563eb;border-color:#94b7fb;background:#edf4ff}.group-title{display:block;margin:15px 0 10px;font-size:11px;font-weight:800}.sync-row{margin-top:20px;display:flex;align-items:center;gap:9px;color:#526078;font-size:9px}.modal-actions{height:64px;padding:12px 20px;display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line)}.modal-btn{height:38px;min-width:85px;padding:0 16px;margin:0;border-radius:7px;font-size:10px;line-height:38px}.modal-btn.ghost{color:#526078;background:#fff;border:1px solid #dce4ef}.loading-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);z-index:30;color:#64748b}
</style>
