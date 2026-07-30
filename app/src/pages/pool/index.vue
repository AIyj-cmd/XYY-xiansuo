<script setup lang="ts">
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get, post, del } from '../../utils/request';
import { useUserStore } from '../../store/user';
import CustomTabBar from '../../components/CustomTabBar.vue';

const store = useUserStore();
// 构建期开关只控制 UI；服务端 LEAD_POOL_CLAIM_ENABLED 才是安全边界。
const poolClaimRaw = import.meta.env.VITE_LEAD_POOL_CLAIM_ENABLED;
if (poolClaimRaw !== undefined && poolClaimRaw !== '' && poolClaimRaw !== 'true' && poolClaimRaw !== 'false') {
  throw new Error('VITE_LEAD_POOL_CLAIM_ENABLED 只能为 true 或 false');
}
const poolClaimEnabled = poolClaimRaw === 'true';

interface Lead {
  id: number;
  company_name: string | null;
  contact_name: string;
  phone: string | null;
  wechat: string | null;
  status: string;
  source: string;
  owner_name: string;
  owner_id: number | null;
  intent_level: string;
  last_follow_at: string | null;
  next_follow_at: string | null;
  is_favorited?: boolean | number;
  idle_days?: number;
}

const viewMode = ref<'all' | 'public'>('all');
const poolDays = ref(0);
const minimumPoolDays = ref(7);
const claimingId = ref<number | null>(null);
const list = ref<Lead[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const page = ref(1);
const total = ref(0);
const hasMore = computed(() => viewMode.value === 'all' && list.value.length < total.value);
const poolDayOptions = computed(() => Array.from(new Set([
  minimumPoolDays.value,
  Math.max(minimumPoolDays.value, 15),
  Math.max(minimumPoolDays.value, 30),
])));

const keyword = ref('');
const showFilter = ref(false);
const sortMode = ref<'last_follow' | 'next_follow' | 'created_new'>('last_follow');
const filterDate = ref('');
const favoriteOnly = ref(false);

const filterStatus = ref<string[]>([]);
const filterSource = ref('');
const filterOwner = ref('');
const filterIntent = ref('');
const filterIndustry = ref('');

const users = ref<{ id: number; name: string }[]>([]);

const STATUS_LIST = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const SOURCE_LIST = ['小红书', '抖音', '视频号', '知乎', '微信公众号', 'B站', '百度', '官网', '转介绍', '其他'];
const INDUSTRY_LIST = ['女装', '男装', '童装', '鞋类', '内衣', '其他'];
const SORT_LIST = [
  { label: '今日新增', value: 'created_new' },
  { label: '最近跟进', value: 'last_follow' },
  { label: '下次跟进', value: 'next_follow' },
];
const STATUS_COLORS: Record<string, string> = {
  '新线索': '#1a56db', '跟进中': '#dd6b20', '已报价': '#6b46c1',
  '已成交': '#2f855a', '已流失': '#718096', '暂搁置': '#a0aec0', '停止跟进': '#c05621',
};

function intentHeadColor(level: string): string {
  const map: Record<string, string> = { '高': '#E53E3E', '中': '#B7791F', '低': '#2F855A' };
  return map[level] || '#eef1f5';
}
function intentLabel(level: string): string {
  return level && level !== '未知' ? `${level}意向` : '未知';
}

const activeFilterCount = computed(() => {
  let n = filterStatus.value.length;
  if (filterSource.value) n++;
  if (filterOwner.value) n++;
  if (filterIntent.value) n++;
  if (filterIndustry.value) n++;
  return n;
});

const showStats = computed(() => viewMode.value === 'public'
  || (activeFilterCount.value === 0 && !keyword.value && !filterDate.value));

function isMine(lead: Lead) {
  return lead.owner_id === store.userInfo?.id;
}

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const nowDate = new Date(today());
  const d = new Date(dateStr.slice(0, 10));
  const diff = Math.floor((nowDate.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return `${diff}天前`;
  if (diff < 30) return `${Math.floor(diff / 7)}周前`;
  return `${Math.floor(diff / 30)}月前`;
}

function overdueDays(d: string): number {
  return Math.floor((new Date(today()).getTime() - new Date(d).getTime()) / 86400000);
}

function overdueTagClass(days: number): string {
  if (days >= 8) return 'overdue-critical';
  if (days >= 4) return 'overdue-high';
  return 'overdue-warn';
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function onKeywordInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => loadList(true), 400);
}

function toggleStatusChip(s: string) {
  const idx = filterStatus.value.indexOf(s);
  if (idx >= 0) filterStatus.value.splice(idx, 1);
  else filterStatus.value.push(s);
  loadList(true);
}

function toggleStatus(s: string) {
  const idx = filterStatus.value.indexOf(s);
  if (idx >= 0) filterStatus.value.splice(idx, 1);
  else filterStatus.value.push(s);
}

function setSort(v: 'last_follow' | 'next_follow' | 'created_new') {
  sortMode.value = v;
  loadList(true);
}

function onPickDate(e: { detail: { value: string } }) {
  filterDate.value = e.detail.value;
  loadList(true);
}

function clearDate() {
  filterDate.value = '';
  loadList(true);
}

function toggleFavoriteOnly() {
  favoriteOnly.value = !favoriteOnly.value;
  loadList(true);
}

async function toggleFavorite(item: Lead) {
  const wasFavorited = !!item.is_favorited;
  // 乐观更新，先改界面再请求，请求失败再改回来
  item.is_favorited = !wasFavorited;
  try {
    if (wasFavorited) {
      await del(`/api/leads/${item.id}/favorite`);
      uni.showToast({ title: '已取消收藏', icon: 'none' });
    } else {
      await post(`/api/leads/${item.id}/favorite`);
      uni.showToast({ title: '已收藏', icon: 'success' });
    }
    // 如果当前正在"只看收藏"，取消收藏后这条应该从列表里消失
    if (favoriteOnly.value && wasFavorited) {
      await loadList(true);
    }
  } catch {
    item.is_favorited = wasFavorited;
    uni.showToast({ title: '操作失败，请重试', icon: 'none' });
  }
}

function applyFilter() {
  showFilter.value = false;
  loadList(true);
}

function resetFilter() {
  filterStatus.value = [];
  filterSource.value = '';
  filterOwner.value = '';
  filterIntent.value = '';
  filterIndustry.value = '';
  showFilter.value = false;
  loadList(true);
}

function switchMode(mode: 'all' | 'public') {
  if (mode === 'public' && !poolClaimEnabled) return;
  if (viewMode.value === mode) return;
  viewMode.value = mode;
  showFilter.value = false;
  loadList(true);
}

function setPoolDays(days: number) {
  if (poolDays.value === days) return;
  poolDays.value = days;
  loadList(true);
}

async function claimLead(item: Lead) {
  if (claimingId.value !== null) return;
  claimingId.value = item.id;
  try {
    await post(`/api/pool/${item.id}/claim`);
    uni.showToast({ title: '认领成功', icon: 'success' });
    await loadList(true);
  } finally {
    claimingId.value = null;
  }
}

async function loadList(reset = false) {
  if (reset) { page.value = 1; list.value = []; }
  if (loading.value && !reset) return;
  loading.value = true;
  try {
    if (viewMode.value === 'public' && poolClaimEnabled) {
      const res = await get<{
        minimum_days: number;
        threshold_days: number;
        total: number;
        list: Lead[];
      }>(
        '/api/pool',
        { days: poolDays.value || undefined },
      );
      minimumPoolDays.value = res.minimum_days;
      poolDays.value = res.threshold_days;
      total.value = res.total;
      list.value = res.list;
      return;
    }

    const params: Record<string, any> = {
      page: page.value,
      pageSize: 20,
      sort: sortMode.value,
      keyword: keyword.value || undefined,
      status: filterStatus.value.join(',') || undefined,
      source: filterSource.value || undefined,
      // 线索池要看得到别人的线索，负责人筛选保持可选，不强制锁定成自己（跟"线索"页不一样）
      owner_id: filterOwner.value || undefined,
      intent: filterIntent.value || undefined,
      industry: filterIndustry.value || undefined,
      date: filterDate.value || undefined,
      favorite_only: favoriteOnly.value ? '1' : undefined,
    };
    const res = await get<{ total: number; list: Lead[] }>('/api/leads', params);
    total.value = res.total;
    if (reset) list.value = res.list;
    else list.value = [...list.value, ...res.list];
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function onRefresh() {
  refreshing.value = true;
  await loadList(true);
}

async function loadMore() {
  if (!hasMore.value || loading.value) return;
  page.value++;
  await loadList();
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/leads/detail?id=${id}` });
}

let usersLoaded = false;
onShow(async () => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  if (!usersLoaded) {
    usersLoaded = true;
    const res = await get<any[]>('/api/users/members').catch(() => []);
    users.value = res || [];
  }
  await loadList(true);
});
</script>

<template>
  <view class="pool-page">
    <view class="mode-switch">
      <view class="mode-item" :class="{ active: viewMode === 'all' }" @click="switchMode('all')">全部线索</view>
      <view v-if="poolClaimEnabled" class="mode-item" :class="{ active: viewMode === 'public' }" @click="switchMode('public')">公海待认领</view>
    </view>

    <!-- 搜索栏 -->
    <view v-if="viewMode === 'all'" class="search-bar">
      <view class="search-input-wrap">
        <input
          class="search-input"
          v-model="keyword"
          placeholder="搜索公司名、联系人..."
          @input="onKeywordInput"
        />
      </view>
      <view class="filter-btn" @click="showFilter = true">
        <text>筛选</text>
        <view v-if="activeFilterCount > 0" class="filter-badge">{{ activeFilterCount }}</view>
      </view>
    </view>

    <!-- 状态 chips -->
    <scroll-view v-if="viewMode === 'all'" class="chips-bar" scroll-x>
      <view class="chips-inner">
        <view
          v-for="s in STATUS_LIST" :key="s"
          class="status-chip"
          :class="{ 'chip-active': filterStatus.includes(s) }"
          @click="toggleStatusChip(s)"
        >{{ s }}</view>
      </view>
    </scroll-view>

    <!-- 排序 + 按日期筛选 -->
    <view v-if="viewMode === 'all'" class="sort-area">
      <scroll-view class="sort-bar" scroll-x>
        <view
          v-for="s in SORT_LIST" :key="s.value"
          class="sort-item"
          :class="{ active: sortMode === s.value }"
          @click="setSort(s.value as any)"
        >{{ s.label }}</view>
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

      <!-- 只看收藏 -->
      <view class="fav-filter-btn" :class="{ 'fav-filter-btn--active': favoriteOnly }" @click="toggleFavoriteOnly">
        <text>{{ favoriteOnly ? '★' : '☆' }}</text>
      </view>
    </view>

    <view v-else-if="poolClaimEnabled" class="pool-days-bar">
      <text class="pool-days-label">连续未跟进：</text>
      <view
        v-for="days in poolDayOptions"
        :key="days"
        class="pool-days-item"
        :class="{ active: poolDays === days }"
        @click="setPoolDays(days)"
      >{{ days }} 天+</view>
    </view>

    <!-- 统计条 -->
    <view v-if="showStats && total > 0" class="stats-bar">
      <text class="stats-item">{{ viewMode === 'public' ? `公海共 ${total} 条` : `共 ${total} 条` }}</text>
    </view>

    <!-- 列表 -->
    <scroll-view
      class="pool-list"
      scroll-y
      refresher-enabled
      :refresher-triggered="refreshing"
      @refresherrefresh="onRefresh"
      @scrolltolower="loadMore"
    >
      <view class="list-inner">
        <view v-if="list.length === 0 && !loading" class="empty-state">
          <text class="empty-text">{{ viewMode === 'public' ? '当前没有符合条件的公海线索' : '暂无线索数据' }}</text>
        </view>

        <view
          v-for="item in list" :key="item.id"
          class="pool-card"
          @click="goDetail(item.id)"
        >
          <!-- 头部色块：意向等级（大面积色块，一眼可见）+ 名称 + 状态 -->
          <view
            class="card-head"
            :class="{ 'card-head--neutral': !item.intent_level || item.intent_level === '未知' }"
            :style="{ background: intentHeadColor(item.intent_level) }"
          >
            <text class="head-name">{{ item.company_name || item.contact_name }}</text>
            <text class="head-intent">{{ intentLabel(item.intent_level) }}</text>
            <view class="status-tag" :style="{ color: STATUS_COLORS[item.status] }">
              <text>{{ item.status }}</text>
            </view>
            <view v-if="viewMode === 'all'" class="fav-star" :class="{ 'fav-star--active': item.is_favorited }" @click.stop="toggleFavorite(item)">
              <text>{{ item.is_favorited ? '★' : '☆' }}</text>
            </view>
          </view>

          <view class="card-body">
          <!-- 第二行：联系人 · 来源 -->
          <view class="card-row">
            <text class="card-sub">{{ item.contact_name }}</text>
            <text class="card-sub" v-if="item.source"> · {{ item.source }}</text>
          </view>

          <!-- 第三行：负责人 + 只读/我的标记 -->
          <view class="card-row">
            <text class="card-owner">负责人：{{ item.owner_name || '未分配' }}</text>
            <view v-if="!isMine(item) && !store.isAdmin()" class="readonly-badge"><text>只读</text></view>
            <view v-else class="mine-badge"><text>{{ isMine(item) ? '我的' : '可编辑' }}</text></view>
          </view>

          <view v-if="poolClaimEnabled && viewMode === 'public'" class="pool-claim-row">
            <text class="idle-days">已连续 {{ item.idle_days || poolDays }} 天未跟进</text>
            <view
              v-if="!isMine(item)"
              class="claim-btn"
              :class="{ disabled: claimingId !== null }"
              @click.stop="claimLead(item)"
            >{{ claimingId === item.id ? '认领中...' : '认领线索' }}</view>
            <text v-else class="mine-hint">当前由你负责</text>
          </view>

          <!-- 第四行：最近跟进时间 -->
          <view class="card-row card-row--follow" v-if="item.last_follow_at">
            <text class="follow-time">{{ relativeTime(item.last_follow_at) }}</text>
          </view>

          <!-- 逾期提示 -->
          <view v-if="item.next_follow_at && item.status !== '已成交' && item.status !== '已流失' && item.status !== '停止跟进'" class="card-row">
            <view
              v-if="overdueDays(item.next_follow_at) > 0"
              class="overdue-tag"
              :class="overdueTagClass(overdueDays(item.next_follow_at))"
            >
              <text>已逾期 {{ overdueDays(item.next_follow_at) }} 天</text>
            </view>
            <text v-else class="next-follow-text">下次跟进 {{ item.next_follow_at?.slice(5) }}</text>
          </view>
          </view>
        </view>

        <view v-if="loading" class="loading-tip"><text>加载中...</text></view>
        <view v-if="!hasMore && list.length > 0" class="loading-tip">
          <text>已显示全部 {{ total }} 条</text>
        </view>
      </view>
    </scroll-view>

    <!-- 筛选抽屉 -->
    <view v-if="showFilter && viewMode === 'all'" class="filter-mask" @click.self="showFilter = false">
      <view class="filter-drawer">
        <view class="filter-title">筛选条件</view>
        <scroll-view class="filter-body" scroll-y>
          <view class="filter-section">
            <text class="filter-label">状态（多选）</text>
            <view class="filter-tags">
              <view
                v-for="s in STATUS_LIST" :key="s"
                class="filter-tag" :class="{ selected: filterStatus.includes(s) }"
                @click="toggleStatus(s)"
              >{{ s }}</view>
            </view>
          </view>

          <view class="filter-section">
            <text class="filter-label">来源</text>
            <scroll-view scroll-x class="filter-scroll">
              <view class="filter-tags">
                <view
                  v-for="s in SOURCE_LIST" :key="s"
                  class="filter-tag" :class="{ selected: filterSource === s }"
                  @click="filterSource = filterSource === s ? '' : s"
                >{{ s }}</view>
              </view>
            </scroll-view>
          </view>

          <view class="filter-section">
            <text class="filter-label">意向等级</text>
            <view class="filter-tags">
              <view
                v-for="s in ['高','中','低','未知']" :key="s"
                class="filter-tag" :class="{ selected: filterIntent === s }"
                @click="filterIntent = filterIntent === s ? '' : s"
              >{{ s }}</view>
            </view>
          </view>

          <view class="filter-section">
            <text class="filter-label">行业</text>
            <view class="filter-tags">
              <view
                v-for="s in INDUSTRY_LIST" :key="s"
                class="filter-tag" :class="{ selected: filterIndustry === s }"
                @click="filterIndustry = filterIndustry === s ? '' : s"
              >{{ s }}</view>
            </view>
          </view>

          <view class="filter-section" v-if="users.length">
            <text class="filter-label">负责人</text>
            <scroll-view scroll-x class="filter-scroll">
              <view class="filter-tags">
                <view
                  v-for="u in users" :key="u.id"
                  class="filter-tag" :class="{ selected: filterOwner === String(u.id) }"
                  @click="filterOwner = filterOwner === String(u.id) ? '' : String(u.id)"
                >{{ u.name }}</view>
              </view>
            </scroll-view>
          </view>
        </scroll-view>

        <view class="filter-actions">
          <button class="btn-reset" @click="resetFilter">重置</button>
          <button class="btn-apply" @click="applyFilter">确定</button>
        </view>
      </view>
    </view>

    <CustomTabBar v-if="!showFilter" :current="2" />
  </view>
</template>

<style scoped>
.pool-page { display: flex; flex-direction: column; height: 100vh; height: 100dvh; background: #f0f4fa; }

.mode-switch { display: flex; gap: 4px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.mode-item { flex: 1; padding: 8px 12px; border-radius: 8px; text-align: center; font-size: 13px; color: #64748b; background: #f5f7fa; }
.mode-item.active { color: #fff; background: var(--p); font-weight: 700; }

/* 搜索栏 */
.search-bar { display: flex; align-items: center; padding: 10px 12px; background: #fff; gap: 10px; border-bottom: 1px solid #e2e8f0; }
.search-input-wrap { flex: 1; }
.search-input { width: 100%; height: 36px; background: #f5f7fa; border-radius: 18px; padding: 0 14px; font-size: 14px; border: none; box-sizing: border-box; }
.filter-btn { position: relative; display: flex; align-items: center; padding: 6px 14px; background: var(--p); border-radius: 18px; color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap; }
.filter-badge { position: absolute; top: -4px; right: -4px; width: 16px; height: 16px; background: #e53e3e; border-radius: 50%; font-size: 11px; color: #fff; display: flex; align-items: center; justify-content: center; }

/* 状态 chips */
.chips-bar { background: #fff; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
.chips-inner { display: flex; gap: 6px; padding: 8px 12px; }
.status-chip { padding: 4px 12px; border: 1.5px solid #e2e8f0; border-radius: 14px; font-size: 12px; color: #718096; white-space: nowrap; background: #fff; }
.status-chip.chip-active { border-color: var(--p); color: var(--p); background: var(--pl); font-weight: 600; }

/* 排序 */
.sort-area { display: flex; align-items: center; background: #fff; border-bottom: 1px solid #e2e8f0; }
.sort-bar { flex: 1; padding: 0 12px; white-space: nowrap; }
.sort-item { display: inline-block; padding: 10px 14px; font-size: 13px; color: #718096; }
.sort-item.active { color: var(--p); font-weight: 700; border-bottom: 2px solid var(--p); }

/* 按日期筛选 */
.date-filter-wrap { flex-shrink: 0; display: flex; align-items: center; gap: 4px; margin-right: 10px; }
.date-pick-btn { flex-shrink: 0; min-width: 32px; height: 32px; padding: 0 8px; border-radius: 8px; background: #f5f7fa; display: flex; align-items: center; justify-content: center; font-size: 15px; white-space: nowrap; }
.date-pick-btn--active { background: var(--pl); color: var(--pd); font-size: 12px; font-weight: 600; }
.date-clear-btn { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: #f5f7fa; color: #8d9aae; font-size: 11px; display: flex; align-items: center; justify-content: center; }

/* 只看收藏 */
.fav-filter-btn { flex-shrink: 0; width: 32px; height: 32px; margin-right: 12px; border-radius: 8px; background: #f5f7fa; color: #cbd5e0; display: flex; align-items: center; justify-content: center; font-size: 17px; }
.fav-filter-btn--active { background: #fff7e6; color: #dd9a3e; }

.pool-days-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.pool-days-label { font-size: 12px; color: #64748b; }
.pool-days-item { padding: 5px 10px; border-radius: 14px; border: 1px solid #dbe3ed; font-size: 12px; color: #64748b; }
.pool-days-item.active { border-color: var(--p); color: var(--p); background: var(--pl); font-weight: 700; }

/* 统计条 */
.stats-bar { padding: 6px 14px; background: #f0f4fa; }
.stats-item { font-size: 12px; color: #8d9aae; }

/* 列表 */
.pool-list { flex: 1; min-height: 0; overflow: hidden; }
.list-inner { padding: 8px 12px var(--tabbar-safe-bottom); }

.empty-state { display: flex; align-items: center; justify-content: center; padding: 60px 24px; }
.empty-text { font-size: 14px; color: #8d9aae; }

/* 卡片 */
.pool-card { background: #fff; border-radius: 8px; margin-bottom: 8px; border: 1px solid #e8edf5; box-shadow: 0 1px 3px rgba(15,23,42,0.05); overflow: hidden; }

/* 头部色块：意向等级，大面积，扫一眼列表就能看出高意向 */
.card-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.head-name { font-size: 14px; font-weight: 700; color: #fff; flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.head-intent { font-size: 10.5px; font-weight: 800; color: #fff; letter-spacing: 0.03em; flex-shrink: 0; white-space: nowrap; opacity: 0.9; }
.card-head--neutral .head-name { color: #0d1421; }
.card-head--neutral .head-intent { color: #8d9aae; opacity: 1; }

.card-body { padding: 8px 12px 10px; }
.card-row { display: flex; align-items: center; margin-bottom: 5px; }
.card-row:last-child { margin-bottom: 0; }
.card-row--follow { gap: 4px; }
.status-tag { border-radius: 100px; padding: 2px 9px; flex-shrink: 0; background: rgba(255,255,255,0.92); }
.status-tag text { font-size: 11px; font-weight: 700; }
.fav-star { flex-shrink: 0; padding: 2px 4px; display: flex; align-items: center; justify-content: center; }
.fav-star text { font-size: 18px; color: rgba(255,255,255,0.85); line-height: 1; }
.card-head--neutral .fav-star text { color: #cbd5e0; }
.fav-star.fav-star--active text { color: #ffd666; }
.card-sub { font-size: 12px; color: #64748b; }
.card-owner { flex: 1; font-size: 12px; color: #64748b; }
.follow-time { font-size: 12px; color: #a0aec0; }
.next-follow-text { font-size: 12px; color: #64748b; }

.readonly-badge { background: #f0f4fa; border: 1px solid #e8edf5; border-radius: 4px; padding: 2px 8px; flex-shrink: 0; }
.readonly-badge text { font-size: 11px; color: #8d9aae; }
.mine-badge { background: var(--pl); border-radius: 4px; padding: 2px 8px; flex-shrink: 0; }
.mine-badge text { font-size: 11px; color: var(--p); font-weight: 600; }

.pool-claim-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e2e8f0; }
.idle-days { flex: 1; font-size: 12px; color: #c05621; font-weight: 600; }
.claim-btn { padding: 6px 12px; border-radius: 6px; background: var(--p); color: #fff; font-size: 12px; font-weight: 700; }
.claim-btn.disabled { opacity: 0.55; }
.mine-hint { font-size: 12px; color: #2f855a; font-weight: 600; }

.overdue-tag { border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; }
.overdue-warn { background: #fffbeb; color: #d69e2e; }
.overdue-high { background: #fff5f0; color: #dd6b20; }
.overdue-critical { background: #fff0f0; color: #e53e3e; }

.loading-tip { text-align: center; font-size: 12px; color: #a0aec0; padding: 16px; }

/* 筛选抽屉 */
.filter-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100; display: flex; align-items: flex-end; }
.filter-drawer { width: 100%; background: #fff; border-radius: 16px 16px 0 0; max-height: 75vh; display: flex; flex-direction: column; }
.filter-title { font-size: 15px; font-weight: 700; color: #0d1421; padding: 16px 16px 12px; border-bottom: 1px solid #f0f4f8; }
.filter-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
.filter-section { margin-bottom: 16px; }
.filter-label { display: block; font-size: 12px; font-weight: 600; color: #8d9aae; margin-bottom: 8px; }
.filter-scroll { white-space: nowrap; }
.filter-tags { display: flex; flex-wrap: wrap; gap: 8px; }
.filter-tag { padding: 6px 14px; border: 1.5px solid #e2e8f0; border-radius: 20px; font-size: 13px; color: #4a5568; white-space: nowrap; }
.filter-tag.selected { border-color: var(--p); color: var(--p); background: var(--pl); font-weight: 600; }
.filter-actions { display: flex; gap: 10px; padding: 12px 16px; padding-bottom: calc(12px + var(--tabbar-safe-bottom) + env(safe-area-inset-bottom)); border-top: 1px solid #f0f4f8; }
.btn-reset { flex: 1; height: 44px; border-radius: 8px; background: #f0f4fa; color: #64748b; font-size: 14px; font-weight: 600; border: none; }
.btn-apply { flex: 2; height: 44px; border-radius: 8px; background: var(--p); color: #fff; font-size: 14px; font-weight: 600; border: none; }
</style>
