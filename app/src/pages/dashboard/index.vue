<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { get } from '../../utils/request';
import { useUserStore } from '../../store/user';
import { requestNotifyPermission, sendFollowUpReminder } from '../../utils/notify';
import { downloadFile } from '../../utils/file';
import CustomTabBar from '../../components/CustomTabBar.vue';

const store = useUserStore();

interface Summary {
  today: any[];
  overdue: any[];
  week_new: number;
  funnel: Record<string, number>;
  month_by_source: Array<{ source: string; lead_count: number; deal_count: number }>;
}

const summary = ref<Summary | null>(null);
const loading = ref(true);
const scrollTarget = ref('');

const STATUS_LIST = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];
const STATUS_COLORS: Record<string, string> = {
  '新线索': '#60a5fa', '跟进中': '#fbbf24', '已报价': '#a78bfa',
  '已成交': '#34d399', '已流失': '#94a3b8', '暂搁置': '#cbd5e1', '停止跟进': '#fb923c',
};

const todayLabel = computed(() => {
  const d = new Date();
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 · 周${days[d.getDay()]}`;
});

const funnelTotal = computed(() => {
  if (!summary.value) return 0;
  return Object.values(summary.value.funnel).reduce((a, b) => a + b, 0);
});

function funnelSegPct(status: string): number {
  if (!summary.value || funnelTotal.value === 0) return 0;
  return ((summary.value.funnel[status] || 0) / funnelTotal.value) * 100;
}

const rankedSources = computed(() => {
  if (!summary.value) return [];
  const max = Math.max(...summary.value.month_by_source.map(r => r.lead_count), 1);
  return [...summary.value.month_by_source]
    .sort((a, b) => b.lead_count - a.lead_count)
    .map(r => ({
      ...r,
      barPct: (r.lead_count / max) * 100,
      rate: r.lead_count > 0 ? Math.round((r.deal_count / r.lead_count) * 100) : 0,
    }));
});

const maxOverdueDays = computed(() => {
  if (!summary.value || summary.value.overdue.length === 0) return 0;
  return Math.max(...summary.value.overdue.map((i: any) => i.overdue_days || 0));
});

function focusScroll(id: string) {
  scrollTarget.value = '';
  // 先清空再赋值，保证重复点击同一个 tile 也能重新触发滚动
  setTimeout(() => { scrollTarget.value = id; }, 30);
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/leads/detail?id=${id}` });
}

onMounted(async () => {
  store.init();
  if (!store.isLoggedIn()) {
    uni.reLaunch({ url: '/pages/login/index' });
    return;
  }
  loading.value = true;
  try {
    summary.value = await get<Summary>('/api/dashboard/summary');
    await requestNotifyPermission();
    sendFollowUpReminder(summary.value.today.length, summary.value.overdue.length);
  } finally {
    loading.value = false;
  }
});

async function exportDashboard() {
  // #ifdef H5
  try {
    const today = new Date().toISOString().slice(0, 10);
    await downloadFile('/api/export/dashboard', `dashboard_${today}.xlsx`);
  } catch {
    uni.showToast({ title: '导出失败，请重试', icon: 'none' });
  }
  // #endif
  // #ifndef H5
  uni.showToast({ title: '请在 H5 环境使用导出功能', icon: 'none' });
  // #endif
}

async function onRefresh() {
  loading.value = true;
  try {
    summary.value = await get<Summary>('/api/dashboard/summary');
    sendFollowUpReminder(summary.value.today.length, summary.value.overdue.length);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <view class="dashboard-page">

    <!-- 精简头部：问候 + 日期 + 本周新增（弱化）+ 导出 -->
    <view class="head-bar">
      <view class="head-greet-wrap">
        <text class="head-greet">早，{{ store.userInfo?.name }}</text>
        <text class="head-date">{{ todayLabel }}</text>
      </view>
      <view class="head-actions">
        <view class="week-pill"><text>本周新增 {{ summary?.week_new ?? 0 }}</text></view>
        <view class="export-btn" @click="exportDashboard"><text class="export-txt">导出</text></view>
      </view>
    </view>

    <scroll-view
      class="dash-scroll"
      scroll-y
      refresher-enabled
      :refresher-triggered="loading"
      @refresherrefresh="onRefresh"
      :scroll-into-view="scrollTarget"
      scroll-with-animation
    >
      <view v-if="loading && !summary" class="loading-state">
        <text>加载中...</text>
      </view>

      <template v-else-if="summary">

        <!-- 焦点行：今日待跟进 / 已逾期，可点击定位到对应清单 -->
        <view class="focus-row">
          <view class="focus-tile focus-warn" @click="focusScroll('sec-today')">
            <text class="focus-num">{{ summary.today.length }}</text>
            <text class="focus-label">今日待跟进</text>
            <text class="focus-sub">{{ summary.today.length > 0 ? '点击查看名单 ›' : '今天没有安排' }}</text>
          </view>
          <view class="focus-tile focus-crit" @click="focusScroll('sec-overdue')">
            <text class="focus-num">{{ summary.overdue.length }}</text>
            <text class="focus-label">已逾期</text>
            <text class="focus-sub">{{ summary.overdue.length > 0 ? `最长 ${maxOverdueDays} 天 ›` : '暂无逾期' }}</text>
          </view>
        </view>

        <!-- 今日待跟进 -->
        <view id="sec-today" class="section" v-if="summary.today.length > 0">
          <view class="section-head">
            <text class="section-title">今日待跟进</text>
            <text class="section-count">{{ summary.today.length }} 条</text>
          </view>
          <view class="list-card">
            <view
              v-for="item in summary.today"
              :key="item.id"
              class="lead-row"
              @click="goDetail(item.id)"
            >
              <view class="row-dot dot-warn"></view>
              <view class="row-body">
                <text class="row-name">{{ item.company_name || item.contact_name }}</text>
                <text class="row-sub">{{ item.contact_name }}{{ item.owner_name ? ' · ' + item.owner_name : '' }}</text>
              </view>
              <text class="chevron">›</text>
            </view>
          </view>
        </view>

        <!-- 已逾期 -->
        <view id="sec-overdue" class="section" v-if="summary.overdue.length > 0">
          <view class="section-head">
            <text class="section-title">已逾期</text>
            <text class="section-count">{{ summary.overdue.length }} 条</text>
          </view>
          <view class="list-card">
            <view
              v-for="item in summary.overdue"
              :key="item.id"
              class="lead-row"
              @click="goDetail(item.id)"
            >
              <view class="row-dot dot-crit"></view>
              <view class="row-body">
                <text class="row-name">{{ item.company_name || item.contact_name }}</text>
                <text class="row-sub">{{ item.contact_name }}{{ item.owner_name ? ' · ' + item.owner_name : '' }}</text>
              </view>
              <view class="overdue-pill" :class="item.overdue_days >= 8 ? 'pill-hot' : ''">
                <text>{{ item.overdue_days }}天</text>
              </view>
            </view>
          </view>
        </view>

        <!-- 状态分布：单条分段色带 + 图例 -->
        <view class="section">
          <view class="section-head">
            <text class="section-title">状态分布</text>
            <text class="section-count">共 {{ funnelTotal }} 条</text>
          </view>
          <view class="list-card funnel-card">
            <view class="funnel-bar">
              <view
                v-for="s in STATUS_LIST"
                :key="s"
                :style="{ width: funnelSegPct(s) + '%', background: STATUS_COLORS[s] }"
              ></view>
            </view>
            <view class="funnel-legend">
              <view v-for="s in STATUS_LIST" :key="s" class="legend-item">
                <view class="legend-dot" :style="{ background: STATUS_COLORS[s] }"></view>
                <text class="legend-name">{{ s }}</text>
                <text class="legend-num">{{ summary.funnel[s] || 0 }}</text>
              </view>
            </view>
          </view>
        </view>

        <!-- 本月来源：排行榜 + 迷你进度条 -->
        <view class="section">
          <view class="section-head">
            <text class="section-title">本月来源效果</text>
          </view>
          <view v-if="rankedSources.length === 0" class="empty">本月暂无数据</view>
          <view v-else class="list-card">
            <view v-for="r in rankedSources" :key="r.source" class="src-row">
              <view class="src-top">
                <text class="src-name">{{ r.source }}</text>
                <text class="src-rate">{{ r.rate }}%</text>
              </view>
              <view class="src-track"><view class="src-fill" :style="{ width: r.barPct + '%' }"></view></view>
              <text class="src-meta">{{ r.lead_count }} 条线索 · {{ r.deal_count }} 成交</text>
            </view>
          </view>
        </view>

        <view class="list-bottom-spacer"></view>
      </template>
    </scroll-view>

    <CustomTabBar :current="1" />
  </view>
</template>

<style scoped>
.dashboard-page { height: 100vh; height: 100dvh; background: #f5f6f8; display: flex; flex-direction: column; }
.dash-scroll { flex: 1; min-height: 0; overflow: hidden; }
.list-bottom-spacer { height: var(--tabbar-safe-bottom); }
.loading-state { display: flex; align-items: center; justify-content: center; height: 160px; font-size: 14px; color: #94a3b8; }

/* ── 精简头部 ── */
.head-bar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 18px 16px 14px;
  background: #f5f6f8;
}
.head-greet-wrap { display: flex; flex-direction: column; gap: 3px; }
.head-greet { font-size: 19px; font-weight: 800; color: #1a1d23; letter-spacing: -0.01em; }
.head-date { font-size: 11.5px; color: #8a9099; }

.head-actions { display: flex; align-items: center; gap: 8px; }
.week-pill {
  font-size: 11px;
  font-weight: 700;
  color: var(--pd);
  background: var(--pl);
  padding: 5px 10px;
  border-radius: 100px;
  white-space: nowrap;
}
.export-btn {
  border: 1px solid #e2e5ea;
  border-radius: 100px;
  padding: 5px 11px;
  background: #fff;
}
.export-txt { font-size: 11px; color: #4b5259; font-weight: 600; }

/* ── 焦点行 ── */
.focus-row {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 0 16px 4px;
}
.focus-tile {
  border-radius: 18px;
  padding: 16px 16px 14px;
  display: flex;
  flex-direction: column;
}
.focus-warn { background: linear-gradient(155deg, #fff4e2, #ffe9cc); }
.focus-crit { background: linear-gradient(155deg, #ffe9e6, #ffd9d4); }
.focus-num { font-size: 34px; font-weight: 800; line-height: 1; }
.focus-warn .focus-num { color: #a3520b; }
.focus-crit .focus-num { color: #b0362a; }
.focus-label { font-size: 12.5px; font-weight: 700; margin-top: 6px; }
.focus-warn .focus-label { color: #8a4a10; }
.focus-crit .focus-label { color: #963029; }
.focus-sub { font-size: 10.5px; margin-top: 2px; opacity: 0.75; }
.focus-warn .focus-sub { color: #8a4a10; }
.focus-crit .focus-sub { color: #963029; }

/* ── 分区 ── */
.section { padding: 16px 16px 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.section-title { font-size: 14px; font-weight: 800; color: #1a1d23; }
.section-count { font-size: 11px; font-weight: 700; color: #8a9099; }

.list-card { background: #fff; border-radius: 16px; box-shadow: 0 1px 2px rgba(20,22,28,0.05); overflow: hidden; }

/* 线索行 */
.lead-row { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid #f0f1f3; }
.lead-row:last-child { border-bottom: none; }
.row-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot-warn { background: #dd9a3e; }
.dot-crit { background: #d2564a; }
.row-body { flex: 1; overflow: hidden; }
.row-name { display: block; font-size: 13.5px; font-weight: 700; color: #1a1d23; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sub { display: block; font-size: 11px; color: #8a9099; margin-top: 1px; }
.chevron { font-size: 18px; color: #d1d5db; flex-shrink: 0; }
.overdue-pill { background: #fdeceb; border-radius: 100px; padding: 3px 9px; flex-shrink: 0; }
.overdue-pill text { font-size: 10.5px; color: #b0362a; font-weight: 700; }
.overdue-pill.pill-hot { background: #fbe3e1; }
.overdue-pill.pill-hot text { color: #96271c; }

/* 状态分布：分段色带 + 图例 */
.funnel-card { padding: 14px; }
.funnel-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin-bottom: 12px; }
.funnel-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.legend-name { flex: 1; font-size: 12px; color: #4b5259; }
.legend-num { font-size: 12px; font-weight: 700; color: #1a1d23; }

/* 来源排行 */
.empty { text-align: center; font-size: 13px; color: #9ca3af; padding: 16px; background: #fff; border-radius: 16px; }
.src-row { padding: 10px 14px; border-bottom: 1px solid #f0f1f3; }
.src-row:last-child { border-bottom: none; }
.src-top { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.src-name { font-size: 13px; font-weight: 700; color: #1a1d23; }
.src-rate { font-size: 13px; font-weight: 800; color: var(--pd); }
.src-track { height: 6px; background: #f0f1f3; border-radius: 3px; overflow: hidden; margin-bottom: 5px; }
.src-fill { height: 100%; background: var(--p); border-radius: 3px; }
.src-meta { font-size: 10.5px; color: #a3a9b0; }
</style>
