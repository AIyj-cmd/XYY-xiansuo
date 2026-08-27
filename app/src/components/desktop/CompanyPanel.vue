<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { del, get, patch, post } from '../../utils/request';

interface CompanyRow {
  id: number;
  name: string;
  unified_social_credit_code: string | null;
  legal_representative: string | null;
  registered_capital: string | null;
  registered_address: string | null;
  business_status: string | null;
  established_at: string | null;
  first_collected_at: string;
  brand_names: string | null;
  lead_count: number;
  resource_count: number;
  creator_name: string;
}
interface ResourceInput {
  id?: number;
  resource_type: 'official_website' | 'recruitment' | 'business_info' | 'ecommerce_shop' | 'other';
  platform: string;
  title: string;
  url: string;
  first_collected_at: string;
  note: string;
}

const emit = defineEmits<{ requestImport: []; openLead: [id: number] }>();
const loading = ref(false);
const submitting = ref(false);
const list = ref<CompanyRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const detail = ref<any>(null);
const showDrawer = ref(false);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const filters = ref({ keyword: '', business_status: '', collected_from: '', collected_to: '' });
const statusOptions = ['全部', '存续', '在业', '开业', '注销', '吊销', '迁出', '其他'];
const resourceTypes = [
  { label: '官网', value: 'official_website' },
  { label: '招聘信息', value: 'recruitment' },
  { label: '工商信息', value: 'business_info' },
  { label: '电商店铺', value: 'ecommerce_shop' },
  { label: '其他', value: 'other' },
] as const;

function today() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
function emptyResource(): ResourceInput { return { resource_type: 'business_info', platform: '', title: '', url: '', first_collected_at: today(), note: '' }; }

const form = ref({
  name: '', unified_social_credit_code: '', legal_representative: '', registered_capital: '', registered_address: '',
  business_status: '', established_at: '', business_scope: '', description: '', first_collected_at: today(),
  resources: [] as ResourceInput[],
});
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function resourceLabel(value: string) { return resourceTypes.find((item) => item.value === value)?.label || '其他'; }

async function load(reset = false) {
  if (reset) page.value = 1;
  loading.value = true;
  try {
    const result = await get<{ total: number; list: CompanyRow[] }>('/api/companies', {
      page: page.value, pageSize,
      keyword: filters.value.keyword || undefined,
      business_status: filters.value.business_status || undefined,
      collected_from: filters.value.collected_from || undefined,
      collected_to: filters.value.collected_to || undefined,
    });
    list.value = result.list;
    total.value = result.total;
  } finally { loading.value = false; }
}

function resetFilters() {
  filters.value = { keyword: '', business_status: '', collected_from: '', collected_to: '' };
  load(true);
}

async function openDetail(id: number) {
  detail.value = await get<any>(`/api/companies/${id}`);
  showDrawer.value = true;
}

function openCreate() {
  editingId.value = null;
  form.value = {
    name: '', unified_social_credit_code: '', legal_representative: '', registered_capital: '', registered_address: '',
    business_status: '', established_at: '', business_scope: '', description: '', first_collected_at: today(), resources: [emptyResource()],
  };
  showForm.value = true;
}

async function openEdit(id: number) {
  const data = await get<any>(`/api/companies/${id}`);
  editingId.value = id;
  form.value = {
    name: data.name || '', unified_social_credit_code: data.unified_social_credit_code || '', legal_representative: data.legal_representative || '',
    registered_capital: data.registered_capital || '', registered_address: data.registered_address || '', business_status: data.business_status || '',
    established_at: data.established_at || '', business_scope: data.business_scope || '', description: data.description || '',
    first_collected_at: data.first_collected_at || today(),
    resources: (data.resources || []).map((item: any) => ({
      id: Number(item.id), resource_type: item.resource_type, platform: item.platform || '', title: item.title || '', url: item.url || '',
      first_collected_at: item.first_collected_at || today(), note: item.note || '',
    })),
  };
  if (!form.value.resources.length) form.value.resources.push(emptyResource());
  showDrawer.value = false;
  showForm.value = true;
}

function addResource() { form.value.resources.push(emptyResource()); }
function removeResource(index: number) { form.value.resources.splice(index, 1); }
function setResourceType(index: number, event: { detail: { value: string } }) {
  const item = resourceTypes[Number(event.detail.value)];
  if (item) form.value.resources[index].resource_type = item.value;
}

async function save() {
  if (!form.value.name.trim()) { uni.showToast({ title: '请填写工商主体名称', icon: 'none' }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.first_collected_at)) { uni.showToast({ title: '首次采集时间格式错误', icon: 'none' }); return; }
  if (form.value.established_at && !/^\d{4}-\d{2}-\d{2}$/.test(form.value.established_at)) { uni.showToast({ title: '成立日期格式错误', icon: 'none' }); return; }
  const payload = {
    name: form.value.name.trim(),
    unified_social_credit_code: form.value.unified_social_credit_code.trim() || undefined,
    legal_representative: form.value.legal_representative.trim() || undefined,
    registered_capital: form.value.registered_capital.trim() || undefined,
    registered_address: form.value.registered_address.trim() || undefined,
    business_status: form.value.business_status.trim() || undefined,
    established_at: form.value.established_at || undefined,
    business_scope: form.value.business_scope.trim() || undefined,
    description: form.value.description.trim() || undefined,
    first_collected_at: form.value.first_collected_at,
    resources: form.value.resources.filter((item) => item.url.trim()).map((item) => ({
      ...(item.id ? { id: item.id } : {}), resource_type: item.resource_type,
      platform: item.platform.trim() || undefined, title: item.title.trim() || undefined,
      url: item.url.trim(), first_collected_at: item.first_collected_at || form.value.first_collected_at,
      note: item.note.trim() || undefined,
    })),
  };
  submitting.value = true;
  try {
    if (editingId.value) await patch(`/api/companies/${editingId.value}`, payload);
    else await post('/api/companies', payload);
    uni.showToast({ title: editingId.value ? '工商主体已更新' : '工商主体已创建', icon: 'success' });
    showForm.value = false;
    await load();
  } finally { submitting.value = false; }
}

async function removeCompany(id: number) {
  uni.showModal({
    title: '删除工商主体', content: '仅软删除工商主体，不会删除品牌、线索或网址。确认继续？',
    success: async (result) => {
      if (!result.confirm) return;
      await del(`/api/companies/${id}`);
      uni.showToast({ title: '工商主体已删除', icon: 'success' });
      showDrawer.value = false;
      await load();
    },
  });
}

function openExternal(url: string) {
  // #ifdef H5
  window.open(url, '_blank', 'noopener,noreferrer');
  // #endif
  // #ifndef H5
  uni.setClipboardData({ data: url });
  // #endif
}

function goPage(next: number) {
  if (next < 1 || next > pageCount.value || next === page.value) return;
  page.value = next; load();
}
function setSearch(value: string) { filters.value.keyword = value; load(true); }

onMounted(() => load(true));
defineExpose({ openCreate, setSearch, refresh: load });
</script>

<template>
  <view class="company-panel">
    <view class="filter-card">
      <view class="filter-item keyword"><text class="filter-label">关键词搜索</text><input v-model="filters.keyword" class="field" placeholder="企业名称 / 信用代码 / 法人 / 地址" confirm-type="search" @confirm="load(true)" /></view>
      <view class="filter-item"><text class="filter-label">经营状态</text><picker :range="statusOptions" @change="(e:any) => { filters.business_status = e.detail.value === 0 ? '' : statusOptions[e.detail.value]; load(true) }"><view class="field select">{{ filters.business_status || '全部' }}<text>⌄</text></view></picker></view>
      <view class="filter-item date"><text class="filter-label">首次采集时间</text><view class="date-range"><input v-model="filters.collected_from" class="date-input" placeholder="开始日期" /><text>~</text><input v-model="filters.collected_to" class="date-input" placeholder="结束日期" /></view></view>
      <view class="filter-actions"><button class="btn ghost" @click="resetFilters">重置</button><button class="btn primary" @click="load(true)">查询</button></view>
    </view>

    <view class="table-card">
      <view class="table-head"><view><text class="card-title">工商主体列表</text><text class="card-sub">保存法人、注册资本、注册地址等结构化信息</text></view><view class="table-tools"><button class="small-btn" @click="emit('requestImport')">导入</button><button class="small-btn primary" @click="openCreate">＋ 新增工商主体</button></view></view>
      <scroll-view class="table-scroll" scroll-x>
        <view class="data-table">
          <view class="tr th"><text class="td name">企业名称</text><text class="td code">统一社会信用代码</text><text class="td legal">法定代表人</text><text class="td capital">注册资本</text><text class="td address">注册地址</text><text class="td status">经营状态</text><text class="td brands">关联品牌</text><text class="td count">线索</text><text class="td date">首次采集</text><text class="td actions">操作</text></view>
          <view v-if="!list.length && !loading" class="empty-row">暂无工商主体数据</view>
          <view v-for="row in list" :key="row.id" class="tr" @dblclick="openDetail(row.id)">
            <view class="td name"><text class="company-name">{{ row.name }}</text><text class="creator">录入：{{ row.creator_name || '-' }}</text></view>
            <text class="td code ellipsis">{{ row.unified_social_credit_code || '-' }}</text><text class="td legal">{{ row.legal_representative || '-' }}</text><text class="td capital">{{ row.registered_capital || '-' }}</text><text class="td address ellipsis">{{ row.registered_address || '-' }}</text><view class="td status"><text class="status-chip">{{ row.business_status || '未录入' }}</text></view><text class="td brands ellipsis">{{ row.brand_names || '尚未关联' }}</text><view class="td count"><text class="link" @click.stop="openDetail(row.id)">{{ row.lead_count }} 条</text></view><text class="td date">{{ row.first_collected_at }}</text><view class="td actions"><text class="action-link" @click.stop="openDetail(row.id)">查看</text><text class="action-link" @click.stop="openEdit(row.id)">编辑</text></view>
          </view>
        </view>
      </scroll-view>
      <view class="pagination"><text>共 {{ total }} 条</text><view class="pages"><button class="page-btn" :disabled="page<=1" @click="goPage(page-1)">‹</button><button v-for="n in Math.min(pageCount,5)" :key="n" class="page-btn" :class="{active:page===n}" @click="goPage(n)">{{ n }}</button><text v-if="pageCount>5">… {{ pageCount }}</text><button class="page-btn" :disabled="page>=pageCount" @click="goPage(page+1)">›</button></view></view>
    </view>

    <view v-if="showDrawer" class="drawer-mask" @click.self="showDrawer=false"><aside class="drawer"><view class="drawer-head"><view><text class="drawer-title">工商主体详情</text><text class="drawer-name">{{ detail?.name }}</text></view><text class="close" @click="showDrawer=false">×</text></view><scroll-view class="drawer-body" scroll-y>
      <view class="detail-section"><text class="section-title"><b>A</b> 工商信息</text><view class="detail-grid"><text class="key">企业名称</text><text class="value">{{ detail?.name }}</text><text class="key">信用代码</text><text class="value">{{ detail?.unified_social_credit_code || '-' }}</text><text class="key">法定代表人</text><text class="value">{{ detail?.legal_representative || '-' }}</text><text class="key">注册资本</text><text class="value">{{ detail?.registered_capital || '-' }}</text><text class="key">经营状态</text><text class="value">{{ detail?.business_status || '-' }}</text><text class="key">成立日期</text><text class="value">{{ detail?.established_at || '-' }}</text><text class="key">注册地址</text><text class="value full">{{ detail?.registered_address || '-' }}</text><text class="key">经营范围</text><text class="value full long">{{ detail?.business_scope || '-' }}</text></view></view>
      <view class="detail-section"><text class="section-title"><b>B</b> 关联品牌</text><view v-if="!detail?.brands?.length" class="section-empty">暂无关联品牌</view><view v-for="brand in detail?.brands || []" :key="`${brand.id}-${brand.relation_type}`" class="relation-card"><view><text class="relation-name">{{ brand.name }}</text><text class="relation-meta">{{ brand.english_name || '未录入英文名' }}</text></view><text class="relation-chip">{{ brand.relation_type }}</text></view></view>
      <view class="detail-section"><text class="section-title"><b>C</b> 网址资源</text><view v-if="!detail?.resources?.length" class="section-empty">暂无网址资源</view><view v-for="resource in detail?.resources || []" :key="resource.id" class="resource-row"><text class="resource-type">{{ resourceLabel(resource.resource_type) }}</text><view class="resource-main"><text class="resource-title">{{ resource.title || resource.platform || '未命名链接' }}</text><text class="resource-url" @click="openExternal(resource.url)">{{ resource.url }} ↗</text></view></view></view>
      <view class="detail-section"><text class="section-title"><b>D</b> 关联线索 ({{ detail?.leads?.length || 0 }})</text><view v-if="!detail?.leads?.length" class="section-empty">暂无关联线索</view><view v-for="lead in detail?.leads || []" :key="lead.id" class="lead-card" @click="emit('openLead',lead.id)"><view><text class="lead-title">{{ lead.company_name || lead.contact_name }}</text><text class="lead-meta">{{ lead.contact_name }} · {{ lead.owner_name || '无负责人' }}</text></view><text class="lead-status">{{ lead.status }}</text></view></view>
    </scroll-view><view class="drawer-actions"><button class="drawer-btn danger" @click="removeCompany(detail.id)">删除</button><button class="drawer-btn primary" @click="openEdit(detail.id)">编辑工商主体</button></view></aside></view>

    <view v-if="showForm" class="modal-mask" @click.self="showForm=false"><view class="modal"><view class="modal-head"><view><text class="modal-title">{{ editingId ? '编辑工商主体' : '新增工商主体' }}</text><text class="modal-sub">工商信息均可留空后补，企业名称与首次采集时间除外</text></view><text class="close" @click="showForm=false">×</text></view><scroll-view class="modal-body" scroll-y>
      <view class="form-section"><text class="form-section-title">工商基础信息</text><view class="form-grid"><label class="form-item required"><text>企业名称</text><input v-model="form.name" class="field" placeholder="请输入完整企业名称" /></label><label class="form-item"><text>统一社会信用代码</text><input v-model="form.unified_social_credit_code" class="field" placeholder="选填，填写后全局唯一" /></label><label class="form-item"><text>法定代表人</text><input v-model="form.legal_representative" class="field" placeholder="选填" /></label><label class="form-item"><text>注册资本</text><input v-model="form.registered_capital" class="field" placeholder="例如：500万元人民币" /></label><label class="form-item"><text>经营状态</text><input v-model="form.business_status" class="field" placeholder="存续 / 注销等" /></label><label class="form-item"><text>成立日期</text><input v-model="form.established_at" class="field" placeholder="YYYY-MM-DD" /></label><label class="form-item wide"><text>注册地址</text><input v-model="form.registered_address" class="field" placeholder="选填" /></label><label class="form-item"><text>首次采集时间</text><input v-model="form.first_collected_at" class="field" placeholder="YYYY-MM-DD" /></label><label class="form-item wide"><text>经营范围</text><textarea v-model="form.business_scope" class="textarea large" placeholder="选填" /></label><label class="form-item wide"><text>备注</text><textarea v-model="form.description" class="textarea" placeholder="选填" /></label></view></view>
      <view class="form-section"><view class="form-section-head"><text class="form-section-title">网址资源</text><button class="small-btn primary" @click="addResource">＋ 添加网址</button></view><view v-for="(resource,index) in form.resources" :key="resource.id || index" class="resource-editor"><picker :range="resourceTypes" range-key="label" @change="(e:any)=>setResourceType(index,e)"><view class="field select type-select">{{ resourceLabel(resource.resource_type) }}<text>⌄</text></view></picker><input v-model="resource.platform" class="field" placeholder="平台" /><input v-model="resource.title" class="field" placeholder="标题" /><input v-model="resource.url" class="field url" placeholder="https://..." /><input v-model="resource.first_collected_at" class="field" placeholder="YYYY-MM-DD" /><text class="remove-link" @click="removeResource(index)">删除</text></view></view>
    </scroll-view><view class="modal-actions"><button class="modal-btn ghost" @click="showForm=false">取消</button><button class="modal-btn primary" :disabled="submitting" @click="save">{{ submitting?'保存中...':'保存工商主体' }}</button></view></view></view>
    <view v-if="loading" class="loading-layer">加载中...</view>
  </view>
</template>

<style scoped>
.company-panel{position:relative}.filter-card{min-height:88px;padding:14px 16px;margin-bottom:16px;display:grid;grid-template-columns:minmax(280px,1.5fr) 180px minmax(310px,1.2fr) auto;gap:14px;align-items:end;background:#fff;border:1px solid var(--line);border-radius:12px}.filter-label{display:block;margin:0 0 7px 2px;color:#526078;font-size:11px;font-weight:700}.field{width:100%;height:38px;padding:0 11px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:12px}.field.select{display:flex;align-items:center;justify-content:space-between;line-height:38px}.date-range{height:38px;padding:0 8px;display:flex;align-items:center;gap:6px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe}.date-input{width:130px;height:34px;font-size:11px;text-align:center}.filter-actions{display:flex;gap:8px}.btn{height:38px;min-width:62px;padding:0 15px;margin:0;border-radius:7px;font-size:12px;line-height:38px}.btn.ghost{color:#526078;background:#fff;border:1px solid #dde4ee}.btn.primary,.small-btn.primary,.modal-btn.primary,.drawer-btn.primary{color:#fff;background:var(--p)}.table-card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}.table-head{height:66px;padding:0 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.card-title,.card-sub{display:block}.card-title{font-size:14px;font-weight:800}.card-sub{font-size:10px;color:#94a3b8;margin-top:4px}.table-tools{display:flex;gap:8px}.small-btn{height:32px;padding:0 12px;margin:0;border:1px solid #dce4f0;border-radius:7px;background:#fff;color:#526078;font-size:11px;line-height:32px}.data-table{min-width:1390px}.tr{min-height:60px;display:grid;grid-template-columns:200px 175px 95px 115px 245px 80px 180px 65px 105px 100px;align-items:center;border-bottom:1px solid #edf1f6}.tr:not(.th):hover{background:#f8fbff}.tr.th{min-height:44px;background:#f8fafc;color:#536176;font-size:11px;font-weight:700}.td{padding:10px 12px;font-size:11px;min-width:0}.company-name,.creator{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.company-name{font-size:12px;font-weight:700}.creator{font-size:9px;color:#94a3b8;margin-top:3px}.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.status-chip{padding:3px 8px;border-radius:11px;color:#15803d;background:#eaf8ef;font-size:9px}.link,.action-link{color:var(--p);cursor:pointer}.actions{display:flex;gap:13px}.empty-row{height:120px;display:flex;align-items:center;justify-content:center;color:#94a3b8}.pagination{height:60px;padding:0 18px;display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:11px}.pages{display:flex;align-items:center;gap:7px}.page-btn{width:30px;height:30px;padding:0;margin:0;border:1px solid #e0e6ef;border-radius:6px;background:#fff;color:#475569;font-size:11px;line-height:30px}.page-btn.active{color:#fff;background:var(--p);border-color:var(--p)}
.drawer-mask,.modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.28);z-index:100;display:flex;justify-content:flex-end}.drawer{width:530px;height:100%;display:flex;flex-direction:column;background:#fff;box-shadow:-15px 0 35px rgba(15,23,42,.12)}.drawer-head{min-height:92px;padding:20px 24px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}.drawer-title,.drawer-name{display:block}.drawer-title{font-size:17px;font-weight:800}.drawer-name{font-size:13px;font-weight:700;margin-top:10px}.close{font-size:27px;color:#64748b;cursor:pointer}.drawer-body{flex:1;min-height:0;padding:14px}.detail-section{margin-bottom:13px;padding:15px;background:#f9fbfe;border:1px solid #edf1f6;border-radius:10px}.section-title{display:flex;align-items:center;gap:7px;margin-bottom:13px;font-size:12px;font-weight:800}.section-title b{width:21px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#2563eb;background:#e6efff;font-size:11px}.detail-grid{display:grid;grid-template-columns:95px 1fr;gap:9px 10px}.key{color:#718096;font-size:10px}.value{font-size:11px;word-break:break-all}.value.full{grid-column:2}.value.long{white-space:pre-wrap;line-height:1.6}.section-empty{padding:18px;text-align:center;color:#94a3b8;font-size:10px}.relation-card,.lead-card{margin-top:8px;padding:11px;display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e8edf5;border-radius:8px}.relation-name,.relation-meta,.lead-title,.lead-meta{display:block}.relation-name,.lead-title{font-size:11px;font-weight:700}.relation-meta,.lead-meta{margin-top:4px;color:#94a3b8;font-size:9px}.relation-chip,.lead-status{padding:4px 8px;border-radius:12px;color:#2563eb;background:#edf4ff;font-size:9px}.lead-card{cursor:pointer}.resource-row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f6}.resource-type{width:65px;flex:0 0 65px;color:#526078;font-size:10px}.resource-main{min-width:0}.resource-title,.resource-url{display:block}.resource-title{font-size:11px;font-weight:700}.resource-url{margin-top:4px;color:var(--p);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.drawer-actions{height:68px;padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)}.drawer-btn{height:40px;padding:0 20px;margin:0;border-radius:8px;font-size:12px;line-height:40px}.drawer-btn.danger{color:#dc2626;background:#fff;border:1px solid #fecaca}
.modal-mask{align-items:center;justify-content:center;padding:30px}.modal{width:min(1050px,92vw);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(15,23,42,.22);overflow:hidden}.modal-head{min-height:76px;padding:18px 22px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}.modal-title,.modal-sub{display:block}.modal-title{font-size:18px;font-weight:800}.modal-sub{margin-top:5px;color:#94a3b8;font-size:10px}.modal-body{flex:1;min-height:0;padding:18px 22px}.form-section{margin-bottom:20px}.form-section-title{display:block;margin-bottom:12px;padding-left:9px;border-left:3px solid var(--p);font-size:13px;font-weight:800}.form-section-head{display:flex;align-items:center;justify-content:space-between}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.form-item>text{display:block;margin-bottom:7px;color:#526078;font-size:11px;font-weight:700}.form-item.required>text::after{content:' *';color:#dc2626}.form-item.wide{grid-column:1/-1}.textarea{width:100%;min-height:70px;padding:10px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:12px}.textarea.large{min-height:105px}.resource-editor{display:grid;grid-template-columns:105px 140px 150px minmax(250px,1fr) 115px 38px;gap:8px;align-items:center;margin-bottom:8px}.resource-editor .field,.type-select{height:34px;line-height:34px;font-size:10px}.remove-link{color:#dc2626;font-size:10px;cursor:pointer}.modal-actions{height:68px;padding:12px 22px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)}.modal-btn{height:40px;min-width:90px;padding:0 18px;margin:0;border-radius:8px;font-size:12px;line-height:40px}.modal-btn.ghost{color:#526078;background:#fff;border:1px solid #dce4ef}.loading-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);z-index:20;color:#64748b}
</style>
