<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { get } from '../../utils/request';

interface LeadSummary {
  today: Array<any>;
  overdue: Array<any>;
  week_new: number;
  funnel: Record<string, number>;
  month_by_source: Array<{ source: string; lead_count: number; deal_count: number }>;
}

interface BrandSummary {
  brands: number;
  companies: number;
  websites: number;
  ecommerce: number;
  recruitment: number;
  linked_leads: number;
}

const emit = defineEmits<{ openLead: [id: number]; openModule: [module: 'brands' | 'companies' | 'my-leads'] }>();
const loading = ref(false);
const leadSummary = ref<LeadSummary | null>(null);
const brandSummary = ref<BrandSummary | null>(null);
const statuses = ['新线索', '跟进中', '已报价', '已成交', '已流失', '暂搁置', '停止跟进'];

const funnelTotal = computed(() => statuses.reduce((sum, status) => sum + Number(leadSummary.value?.funnel?.[status] || 0), 0));
const sourceRanking = computed(() => {
  const rows = [...(leadSummary.value?.month_by_source || [])];
  const max = Math.max(1, ...rows.map((row) => Number(row.lead_count)));
  return rows.map((row) => ({
    ...row,
    percent: Math.round((Number(row.lead_count) / max) * 100),
    dealRate: Number(row.lead_count) ? Math.round((Number(row.deal_count) / Number(row.lead_count)) * 100) : 0,
  }));
});

async function load() {
  loading.value = true;
  try {
    const [lead, brand] = await Promise.all([
      get<LeadSummary>('/api/dashboard/summary'),
      get<BrandSummary>('/api/brand-domain/summary'),
    ]);
    leadSummary.value = lead;
    brandSummary.value = brand;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
defineExpose({ refresh: load });
</script>

<template>
  <view class="dashboard-panel">
    <view class="metric-grid">
      <view class="metric-card blue" @click="emit('openModule', 'my-leads')">
        <view class="metric-icon">⌁</view>
        <view><text class="metric-label">本周新增线索</text><text class="metric-number">{{ leadSummary?.week_new ?? 0 }}</text><text class="metric-foot">查看我的线索 ›</text></view>
      </view>
      <view class="metric-card orange">
        <view class="metric-icon">!</view>
        <view><text class="metric-label">今日待跟进</text><text class="metric-number">{{ leadSummary?.today?.length ?? 0 }}</text><text class="metric-foot">需要按时处理</text></view>
      </view>
      <view class="metric-card red">
        <view class="metric-icon">⌛</view>
        <view><text class="metric-label">已逾期</text><text class="metric-number">{{ leadSummary?.overdue?.length ?? 0 }}</text><text class="metric-foot">别让线索在角落长灰</text></view>
      </view>
      <view class="metric-card purple" @click="emit('openModule', 'brands')">
        <view class="metric-icon">◇</view>
        <view><text class="metric-label">品牌总数</text><text class="metric-number">{{ brandSummary?.brands ?? 0 }}</text><text class="metric-foot">{{ brandSummary?.linked_leads ?? 0 }} 条关联线索 ›</text></view>
      </view>
      <view class="metric-card green" @click="emit('openModule', 'companies')">
        <view class="metric-icon">▤</view>
        <view><text class="metric-label">工商主体</text><text class="metric-number">{{ brandSummary?.companies ?? 0 }}</text><text class="metric-foot">查看工商资料 ›</text></view>
      </view>
      <view class="metric-card cyan">
        <view class="metric-icon">↗</view>
        <view><text class="metric-label">网址资源</text><text class="metric-number">{{ (brandSummary?.websites ?? 0) + (brandSummary?.ecommerce ?? 0) + (brandSummary?.recruitment ?? 0) }}</text><text class="metric-foot">官网、招聘与店铺</text></view>
      </view>
    </view>

    <view class="dashboard-columns">
      <view class="left-column">
        <view class="panel-card">
          <view class="card-head"><view><text class="card-title">今日待跟进</text><text class="card-sub">按计划安排的线索</text></view><text class="count-pill warn">{{ leadSummary?.today?.length ?? 0 }}</text></view>
          <view v-if="!leadSummary?.today?.length" class="empty">今天没有待跟进任务</view>
          <view v-for="item in leadSummary?.today || []" :key="item.id" class="lead-row" @click="emit('openLead', item.id)">
            <view class="row-dot warn" />
            <view class="row-main"><text class="row-title">{{ item.company_name || item.contact_name }}</text><text class="row-meta">{{ item.contact_name }} · {{ item.owner_name || '暂无负责人' }}</text></view>
            <text class="row-status">{{ item.status }}</text><text class="chevron">›</text>
          </view>
        </view>

        <view class="panel-card">
          <view class="card-head"><view><text class="card-title">逾期线索</text><text class="card-sub">按逾期天数从高到低</text></view><text class="count-pill danger">{{ leadSummary?.overdue?.length ?? 0 }}</text></view>
          <view v-if="!leadSummary?.overdue?.length" class="empty">暂无逾期线索</view>
          <view v-for="item in (leadSummary?.overdue || []).slice(0, 12)" :key="item.id" class="lead-row" @click="emit('openLead', item.id)">
            <view class="row-dot danger" />
            <view class="row-main"><text class="row-title">{{ item.company_name || item.contact_name }}</text><text class="row-meta">{{ item.contact_name }} · {{ item.owner_name || '暂无负责人' }}</text></view>
            <text class="overdue-pill">逾期 {{ item.overdue_days }} 天</text><text class="chevron">›</text>
          </view>
        </view>
      </view>

      <view class="right-column">
        <view class="panel-card">
          <view class="card-head"><view><text class="card-title">线索状态分布</text><text class="card-sub">共 {{ funnelTotal }} 条有效线索</text></view></view>
          <view class="funnel-bar">
            <view v-for="status in statuses" :key="status" class="funnel-segment" :class="`s-${statuses.indexOf(status)}`" :style="{ width: funnelTotal ? `${(Number(leadSummary?.funnel?.[status] || 0) / funnelTotal) * 100}%` : '0%' }" />
          </view>
          <view class="legend-list">
            <view v-for="status in statuses" :key="status" class="legend-item"><view class="legend-dot" :class="`s-${statuses.indexOf(status)}`" /><text>{{ status }}</text><text class="legend-number">{{ leadSummary?.funnel?.[status] || 0 }}</text></view>
          </view>
        </view>

        <view class="panel-card">
          <view class="card-head"><view><text class="card-title">本月来源效果</text><text class="card-sub">线索数量与成交率</text></view></view>
          <view v-if="!sourceRanking.length" class="empty">本月暂无来源数据</view>
          <view v-for="row in sourceRanking" :key="row.source" class="source-row">
            <view class="source-top"><text class="source-name">{{ row.source }}</text><text class="source-count">{{ row.lead_count }} 条 · 成交率 {{ row.dealRate }}%</text></view>
            <view class="source-track"><view class="source-progress" :style="{ width: `${row.percent}%` }" /></view>
          </view>
        </view>
      </view>
    </view>

    <view v-if="loading" class="loading-mask">加载中...</view>
  </view>
</template>

<style scoped>
.dashboard-panel { position: relative; }
.metric-grid { display: grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap: 14px; margin-bottom: 18px; }
.metric-card { min-height: 122px; padding: 20px; display: flex; align-items: center; gap: 15px; border: 1px solid var(--line); border-radius: 13px; background: #fff; box-shadow: 0 5px 16px rgba(15,23,42,.035); cursor: default; }
.metric-card[style], .metric-card:hover { transform: translateY(-1px); }
.metric-icon { width: 44px; height: 44px; flex: 0 0 44px; display: flex; align-items: center; justify-content: center; border-radius: 14px; font-size: 23px; font-weight: 800; }
.metric-card.blue .metric-icon { color:#2563eb;background:#eaf2ff}.metric-card.orange .metric-icon{color:#d97706;background:#fff4df}.metric-card.red .metric-icon{color:#dc2626;background:#fff0f0}.metric-card.purple .metric-icon{color:#7c3aed;background:#f2edff}.metric-card.green .metric-icon{color:#16a34a;background:#eaf9ef}.metric-card.cyan .metric-icon{color:#0891b2;background:#e9f9fd}
.metric-label,.metric-number,.metric-foot{display:block}.metric-label{font-size:12px;color:#718096}.metric-number{font-size:27px;font-weight:800;line-height:1.25;margin-top:2px}.metric-foot{font-size:10px;color:#94a3b8;margin-top:4px}
.dashboard-columns { display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,.85fr);gap:18px;align-items:start}.left-column,.right-column{display:flex;flex-direction:column;gap:18px}
.panel-card{background:#fff;border:1px solid var(--line);border-radius:13px;box-shadow:0 5px 16px rgba(15,23,42,.03);overflow:hidden}.card-head{min-height:68px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #edf1f6}.card-title,.card-sub{display:block}.card-title{font-size:15px;font-weight:800}.card-sub{font-size:11px;color:#94a3b8;margin-top:3px}.count-pill{min-width:30px;height:25px;padding:0 9px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}.count-pill.warn{color:#b45309;background:#fff7e6}.count-pill.danger{color:#dc2626;background:#fff0f0}
.lead-row{min-height:62px;padding:10px 18px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #f0f3f7;cursor:pointer}.lead-row:last-child{border-bottom:0}.lead-row:hover{background:#f8fbff}.row-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%}.row-dot.warn{background:#f59e0b}.row-dot.danger{background:#ef4444}.row-main{flex:1;min-width:0}.row-title,.row-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-title{font-size:13px;font-weight:700}.row-meta{font-size:10px;color:#94a3b8;margin-top:3px}.row-status{font-size:10px;color:#64748b;background:#f1f5f9;padding:3px 7px;border-radius:12px}.overdue-pill{font-size:10px;color:#dc2626;background:#fff0f0;padding:4px 8px;border-radius:13px}.chevron{font-size:18px;color:#cbd5e1}
.funnel-bar{height:13px;margin:22px 20px 18px;border-radius:10px;overflow:hidden;display:flex;background:#eef2f7}.funnel-segment{height:100%}.s-0{background:#60a5fa}.s-1{background:#f59e0b}.s-2{background:#8b5cf6}.s-3{background:#22c55e}.s-4{background:#94a3b8}.s-5{background:#cbd5e1}.s-6{background:#fb923c}.legend-list{padding:0 20px 18px;display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}.legend-item{display:flex;align-items:center;gap:7px;color:#64748b;font-size:11px}.legend-dot{width:8px;height:8px;border-radius:50%}.legend-number{margin-left:auto;color:#172033;font-weight:700}
.source-row{padding:12px 20px;border-bottom:1px solid #f1f4f8}.source-row:last-child{border-bottom:0}.source-top{display:flex;align-items:center;justify-content:space-between;gap:15px}.source-name{font-size:12px;font-weight:700}.source-count{font-size:10px;color:#94a3b8}.source-track{height:5px;margin-top:8px;border-radius:8px;background:#edf2f7;overflow:hidden}.source-progress{height:100%;border-radius:8px;background:linear-gradient(90deg,#60a5fa,#2563eb)}.empty{padding:34px;text-align:center;color:#94a3b8;font-size:12px}.loading-mask{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);color:#64748b;z-index:5}
@media(max-width:1500px){.metric-grid{grid-template-columns:repeat(3,1fr)}}
</style>
