<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get, post } from '../../utils/request';
import { useUserStore } from '../../store/user';
import CustomTabBar from '../../components/CustomTabBar.vue';
import { prefetchTabPages } from '../../utils/prefetch';

const store = useUserStore();

interface Lead {
  id: number;
  company_name: string | null;
  contact_name: string;
  phone: string | null;
  wechat: string | null;
  status: string;
  source: string;
  owner_name: string;
  next_follow_at: string | null;
  last_follow_at: string | null;
  last_follow_content: string | null;
  intent_level: string;
}

const leads = ref<Lead[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const page = ref(1);
const total = ref(0);
const hasMore = computed(() => leads.value.length < total.value);

// 搜索 & 筛选
const keyword = ref('');
const debounceTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const showFilter = ref(false);
const sortMode = ref<'last_follow' | 'next_follow' | 'created_new'>('last_follow');
const filterDate = ref('');

// 批量操作
const batchMode = ref(false);
const selectedIds = ref<number[]>([]);
const showBatchPanel = ref(false);
const batchAction = ref<'status' | 'transfer'>('status');
const batchStatus = ref('');
const batchOwnerId = ref('');

const selectedCount = computed(() => selectedIds.value.length);

function toggleBatchMode() {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    selectedIds.value = [];
    showBatchPanel.value = false;
  }
}

function toggleSelect(id: number) {
  const idx = selectedIds.value.indexOf(id);
  if (idx >= 0) selectedIds.value.splice(idx, 1);
  else selectedIds.value.push(id);
}

function isSelected(id: number) {
  return selectedIds.value.includes(id);
}

async function submitBatch() {
  if (selectedIds.value.length === 0) {
    uni.showToast({ title: '请先选择线索', icon: 'none' });
    return;
  }
  if (batchAction.value === 'status' && !batchStatus.value) {
    uni.showToast({ title: '请选择目标状态', icon: 'none' });
    return;
  }
  if (batchAction.value === 'transfer' && !batchOwnerId.value) {
    uni.showToast({ title: '请选择负责人', icon: 'none' });
    return;
  }
  try {
    const body: any = { ids: selectedIds.value, action: batchAction.value };
    if (batchAction.value === 'status') body.status = batchStatus.value;
    else body.owner_id = Number(batchOwnerId.value);
    await post('/api/leads/batch', body);
    uni.showToast({ title: `已更新 ${selectedIds.value.length} 条`, icon: 'success' });
    showBatchPanel.value = false;
    batchMode.value = false;
    selectedIds.value = [];
    batchStatus.value = '';
    batchOwnerId.value = '';
    await loadLeads(true);
  } catch {}
}

const filterStatus = ref<string[]>([]);
const filterSource = ref('');
const filterIndustry = ref('');
const filterIntent = ref('');

const STATUS_LIST = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const SOURCE_LIST = ['小红书', '抖音', '视频号', '知乎', '微信公众号', 'B站', '百度', '官网', '转介绍', '其他'];
const SORT_LIST = [
  { label: '今日新增', value: 'created_new' },
  { label: '最近跟进', value: 'last_follow' },
  { label: '下次跟进', value: 'next_follow' },
];
const FOLLOW_TYPES = ['电话', '微信', '拜访', '邮件', '其他'];

const STATUS_COLORS: Record<string, string> = {
  '新线索': '#1a56db',
  '跟进中': '#dd6b20',
  '已报价': '#6b46c1',
  '已成交': '#2f855a',
  '已流失': '#718096',
  '暂搁置': '#a0aec0',
  '停止跟进': '#c05621',
};

const activeFilterCount = computed(() => {
  let n = filterStatus.value.length;
  if (filterSource.value) n++;
  if (filterIndustry.value) n++;
  if (filterIntent.value) n++;
  return n;
});

const memberList = ref<{ id: number; name: string }[]>([]);

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function overdueDays(d: string): number {
  const diff = new Date(today()).getTime() - new Date(d).getTime();
  return Math.floor(diff / 86400000);
}

// ── Module 1: 意向等级 · 卡片头部色块 ──
function intentHeadColor(level: string): string {
  const map: Record<string, string> = { '高': '#E53E3E', '中': '#B7791F', '低': '#2F855A' };
  return map[level] || '#eef1f5';
}
function intentLabel(level: string): string {
  return level && level !== '未知' ? `${level}意向` : '未知';
}

// ── Module 2: 相对时间 ──
function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const nowDate = new Date(today());
  const d = new Date(dateStr.slice(0, 10));
  const diffDays = Math.floor((nowDate.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`;
  return `${Math.floor(diffDays / 30)}月前`;
}

// ── Module 3: 逾期颜色三档 ──
function overdueTagClass(days: number): string {
  if (days >= 8) return 'overdue-critical';
  if (days >= 4) return 'overdue-high';
  return 'overdue-warn';
}

// ── Module 4: 一键拨打 ──
function callPhone(phone: string) {
  uni.makePhoneCall({ phoneNumber: phone });
}

// ── Module 5: 快速写跟进 ──
const quickFollowId = ref<number | null>(null);
const quickFollowContent = ref('');
const quickFollowType = ref('电话');
const quickFollowStatus = ref('跟进中');
const submittingQuickFollow = ref(false);

function openQuickFollow(id: number) {
  quickFollowId.value = id;
  quickFollowContent.value = '';
  quickFollowType.value = '电话';
  quickFollowStatus.value = leads.value.find(l => l.id === id)?.status || '跟进中';
}

async function submitQuickFollow() {
  if (!quickFollowContent.value.trim()) {
    uni.showToast({ title: '请输入跟进内容', icon: 'none' });
    return;
  }
  submittingQuickFollow.value = true;
  try {
    await post(`/api/leads/${quickFollowId.value}/follow-ups`, {
      type: quickFollowType.value,
      content: quickFollowContent.value.trim(),
      status: quickFollowStatus.value,
    });
    uni.showToast({ title: '跟进已记录', icon: 'success' });
    quickFollowId.value = null;
    await loadLeads(true);
  } catch {
    uni.showToast({ title: '提交失败', icon: 'none' });
  } finally {
    submittingQuickFollow.value = false;
  }
}

// ── Module 8: 顶部统计条（复用工作台 summary 接口，不额外新增接口）──
const statsOverdue = ref(0);
const statsToday = ref(0);

async function loadStats() {
  try {
    const summary = await get<{ today: unknown[]; overdue: unknown[] }>('/api/dashboard/summary');
    statsToday.value = summary.today.length;
    statsOverdue.value = summary.overdue.length;
  } catch {
    // 统计条是辅助信息，接口失败时静默保留旧值即可
  }
}

const showStats = computed(() => activeFilterCount.value === 0 && !keyword.value && !filterDate.value);
const anyModalOpen = computed(() => showFilter.value || showBatchPanel.value || quickFollowId.value !== null);

async function loadLeads(reset = false) {
  if (reset) {
    page.value = 1;
    leads.value = [];
  }
  if (loading.value) return;
  loading.value = true;
  try {
    const params: Record<string, any> = {
      page: page.value,
      pageSize: 20,
      sort: sortMode.value,
      keyword: keyword.value || undefined,
      status: filterStatus.value.join(',') || undefined,
      source: filterSource.value || undefined,
      // 线索页始终只看自己名下的线索，看别人的去线索池
      owner_id: store.userInfo?.id ? String(store.userInfo.id) : undefined,
      industry: filterIndustry.value || undefined,
      intent: filterIntent.value || undefined,
      date: filterDate.value || undefined,
    };
    const res = await get<{ total: number; list: Lead[] }>('/api/leads', params);
    if (reset) {
      leads.value = res.list;
    } else {
      leads.value.push(...res.list);
    }
    total.value = res.total;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

function onKeywordInput() {
  if (debounceTimer.value) clearTimeout(debounceTimer.value);
  debounceTimer.value = setTimeout(() => loadLeads(true), 300);
}

async function onRefresh() {
  refreshing.value = true;
  await Promise.all([loadLeads(true), loadStats()]);
}

async function onReachBottom() {
  if (hasMore.value && !loading.value) {
    page.value++;
    await loadLeads(false);
  }
}

function toggleStatus(s: string) {
  const idx = filterStatus.value.indexOf(s);
  if (idx >= 0) filterStatus.value.splice(idx, 1);
  else filterStatus.value.push(s);
}

// ── Module 7: 快速状态 chip ──
function toggleStatusChip(s: string) {
  toggleStatus(s);
  loadLeads(true);
}

function resetFilter() {
  filterStatus.value = [];
  filterSource.value = '';
  filterIndustry.value = '';
  filterIntent.value = '';
}

function applyFilter() {
  showFilter.value = false;
  loadLeads(true);
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/leads/detail?id=${id}` });
}

function goAdd() {
  uni.navigateTo({ url: '/pages/leads/form' });
}

function setSort(v: 'last_follow' | 'next_follow' | 'created_new') {
  sortMode.value = v;
  loadLeads(true);
}

function onPickDate(e: { detail: { value: string } }) {
  filterDate.value = e.detail.value;
  loadLeads(true);
}

function clearDate() {
  filterDate.value = '';
  loadLeads(true);
}

function displayName(lead: Lead) {
  return lead.company_name || lead.contact_name;
}

function truncate(s: string | null, n = 40) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

let _inited = false;
onShow(async () => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  if (!_inited) {
    _inited = true;
    prefetchTabPages();
    const mres = await get<any[]>('/api/users/members').catch(() => []);
    memberList.value = mres || [];
  }
  await Promise.all([loadLeads(true), loadStats()]);
});
</script>

<template>
  <view class="list-page">
    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input-wrap">
        <input
          class="search-input"
          v-model="keyword"
          placeholder="搜索公司/联系人/手机"
          @input="onKeywordInput"
        />
      </view>
      <view class="filter-btn" @click="showFilter = true">
        <text>筛选</text>
        <view v-if="activeFilterCount > 0" class="filter-badge">{{ activeFilterCount }}</view>
      </view>
      <view class="batch-btn" :class="{ active: batchMode }" @click="toggleBatchMode">
        <text>{{ batchMode ? '取消' : '批量' }}</text>
      </view>
    </view>

    <!-- Module 7: 状态快速 chips -->
    <scroll-view class="chips-bar" scroll-x>
      <view class="chips-inner">
        <view
          v-for="s in STATUS_LIST"
          :key="s"
          class="status-chip"
          :class="{ 'chip-active': filterStatus.includes(s) }"
          @click="toggleStatusChip(s)"
        >{{ s }}</view>
      </view>
    </scroll-view>

    <!-- Module 6: 排序 + 按日期筛选 -->
    <view class="sort-area">
      <scroll-view class="sort-bar" scroll-x>
        <view
          v-for="s in SORT_LIST"
          :key="s.value"
          class="sort-item"
          :class="{ active: sortMode === s.value }"
          @click="setSort(s.value as any)"
        >
          {{ s.label }}
        </view>
      </scroll-view>

      <!-- picker 元素常驻不卸载，避免在它自身 change 事件里被 v-if 立刻移除导致报错 -->
      <view class="date-filter-wrap">
        <picker mode="date" :value="filterDate" @change="onPickDate">
          <view class="date-pick-btn" :class="{ 'date-pick-btn--active': filterDate }">
            <text v-if="!filterDate">📅</text>
            <text v-else>{{ filterDate.slice(5) }}</text>
          </view>
        </picker>
        <view v-if="filterDate" class="date-clear-btn" @click.stop="clearDate">✕</view>
      </view>
    </view>

    <!-- Module 8: 统计条 -->
    <view v-if="showStats && total > 0" class="stats-bar">
      <text class="stats-item">共 {{ total }} 条 · 逾期 {{ statsOverdue }} 条 · 今日待跟进 {{ statsToday }} 条</text>
    </view>

    <!-- 列表 -->
    <scroll-view
      class="lead-list"
      scroll-y
      refresher-enabled
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
      @scrolltolower="onReachBottom"
    >
      <view v-if="leads.length === 0 && !loading" class="empty-state">
        <text class="empty-icon">📋</text>
        <text class="empty-text">还没有线索，点右下角 + 添加第一条</text>
      </view>

      <view
        v-for="lead in leads"
        :key="lead.id"
        class="lead-card"
        :class="{ dimmed: lead.status === '已成交' || lead.status === '已流失' || lead.status === '停止跟进', selected: batchMode && isSelected(lead.id) }"
        @click="batchMode ? toggleSelect(lead.id) : goDetail(lead.id)"
      >
        <!-- 头部色块：Module 1 意向等级（大面积色块，一眼可见）+ 名称 + 状态 -->
        <view
          class="card-head"
          :class="{ 'card-head--neutral': !lead.intent_level || lead.intent_level === '未知' }"
          :style="{ background: intentHeadColor(lead.intent_level) }"
        >
          <view v-if="batchMode" class="checkbox" :class="{ checked: isSelected(lead.id) }">
            <text v-if="isSelected(lead.id)" class="check-mark">✓</text>
          </view>
          <text class="head-name">{{ displayName(lead) }}</text>
          <text class="head-intent">{{ intentLabel(lead.intent_level) }}</text>
          <view class="status-tag" :style="{ color: STATUS_COLORS[lead.status] }">
            <text>{{ lead.status }}</text>
          </view>
        </view>

        <view class="card-body">
          <!-- 第二行：联系人 · 手机 + 拨打 -->
          <view class="card-row">
            <text class="card-sub card-sub--name">{{ lead.contact_name }}</text>
            <text class="card-sub card-sub--phone" v-if="lead.phone"> · {{ lead.phone }}</text>
            <text class="card-sub card-sub--phone" v-else-if="lead.wechat"> · 微信 {{ lead.wechat }}</text>
            <!-- Module 4: 一键拨打 -->
            <view v-if="lead.phone" class="call-btn" @click.stop="callPhone(lead.phone)">📞</view>
          </view>

          <!-- 第三行：来源 + 负责人 -->
          <view class="card-row">
            <view class="source-tag"><text>{{ lead.source }}</text></view>
            <text class="card-owner">{{ lead.owner_name }}</text>
          </view>

          <!-- 第四行：相对时间 + 跟进摘要 + 写跟进按钮 -->
          <!-- Module 2: 相对时间 | Module 5: 快速写跟进 -->
          <view class="card-row card-row--follow">
            <text v-if="lead.last_follow_at" class="follow-time">{{ relativeTime(lead.last_follow_at) }}</text>
            <text v-if="lead.last_follow_at && lead.last_follow_content" class="follow-sep">·</text>
            <text v-if="lead.last_follow_content" class="card-follow-content">{{ truncate(lead.last_follow_content, 28) }}</text>
            <view class="write-btn" @click.stop="openQuickFollow(lead.id)">写跟进</view>
          </view>

          <!-- 下次跟进提醒 - Module 3: 三档颜色 -->
          <view v-if="lead.next_follow_at" class="card-row">
            <view
              v-if="lead.status !== '已成交' && lead.status !== '已流失' && lead.status !== '停止跟进' && overdueDays(lead.next_follow_at) > 0"
              class="overdue-tag"
              :class="overdueTagClass(overdueDays(lead.next_follow_at))"
            >
              <text>已逾期 {{ overdueDays(lead.next_follow_at) }} 天</text>
            </view>
            <text v-else class="next-follow-text">
              下次跟进 {{ lead.next_follow_at?.slice(5) }}
            </text>
          </view>
        </view>
      </view>

      <view v-if="loading" class="loading-tip">
        <text>加载中...</text>
      </view>
      <view v-if="!hasMore && leads.length > 0" class="loading-tip">
        <text>已显示全部 {{ total }} 条</text>
      </view>

      <view class="list-bottom-spacer"></view>
    </scroll-view>

    <!-- 批量操作底栏 -->
    <view v-if="batchMode" class="batch-bar">
      <text class="batch-count">已选 {{ selectedCount }} 条</text>
      <view class="batch-actions">
        <view class="batch-action-btn" @click="batchAction='status'; showBatchPanel=true">改状态</view>
        <view class="batch-action-btn" @click="batchAction='transfer'; showBatchPanel=true">转负责人</view>
      </view>
    </view>

    <!-- 批量操作面板 -->
    <view v-if="showBatchPanel" class="filter-mask" @click.self="showBatchPanel=false">
      <view class="batch-panel">
        <view class="popup-header">
          <text class="popup-title">{{ batchAction === 'status' ? '批量改状态' : '批量转负责人' }}</text>
          <text class="popup-close" @click="showBatchPanel=false">✕</text>
        </view>
        <view class="panel-body">
          <template v-if="batchAction === 'status'">
            <view class="filter-tags" style="flex-wrap:wrap;">
              <view
                v-for="s in STATUS_LIST" :key="s"
                class="filter-tag" :class="{ selected: batchStatus === s }"
                @click="batchStatus = s"
              >{{ s }}</view>
            </view>
          </template>
          <template v-else>
            <view class="filter-tags" style="flex-wrap:wrap;">
              <view
                v-for="u in memberList" :key="u.id"
                class="filter-tag" :class="{ selected: batchOwnerId === String(u.id) }"
                @click="batchOwnerId = String(u.id)"
              >{{ u.name }}</view>
            </view>
          </template>
        </view>
        <view class="panel-footer">
          <button class="btn-apply" @click="submitBatch">确认（{{ selectedCount }} 条）</button>
        </view>
      </view>
    </view>

    <!-- Module 5: 快速写跟进弹层 -->
    <view v-if="quickFollowId !== null" class="filter-mask" @click.self="quickFollowId = null">
      <view class="quick-panel">
        <view class="popup-header">
          <text class="popup-title">快速跟进</text>
          <text class="popup-close" @click="quickFollowId = null">✕</text>
        </view>
        <scroll-view scroll-x class="follow-types-bar">
          <view class="follow-types-inner">
            <view
              v-for="t in FOLLOW_TYPES" :key="t"
              class="follow-type-btn"
              :class="{ active: quickFollowType === t }"
              @click="quickFollowType = t"
            >{{ t }}</view>
          </view>
        </scroll-view>
        <view class="quick-status-row">
          <text class="quick-label">更新状态</text>
          <scroll-view scroll-x class="quick-status-scroll">
            <view class="follow-types-inner">
              <view
                v-for="s in STATUS_LIST" :key="s"
                class="follow-type-btn follow-type-btn--sm"
                :class="{ active: quickFollowStatus === s }"
                @click="quickFollowStatus = s"
              >{{ s }}</view>
            </view>
          </scroll-view>
        </view>
        <textarea
          class="quick-input"
          v-model="quickFollowContent"
          placeholder="跟进内容..."
          :maxlength="500"
        />
        <view class="quick-footer">
          <button class="btn-apply" @click="submitQuickFollow" :disabled="submittingQuickFollow">
            {{ submittingQuickFollow ? '提交中...' : '记录跟进' }}
          </button>
        </view>
      </view>
    </view>

    <!-- 筛选抽屉 -->
    <view v-if="showFilter" class="filter-mask" @click.self="showFilter = false">
      <view class="filter-drawer">
        <view class="filter-title">筛选条件</view>

        <scroll-view class="filter-body" scroll-y>
          <view class="filter-section">
            <text class="filter-label">状态（多选）</text>
            <view class="filter-tags">
              <view
                v-for="s in STATUS_LIST"
                :key="s"
                class="filter-tag"
                :class="{ selected: filterStatus.includes(s) }"
                @click="toggleStatus(s)"
              >{{ s }}</view>
            </view>
          </view>

          <view class="filter-section">
            <text class="filter-label">来源</text>
            <scroll-view scroll-x class="filter-scroll">
              <view class="filter-tags">
                <view
                  v-for="s in SOURCE_LIST"
                  :key="s"
                  class="filter-tag"
                  :class="{ selected: filterSource === s }"
                  @click="filterSource = filterSource === s ? '' : s"
                >{{ s }}</view>
              </view>
            </scroll-view>
          </view>

          <view class="filter-section">
            <text class="filter-label">意向等级</text>
            <view class="filter-tags">
              <view
                v-for="s in ['高','中','低','未知']"
                :key="s"
                class="filter-tag"
                :class="{ selected: filterIntent === s }"
                @click="filterIntent = filterIntent === s ? '' : s"
              >{{ s }}</view>
            </view>
          </view>
        </scroll-view>

        <view class="filter-actions">
          <button class="btn-reset" @click="resetFilter">重置</button>
          <button class="btn-apply" @click="applyFilter">确定</button>
        </view>
      </view>
    </view>

    <CustomTabBar v-if="!anyModalOpen" :current="0" />
  </view>
</template>

<style scoped>
.list-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: #f0f4fa;
}

/* ── 搜索栏 ── */
.search-bar {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  background: #fff;
  gap: 10px;
  border-bottom: 1px solid #e2e8f0;
}

.search-input-wrap { flex: 1; }

.search-input {
  width: 100%;
  height: 36px;
  background: #f5f7fa;
  border-radius: 18px;
  padding: 0 14px;
  font-size: 14px;
  border: none;
  box-sizing: border-box;
}

.filter-btn {
  position: relative;
  display: flex;
  align-items: center;
  padding: 6px 14px;
  background: var(--p);
  border-radius: 18px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.filter-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  background: #e53e3e;
  border-radius: 50%;
  font-size: 11px;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* ── Module 7: 状态 chips ── */
.chips-bar {
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
  white-space: nowrap;
}

.chips-inner {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
}

.status-chip {
  padding: 4px 12px;
  border: 1.5px solid #e2e8f0;
  border-radius: 14px;
  font-size: 12px;
  color: #718096;
  white-space: nowrap;
  background: #fff;
}

.status-chip.chip-active {
  border-color: var(--p);
  color: var(--p);
  background: var(--pl);
  font-weight: 600;
}

/* ── Module 6: 排序 + 我的/全部 ── */
.sort-area {
  display: flex;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
}

.sort-bar {
  flex: 1;
  padding: 0 12px;
  white-space: nowrap;
}

.sort-item {
  display: inline-block;
  padding: 10px 14px;
  font-size: 13px;
  color: #718096;
  cursor: pointer;
}

.date-filter-wrap {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 10px;
}

.date-pick-btn {
  flex-shrink: 0;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  white-space: nowrap;
}

.date-pick-btn--active {
  background: var(--pl);
  color: var(--pd);
  font-size: 12px;
  font-weight: 600;
}

.date-clear-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #f5f7fa;
  color: #8d9aae;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sort-item.active {
  color: var(--p);
  border-bottom: 2px solid var(--p);
  font-weight: 600;
}

/* ── Module 8: 统计条 ── */
.stats-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px;
  background: #f8fafc;
  border-bottom: 1px solid #f0f4f8;
}

.stats-item {
  font-size: 12px;
  color: #a0aec0;
  font-variant-numeric: tabular-nums;
}

.stats-overdue {
  color: #e53e3e;
  font-weight: 600;
}

/* ── 列表 ── */
.lead-list { flex: 1; min-height: 0; overflow: hidden; }
.list-bottom-spacer { height: var(--tabbar-safe-bottom); }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px;
  gap: 16px;
}

.empty-icon { font-size: 48px; }
.empty-text { font-size: 14px; color: #718096; text-align: center; }

.lead-card {
  background: #fff;
  margin: 6px 12px;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.06);
  border: 1px solid #e8edf5;
  overflow: hidden;
}

.lead-card.dimmed { opacity: 0.6; }

/* Module 1: 意向等级 · 头部色块，大面积，扫一眼列表就能看出高意向 */
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.head-name {
  font-size: 14px;
  font-weight: 700;
  color: #fff;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.head-intent {
  font-size: 10.5px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.03em;
  flex-shrink: 0;
  white-space: nowrap;
  opacity: 0.9;
}

/* 未知意向：浅灰底，跟有判断的区分开 */
.card-head--neutral .head-name { color: #0d1421; }
.card-head--neutral .head-intent { color: #8d9aae; opacity: 1; }

.card-body {
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* Module 4: 不换行保证write-btn始终在右侧 */
.card-row--follow {
  flex-wrap: nowrap;
  overflow: hidden;
}

.status-tag {
  border-radius: 100px;
  padding: 2px 9px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
  background: rgba(255,255,255,0.92);
}

.card-sub { font-size: 13px; color: #4a5568; }
.card-sub--name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.card-sub--phone { flex-shrink: 0; white-space: nowrap; }

/* Module 4: 拨打按钮 */
.call-btn {
  font-size: 14px;
  padding: 2px 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.source-tag {
  background: var(--pl);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--p);
}

.card-owner { font-size: 12px; color: #718096; }

/* Module 2: 相对时间 */
.follow-time {
  font-size: 11px;
  color: #a0aec0;
  white-space: nowrap;
  flex-shrink: 0;
}

.follow-sep {
  font-size: 11px;
  color: #cbd5e0;
  flex-shrink: 0;
}

.card-follow-content {
  font-size: 12px;
  color: #718096;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Module 5: 写跟进按钮 */
.write-btn {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--p);
  border: 1px solid var(--pl);
  background: var(--pl);
  border-radius: 4px;
  padding: 2px 8px;
  white-space: nowrap;
}

/* Module 3: 逾期三档颜色 */
.overdue-tag {
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid;
}

.overdue-tag.overdue-warn {
  background: #FFFBEB;
  border-color: #F6AD55;
  color: #C05621;
}

.overdue-tag.overdue-high {
  background: #FFF5F5;
  border-color: #FC8181;
  color: #C53030;
}

.overdue-tag.overdue-critical {
  background: #FED7D7;
  border-color: #E53E3E;
  color: #9B2C2C;
  font-weight: 700;
}

.next-follow-text { font-size: 12px; color: var(--p); }

.loading-tip {
  text-align: center;
  padding: 16px;
  font-size: 13px;
  color: #a0aec0;
}


/* ── 遮罩 & 通用弹层 ── */
.filter-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 200;
  display: flex;
  align-items: flex-end;
}

/* ── Module 5: 快速跟进面板 ── */
.quick-panel {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding-bottom: calc(16px + env(safe-area-inset-bottom));
}

.follow-types-bar {
  white-space: nowrap;
  padding: 12px 16px 8px;
}

.follow-types-inner {
  display: flex;
  gap: 8px;
}

.follow-type-btn {
  padding: 5px 14px;
  border: 1.5px solid #e2e8f0;
  border-radius: 16px;
  font-size: 13px;
  color: #4a5568;
  white-space: nowrap;
  background: #fff;
}

.follow-type-btn.active {
  border-color: var(--p);
  color: var(--p);
  background: var(--pl);
  font-weight: 600;
}

.follow-type-btn--sm {
  padding: 3px 10px;
  font-size: 12px;
}

.quick-status-row {
  display: flex;
  align-items: center;
  padding: 0 16px 8px;
  gap: 8px;
}

.quick-label {
  font-size: 12px;
  color: #718096;
  flex-shrink: 0;
}

.quick-status-scroll {
  flex: 1;
  white-space: nowrap;
}

.quick-input {
  display: block;
  width: calc(100% - 32px);
  height: 80px;
  border: 1.5px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
  color: #1a202c;
  background: #f7fafc;
  box-sizing: border-box;
  margin: 0 16px 0;
}

.quick-footer {
  padding: 12px 16px;
  padding-bottom: calc(12px + var(--tabbar-safe-bottom) + env(safe-area-inset-bottom));
}

.quick-footer .btn-apply { width: 100%; }

/* ── 筛选抽屉 ── */
.filter-drawer {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.filter-title {
  font-size: 16px;
  font-weight: 700;
  color: #1a202c;
  padding: 20px 16px 12px;
  flex-shrink: 0;
  border-bottom: 1px solid #e2e8f0;
}

.filter-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.filter-section { margin-bottom: 16px; }
.filter-label { font-size: 13px; color: #718096; margin-bottom: 8px; display: block; }
.filter-scroll { white-space: nowrap; }

.filter-tags { display: flex; flex-wrap: wrap; gap: 8px; }

.filter-tag {
  padding: 6px 14px;
  border: 1.5px solid #e2e8f0;
  border-radius: 20px;
  font-size: 13px;
  color: #4a5568;
  display: inline-block;
}

.filter-tag.selected {
  background: var(--pl);
  border-color: var(--p);
  color: var(--p);
  font-weight: 600;
}

.filter-actions {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
  padding: 12px 16px;
  padding-bottom: calc(12px + var(--tabbar-safe-bottom) + env(safe-area-inset-bottom));
  border-top: 1px solid #e2e8f0;
  background: #fff;
}

.btn-reset {
  flex: 1;
  height: 44px;
  border: 1.5px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  font-size: 15px;
  color: #4a5568;
}

.btn-apply {
  flex: 2;
  height: 44px;
  background: var(--p);
  border-radius: 10px;
  font-size: 15px;
  color: #fff;
  font-weight: 600;
  border: none;
}

/* ── 批量 ── */
.batch-btn { padding: 6px 12px; border: 1.5px solid #718096; border-radius: 18px; font-size: 13px; color: #718096; white-space: nowrap; }
.batch-btn.active { border-color: #e53e3e; color: #e53e3e; }
.lead-card.selected { border: 2px solid var(--p); background: var(--pl); }
.checkbox { width: 20px; height: 20px; border-radius: 50%; border: 2px solid #cbd5e0; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: #fff; }
.checkbox.checked { background: var(--p); border-color: var(--p); }
.check-mark { color: #fff; font-size: 12px; font-weight: 700; }
.batch-bar { position: fixed; bottom: var(--tabbar-safe-bottom); left: 0; right: 0; background: #fff; border-top: 1px solid #e2e8f0; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; z-index: 150; box-shadow: 0 -2px 8px rgba(0,0,0,0.08); }
.batch-count { font-size: 14px; color: #4a5568; font-weight: 600; }
.batch-actions { display: flex; gap: 10px; }
.batch-action-btn { padding: 8px 18px; background: var(--p); border-radius: 20px; font-size: 13px; color: #fff; font-weight: 600; }
.batch-panel { background: #fff; border-radius: 16px 16px 0 0; width: 100%; }
.panel-body { padding: 16px; }
.panel-footer { padding: 12px 16px; padding-bottom: calc(12px + var(--tabbar-safe-bottom) + env(safe-area-inset-bottom)); border-top: 1px solid #e2e8f0; }
.panel-footer .btn-apply { flex: none; width: 100%; }
.popup-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e2e8f0; }
.popup-title { font-size: 16px; font-weight: 700; }
.popup-close { font-size: 18px; color: #a0aec0; padding: 4px; }
</style>
