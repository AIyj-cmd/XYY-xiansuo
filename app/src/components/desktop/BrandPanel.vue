<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { del, get, patch, post } from '../../utils/request';

interface BrandSummary {
  brands: number;
  companies: number;
  websites: number;
  ecommerce: number;
  recruitment: number;
  linked_leads: number;
}
interface BrandRow {
  id: number;
  name: string;
  english_name: string | null;
  alias: string | null;
  description: string | null;
  status: 'active' | 'inactive';
  first_collected_at: string;
  type_names: string | null;
  company_names: string | null;
  website_count: number;
  recruitment_count: number;
  ecommerce_count: number;
  lead_count: number;
  creator_name: string;
}
interface BrandType { id: number; parent_id: number | null; name: string; sort_order: number; brand_count?: number; }
interface CompanyOption { id: number; name: string; legal_representative?: string | null; registered_capital?: string | null; }
interface ResourceInput {
  id?: number;
  resource_type: 'official_website' | 'recruitment' | 'business_info' | 'ecommerce_shop' | 'other';
  platform: string;
  title: string;
  url: string;
  first_collected_at: string;
  note: string;
}
interface CompanyRelation { company_id: number; relation_type: string; }

const emit = defineEmits<{ requestImport: []; openLead: [id: number] }>();
const loading = ref(false);
const submitting = ref(false);
const summary = ref<BrandSummary | null>(null);
const list = ref<BrandRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const types = ref<BrandType[]>([]);
const companies = ref<CompanyOption[]>([]);
const detail = ref<any>(null);
const showDrawer = ref(false);
const showForm = ref(false);
const editingId = ref<number | null>(null);

const tabs = [
  { label: '全部', value: 'all' },
  { label: '已关联线索', value: 'linked_leads' },
  { label: '缺少官网', value: 'missing_website' },
  { label: '缺少工商信息', value: 'missing_company' },
  { label: '有招聘信息', value: 'has_recruitment' },
] as const;
const resourceTypes = [
  { label: '官网', value: 'official_website' },
  { label: '招聘信息', value: 'recruitment' },
  { label: '工商信息', value: 'business_info' },
  { label: '电商店铺', value: 'ecommerce_shop' },
  { label: '其他', value: 'other' },
] as const;
const relationTypes = ['品牌所有方', '实际运营方', '招聘主体', '电商店铺主体', '经销代理方', '其他'];
const platformOptions = ['全部', '官网', '国家企业信用信息公示系统', '企查查', '天眼查', 'BOSS直聘', '猎聘', '智联招聘', '前程无忧', '天猫', '淘宝', '京东', '拼多多', '抖音电商', '快手', '小红书', '得物', '亚马逊', '独立站', '其他'];

const filters = ref({
  keyword: '',
  type_id: '',
  platform: '',
  collected_from: '',
  collected_to: '',
  tab: 'all',
});

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function emptyResource(type: ResourceInput['resource_type'] = 'official_website'): ResourceInput {
  return { resource_type: type, platform: '', title: '', url: '', first_collected_at: today(), note: '' };
}

const form = ref({
  name: '',
  english_name: '',
  alias: '',
  description: '',
  status: 'active' as 'active' | 'inactive',
  first_collected_at: today(),
  type_ids: [] as number[],
  company_relations: [] as CompanyRelation[],
  resources: [] as ResourceInput[],
});

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const selectedCompanyIds = computed(() => form.value.company_relations.map((item) => item.company_id));

function typePath(type: BrandType): string {
  const names = [type.name];
  const seen = new Set<number>([type.id]);
  let parentId = type.parent_id;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = types.value.find((item) => item.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parent_id;
  }
  return names.join(' / ');
}

function resourceLabel(value: string) {
  return resourceTypes.find((item) => item.value === value)?.label || '其他';
}

async function loadLookups() {
  const [typeResult, companyResult] = await Promise.all([
    get<{ list: BrandType[] }>('/api/brand-types'),
    get<{ list: CompanyOption[] }>('/api/companies', { page: 1, pageSize: 100 }),
  ]);
  types.value = typeResult.list || [];
  companies.value = companyResult.list || [];
}

async function load(reset = false) {
  if (reset) page.value = 1;
  loading.value = true;
  try {
    const [summaryResult, result] = await Promise.all([
      get<BrandSummary>('/api/brand-domain/summary'),
      get<{ total: number; list: BrandRow[] }>('/api/brands', {
        page: page.value,
        pageSize,
        keyword: filters.value.keyword || undefined,
        type_id: filters.value.type_id || undefined,
        platform: filters.value.platform || undefined,
        collected_from: filters.value.collected_from || undefined,
        collected_to: filters.value.collected_to || undefined,
        tab: filters.value.tab,
      }),
    ]);
    summary.value = summaryResult;
    list.value = result.list;
    total.value = result.total;
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  filters.value = { keyword: '', type_id: '', platform: '', collected_from: '', collected_to: '', tab: 'all' };
  load(true);
}

function setTab(value: string) {
  filters.value.tab = value;
  load(true);
}

function goPage(next: number) {
  if (next < 1 || next > pageCount.value || next === page.value) return;
  page.value = next;
  load();
}

async function openDetail(id: number) {
  detail.value = await get<any>(`/api/brands/${id}`);
  showDrawer.value = true;
}

function openCreate() {
  editingId.value = null;
  form.value = {
    name: '', english_name: '', alias: '', description: '', status: 'active', first_collected_at: today(),
    type_ids: [], company_relations: [], resources: [emptyResource('official_website')],
  };
  showForm.value = true;
}

async function openEdit(id: number) {
  const data = await get<any>(`/api/brands/${id}`);
  editingId.value = id;
  form.value = {
    name: data.name || '',
    english_name: data.english_name || '',
    alias: data.alias || '',
    description: data.description || '',
    status: data.status || 'active',
    first_collected_at: data.first_collected_at || today(),
    type_ids: (data.types || []).map((item: any) => Number(item.id)),
    company_relations: (data.companies || []).map((item: any) => ({ company_id: Number(item.id), relation_type: item.relation_type || '其他' })),
    resources: (data.resources || []).map((item: any) => ({
      id: Number(item.id), resource_type: item.resource_type, platform: item.platform || '', title: item.title || '',
      url: item.url || '', first_collected_at: item.first_collected_at || today(), note: item.note || '',
    })),
  };
  if (!form.value.resources.length) form.value.resources.push(emptyResource());
  showDrawer.value = false;
  showForm.value = true;
}

function toggleType(id: number) {
  const index = form.value.type_ids.indexOf(id);
  if (index >= 0) form.value.type_ids.splice(index, 1);
  else form.value.type_ids.push(id);
}

function toggleCompany(id: number) {
  const index = form.value.company_relations.findIndex((item) => item.company_id === id);
  if (index >= 0) form.value.company_relations.splice(index, 1);
  else form.value.company_relations.push({ company_id: id, relation_type: '实际运营方' });
}

function setCompanyRelation(index: number, event: { detail: { value: string } }) {
  form.value.company_relations[index].relation_type = relationTypes[Number(event.detail.value)] || '其他';
}

function addResource() {
  form.value.resources.push(emptyResource('ecommerce_shop'));
}

function removeResource(index: number) {
  form.value.resources.splice(index, 1);
}

function setResourceType(index: number, event: { detail: { value: string } }) {
  const item = resourceTypes[Number(event.detail.value)];
  if (item) form.value.resources[index].resource_type = item.value;
}

async function save() {
  if (!form.value.name.trim()) { uni.showToast({ title: '请填写品牌名称', icon: 'none' }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.first_collected_at)) { uni.showToast({ title: '首次采集时间格式错误', icon: 'none' }); return; }
  const invalidResource = form.value.resources.find((item) => item.url.trim() && !item.resource_type);
  if (invalidResource) { uni.showToast({ title: '网址资源类型不能为空', icon: 'none' }); return; }
  const resources = form.value.resources.filter((item) => item.url.trim()).map((item) => ({
    ...(item.id ? { id: item.id } : {}),
    resource_type: item.resource_type,
    platform: item.platform.trim() || undefined,
    title: item.title.trim() || undefined,
    url: item.url.trim(),
    first_collected_at: item.first_collected_at || form.value.first_collected_at,
    note: item.note.trim() || undefined,
  }));
  const payload = {
    name: form.value.name.trim(),
    english_name: form.value.english_name.trim() || undefined,
    alias: form.value.alias.trim() || undefined,
    description: form.value.description.trim() || undefined,
    status: form.value.status,
    first_collected_at: form.value.first_collected_at,
    type_ids: form.value.type_ids,
    company_relations: form.value.company_relations,
    resources,
  };
  submitting.value = true;
  try {
    if (editingId.value) await patch(`/api/brands/${editingId.value}`, payload);
    else await post('/api/brands', payload);
    uni.showToast({ title: editingId.value ? '品牌已更新' : '品牌已创建', icon: 'success' });
    showForm.value = false;
    await Promise.all([load(), loadLookups()]);
  } finally {
    submitting.value = false;
  }
}

async function removeBrand(id: number) {
  uni.showModal({
    title: '删除品牌', content: '品牌会进入软删除状态，已关联的线索不会被删除。确认继续？',
    success: async (result) => {
      if (!result.confirm) return;
      await del(`/api/brands/${id}`);
      uni.showToast({ title: '品牌已删除', icon: 'success' });
      showDrawer.value = false;
      await load();
    },
  });
}

function openExternal(url: string) {
  if (!url) return;
  // #ifdef H5
  window.open(url, '_blank', 'noopener,noreferrer');
  // #endif
  // #ifndef H5
  uni.setClipboardData({ data: url });
  // #endif
}

function setSearch(value: string) {
  filters.value.keyword = value;
  load(true);
}

onMounted(async () => {
  await Promise.all([loadLookups(), load(true)]);
});
defineExpose({ openCreate, setSearch, refresh: load });
</script>

<template>
  <view class="brand-panel">
    <view class="summary-grid">
      <view class="summary-card"><view class="summary-icon blue">◇</view><view><text class="summary-label">品牌总数</text><text class="summary-number">{{ summary?.brands ?? 0 }}</text><text class="summary-note">全公司共享维护</text></view></view>
      <view class="summary-card"><view class="summary-icon green">▤</view><view><text class="summary-label">工商主体</text><text class="summary-number">{{ summary?.companies ?? 0 }}</text><text class="summary-note">多对多关联</text></view></view>
      <view class="summary-card"><view class="summary-icon purple">◎</view><view><text class="summary-label">官网链接</text><text class="summary-number">{{ summary?.websites ?? 0 }}</text><text class="summary-note">已录入官网</text></view></view>
      <view class="summary-card"><view class="summary-icon orange">▣</view><view><text class="summary-label">电商店铺</text><text class="summary-number">{{ summary?.ecommerce ?? 0 }}</text><text class="summary-note">跨平台店铺</text></view></view>
    </view>

    <view class="filter-card">
      <view class="filter-item keyword"><text class="filter-label">关键词搜索</text><input v-model="filters.keyword" class="field" placeholder="搜索品牌名称 / 官网 / 店铺链接" confirm-type="search" @confirm="load(true)" /></view>
      <view class="filter-item"><text class="filter-label">品牌类型</text><picker :range="[{ id: '', name: '全部' }, ...types]" range-key="name" @change="(e:any) => { filters.type_id = String(e.detail.value === 0 ? '' : types[e.detail.value - 1]?.id || ''); load(true) }"><view class="field select">{{ filters.type_id ? typePath(types.find(t => String(t.id) === filters.type_id)!) : '全部' }}<text>⌄</text></view></picker></view>
      <view class="filter-item"><text class="filter-label">平台</text><picker :range="platformOptions" @change="(e:any) => { filters.platform = e.detail.value === 0 ? '' : platformOptions[e.detail.value]; load(true) }"><view class="field select">{{ filters.platform || '全部' }}<text>⌄</text></view></picker></view>
      <view class="filter-item date"><text class="filter-label">采集时间</text><view class="date-range"><input v-model="filters.collected_from" class="date-input" placeholder="开始日期" /><text>~</text><input v-model="filters.collected_to" class="date-input" placeholder="结束日期" /></view></view>
      <view class="filter-actions"><button class="btn ghost" @click="resetFilters">重置</button><button class="btn primary" @click="load(true)">查询</button></view>
    </view>

    <view class="table-card">
      <view class="tabs-row">
        <view v-for="tab in tabs" :key="tab.value" class="tab" :class="{ active: filters.tab === tab.value }" @click="setTab(tab.value)">{{ tab.label }}<text v-if="tab.value === 'all'"> ({{ total }})</text></view>
        <view class="table-tools"><button class="small-btn" @click="emit('requestImport')">导入</button><button class="small-btn primary" @click="openCreate">＋ 新增品牌</button></view>
      </view>

      <scroll-view class="table-scroll" scroll-x>
        <view class="data-table">
          <view class="tr th">
            <text class="td brand">品牌名称</text><text class="td type">品牌类型</text><text class="td company">关联工商主体</text><text class="td compact">官网</text><text class="td compact">招聘信息</text><text class="td store">电商店铺</text><text class="td compact">关联线索</text><text class="td owner">录入人</text><text class="td date">首次采集</text><text class="td actions">操作</text>
          </view>
          <view v-if="!list.length && !loading" class="empty-row">暂无品牌数据</view>
          <view v-for="row in list" :key="row.id" class="tr" @dblclick="openDetail(row.id)">
            <view class="td brand"><text class="brand-name">{{ row.name }}</text><text v-if="row.english_name" class="brand-en">{{ row.english_name }}</text><text v-if="row.status === 'inactive'" class="status-chip inactive">已停用</text></view>
            <text class="td type ellipsis">{{ row.type_names || '未分类' }}</text>
            <text class="td company ellipsis">{{ row.company_names || '尚未关联' }}</text>
            <view class="td compact"><text :class="row.website_count ? 'text-success' : 'text-warning'">{{ row.website_count ? `${row.website_count} 个` : '缺少官网' }}</text></view>
            <view class="td compact"><text :class="row.recruitment_count ? 'status-chip recruiting' : 'muted'">{{ row.recruitment_count ? '招聘中' : '暂无招聘' }}</text></view>
            <view class="td store"><text>{{ row.ecommerce_count ? `${row.ecommerce_count} 个店铺` : '暂未录入' }}</text></view>
            <view class="td compact"><text class="link" @click.stop="openDetail(row.id)">{{ row.lead_count }} 条线索</text></view>
            <text class="td owner">{{ row.creator_name || '-' }}</text><text class="td date">{{ row.first_collected_at }}</text>
            <view class="td actions"><text class="action-link" @click.stop="openDetail(row.id)">查看</text><text class="action-link" @click.stop="openEdit(row.id)">编辑</text><text class="action-link" @click.stop="openDetail(row.id)">关联线索</text></view>
          </view>
        </view>
      </scroll-view>

      <view class="pagination"><text>共 {{ total }} 条</text><view class="pages"><button class="page-btn" :disabled="page <= 1" @click="goPage(page - 1)">‹</button><button v-for="n in Math.min(pageCount, 5)" :key="n" class="page-btn" :class="{ active: page === n }" @click="goPage(n)">{{ n }}</button><text v-if="pageCount > 5">… {{ pageCount }}</text><button class="page-btn" :disabled="page >= pageCount" @click="goPage(page + 1)">›</button></view></view>
    </view>

    <view v-if="showDrawer" class="drawer-mask" @click.self="showDrawer = false">
      <aside class="drawer">
        <view class="drawer-head"><view><text class="drawer-title">品牌详情</text><text class="drawer-name">{{ detail?.name }}</text></view><text class="close" @click="showDrawer = false">×</text></view>
        <scroll-view class="drawer-body" scroll-y>
          <view class="detail-section"><text class="section-title"><b>A</b> 基础信息</text><view class="detail-grid"><text class="key">品牌名称</text><text class="value">{{ detail?.name }}</text><text class="key">英文名</text><text class="value">{{ detail?.english_name || '-' }}</text><text class="key">品牌类型</text><text class="value">{{ detail?.types?.map((t:any) => t.name).join(' / ') || '未分类' }}</text><text class="key">录入人</text><text class="value">{{ detail?.creator_name }}</text><text class="key">首次采集</text><text class="value">{{ detail?.first_collected_at }}</text><text class="key">备注</text><text class="value full">{{ detail?.description || '-' }}</text></view></view>
          <view class="detail-section"><text class="section-title"><b>B</b> 工商主体</text><view v-if="!detail?.companies?.length" class="section-empty">暂无关联工商主体</view><view v-for="company in detail?.companies || []" :key="`${company.id}-${company.relation_type}`" class="company-card"><view class="company-title-row"><text class="company-title">{{ company.name }}</text><text class="relation-chip">{{ company.relation_type }}</text></view><view class="detail-grid compact-grid"><text class="key">法定代表人</text><text class="value">{{ company.legal_representative || '-' }}</text><text class="key">注册资本</text><text class="value">{{ company.registered_capital || '-' }}</text><text class="key">注册地址</text><text class="value full">{{ company.registered_address || '-' }}</text></view></view></view>
          <view class="detail-section"><text class="section-title"><b>C</b> 网址资源</text><view v-if="!detail?.resources?.length" class="section-empty">暂无网址资源</view><view v-for="resource in detail?.resources || []" :key="resource.id" class="resource-row"><text class="resource-type">{{ resourceLabel(resource.resource_type) }}</text><view class="resource-main"><text class="resource-title">{{ resource.title || resource.platform || '未命名链接' }}</text><text class="resource-url" @click="openExternal(resource.url)">{{ resource.url }} ↗</text></view></view></view>
          <view class="detail-section"><view class="section-head-row"><text class="section-title"><b>D</b> 关联线索 ({{ detail?.leads?.length || 0 }})</text></view><view v-if="!detail?.leads?.length" class="section-empty">暂无关联线索，可在线索详情中建立关联</view><view v-for="lead in detail?.leads || []" :key="lead.id" class="lead-card" @click="emit('openLead', lead.id)"><view><text class="lead-title">{{ lead.company_name || lead.contact_name }}</text><text class="lead-meta">{{ lead.contact_name }} · {{ lead.source }} · {{ lead.owner_name || '无负责人' }}</text></view><text class="lead-status">{{ lead.status }}</text></view></view>
        </scroll-view>
        <view class="drawer-actions"><button class="drawer-btn danger" @click="removeBrand(detail.id)">删除</button><button class="drawer-btn primary" @click="openEdit(detail.id)">编辑品牌</button></view>
      </aside>
    </view>

    <view v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <view class="modal brand-modal">
        <view class="modal-head"><view><text class="modal-title">{{ editingId ? '编辑品牌' : '新增品牌' }}</text><text class="modal-sub">品牌、工商主体与网址均支持多对多关联</text></view><text class="close" @click="showForm = false">×</text></view>
        <scroll-view class="modal-body" scroll-y>
          <view class="form-section"><text class="form-section-title">基础信息</text><view class="form-grid"><label class="form-item required"><text>品牌名称</text><input v-model="form.name" class="field" placeholder="请输入品牌名称" /></label><label class="form-item"><text>英文名</text><input v-model="form.english_name" class="field" placeholder="选填" /></label><label class="form-item"><text>别名</text><input v-model="form.alias" class="field" placeholder="多个别名可用逗号分隔" /></label><label class="form-item"><text>首次采集时间</text><input v-model="form.first_collected_at" class="field" placeholder="YYYY-MM-DD" /></label><label class="form-item"><text>状态</text><view class="pill-group"><text class="choice-pill" :class="{ active: form.status === 'active' }" @click="form.status='active'">正常</text><text class="choice-pill" :class="{ active: form.status === 'inactive' }" @click="form.status='inactive'">停用</text></view></label><label class="form-item wide"><text>简介 / 备注</text><textarea v-model="form.description" class="textarea" placeholder="选填" /></label></view></view>
          <view class="form-section"><text class="form-section-title">品牌分类（可多选）</text><view class="choice-grid"><text v-for="type in types" :key="type.id" class="choice-pill" :class="{ active: form.type_ids.includes(type.id) }" @click="toggleType(type.id)">{{ typePath(type) }}</text></view></view>
          <view class="form-section"><text class="form-section-title">关联工商主体（可多选）</text><view class="company-selector"><view v-for="company in companies" :key="company.id" class="company-select-row" :class="{ selected: selectedCompanyIds.includes(company.id) }"><view class="company-check" @click="toggleCompany(company.id)"><text>{{ selectedCompanyIds.includes(company.id) ? '✓' : '' }}</text></view><view class="company-info" @click="toggleCompany(company.id)"><text class="company-name">{{ company.name }}</text><text class="company-sub">{{ company.legal_representative || '法人未录入' }} · {{ company.registered_capital || '注册资本未录入' }}</text></view><picker v-if="selectedCompanyIds.includes(company.id)" :range="relationTypes" @change="(e:any) => setCompanyRelation(form.company_relations.findIndex(r => r.company_id === company.id), e)"><view class="relation-select">{{ form.company_relations.find(r => r.company_id === company.id)?.relation_type }} ⌄</view></picker></view></view></view>
          <view class="form-section"><view class="form-section-head"><text class="form-section-title">网址资源</text><button class="small-btn primary" @click="addResource">＋ 添加网址</button></view><view v-if="!form.resources.length" class="section-empty">暂无网址资源</view><view v-for="(resource, index) in form.resources" :key="resource.id || index" class="resource-editor"><picker :range="resourceTypes" range-key="label" @change="(e:any) => setResourceType(index, e)"><view class="field select type-select">{{ resourceLabel(resource.resource_type) }} <text>⌄</text></view></picker><input v-model="resource.platform" class="field platform" placeholder="平台，如天猫/BOSS直聘" /><input v-model="resource.title" class="field title" placeholder="标题" /><input v-model="resource.url" class="field url" placeholder="https://..." /><input v-model="resource.first_collected_at" class="field resource-date" placeholder="YYYY-MM-DD" /><text class="remove-link" @click="removeResource(index)">删除</text></view></view>
        </scroll-view>
        <view class="modal-actions"><button class="modal-btn ghost" @click="showForm = false">取消</button><button class="modal-btn primary" :disabled="submitting" @click="save">{{ submitting ? '保存中...' : '保存品牌' }}</button></view>
      </view>
    </view>

    <view v-if="loading" class="loading-layer">加载中...</view>
  </view>
</template>

<style scoped>
.brand-panel{position:relative}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px}.summary-card{height:104px;padding:18px 20px;display:flex;align-items:center;gap:16px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 14px rgba(15,23,42,.035)}.summary-icon{width:48px;height:48px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:24px;font-weight:800}.summary-icon.blue{color:#2563eb;background:#eaf2ff}.summary-icon.green{color:#16a34a;background:#eaf9ef}.summary-icon.purple{color:#7c3aed;background:#f2edff}.summary-icon.orange{color:#ea580c;background:#fff1e8}.summary-label,.summary-number,.summary-note{display:block}.summary-label{font-size:11px;color:#718096}.summary-number{font-size:27px;font-weight:800;line-height:1.2;margin-top:2px}.summary-note{font-size:10px;color:#94a3b8;margin-top:3px}
.filter-card{min-height:88px;padding:14px 16px;margin-bottom:16px;display:grid;grid-template-columns:minmax(250px,1.5fr) minmax(160px,.85fr) minmax(150px,.8fr) minmax(300px,1.3fr) auto;gap:14px;align-items:end;background:#fff;border:1px solid var(--line);border-radius:12px}.filter-item{min-width:0}.filter-label{display:block;margin:0 0 7px 2px;color:#526078;font-size:11px;font-weight:700}.field{width:100%;height:38px;padding:0 11px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:12px}.field:focus{border-color:#93b4fb;background:#fff;box-shadow:0 0 0 3px var(--ps)}.field.select{display:flex;align-items:center;justify-content:space-between;color:#475569;line-height:38px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.date-range{height:38px;padding:0 8px;display:flex;align-items:center;gap:6px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe}.date-input{width:125px;height:34px;font-size:11px;text-align:center}.filter-actions{display:flex;gap:8px}.btn{height:38px;min-width:62px;padding:0 15px;margin:0;border-radius:7px;font-size:12px;line-height:38px}.btn.ghost{color:#526078;background:#fff;border:1px solid #dde4ee}.btn.primary,.small-btn.primary,.modal-btn.primary,.drawer-btn.primary{color:#fff;background:var(--p)}
.table-card{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 15px rgba(15,23,42,.028);overflow:hidden}.tabs-row{height:56px;padding:0 14px;display:flex;align-items:center;border-bottom:1px solid var(--line)}.tab{height:56px;padding:0 15px;display:flex;align-items:center;position:relative;color:#526078;font-size:12px;cursor:pointer}.tab.active{color:var(--p);font-weight:700}.tab.active::after{content:'';position:absolute;left:12px;right:12px;bottom:0;height:2px;background:var(--p);border-radius:2px}.table-tools{margin-left:auto;display:flex;gap:8px}.small-btn{height:32px;padding:0 12px;margin:0;border:1px solid #dce4f0;border-radius:7px;background:#fff;color:#526078;font-size:11px;line-height:32px}.table-scroll{width:100%}.data-table{min-width:1320px}.tr{min-height:58px;display:grid;grid-template-columns:145px 145px 225px 75px 90px 105px 80px 80px 105px 170px;align-items:center;border-bottom:1px solid #edf1f6}.tr:not(.th):hover{background:#f8fbff}.tr.th{min-height:44px;background:#f8fafc;color:#536176;font-size:11px;font-weight:700}.td{padding:10px 12px;font-size:11px;min-width:0}.td.brand{position:relative}.brand-name,.brand-en{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brand-name{font-size:12px;font-weight:700}.brand-en{margin-top:3px;color:#94a3b8;font-size:9px}.status-chip{display:inline-flex;padding:3px 7px;border-radius:12px;font-size:9px}.status-chip.inactive{position:absolute;right:8px;top:9px;color:#64748b;background:#eef2f7}.status-chip.recruiting{color:#15803d;background:#eaf8ef}.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.text-success{color:#16a34a}.text-warning{color:#ea580c}.muted{color:#94a3b8}.link,.action-link{color:var(--p);cursor:pointer}.actions{display:flex;gap:12px;white-space:nowrap}.action-link:hover{text-decoration:underline}.empty-row{height:120px;display:flex;align-items:center;justify-content:center;color:#94a3b8}.pagination{height:60px;padding:0 18px;display:flex;align-items:center;justify-content:space-between;color:#64748b;font-size:11px}.pages{display:flex;align-items:center;gap:7px}.page-btn{width:30px;height:30px;padding:0;margin:0;border:1px solid #e0e6ef;border-radius:6px;background:#fff;color:#475569;font-size:11px;line-height:30px}.page-btn.active{color:#fff;background:var(--p);border-color:var(--p)}
.drawer-mask,.modal-mask{position:fixed;inset:0;background:rgba(15,23,42,.28);z-index:100;display:flex;justify-content:flex-end}.drawer{width:510px;height:100%;display:flex;flex-direction:column;background:#fff;box-shadow:-15px 0 35px rgba(15,23,42,.12);animation:slideIn .18s ease}.drawer-head{min-height:92px;padding:20px 24px;display:flex;justify-content:space-between;border-bottom:1px solid var(--line)}.drawer-title,.drawer-name{display:block}.drawer-title{font-size:17px;font-weight:800}.drawer-name{font-size:14px;font-weight:700;margin-top:10px}.close{font-size:27px;color:#64748b;cursor:pointer}.drawer-body{flex:1;min-height:0;padding:14px}.detail-section{margin-bottom:13px;padding:15px;background:#f9fbfe;border:1px solid #edf1f6;border-radius:10px}.section-title{display:flex;align-items:center;gap:7px;margin-bottom:13px;font-size:12px;font-weight:800}.section-title b{width:21px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:#2563eb;background:#e6efff;font-size:11px}.detail-grid{display:grid;grid-template-columns:92px 1fr;gap:9px 10px}.key{color:#718096;font-size:10px}.value{font-size:11px;word-break:break-all}.value.full{grid-column:2}.company-card{padding:12px;margin-top:8px;background:#fff;border:1px solid #e8edf5;border-radius:8px}.company-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.company-title{font-size:11px;font-weight:700}.relation-chip{padding:3px 7px;border-radius:10px;color:#2563eb;background:#edf4ff;font-size:9px}.compact-grid{grid-template-columns:80px 1fr}.section-empty{padding:17px;text-align:center;color:#94a3b8;font-size:10px}.resource-row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f6}.resource-row:last-child{border-bottom:0}.resource-type{width:65px;flex:0 0 65px;color:#526078;font-size:10px}.resource-main{min-width:0}.resource-title,.resource-url{display:block}.resource-title{font-size:11px;font-weight:700}.resource-url{margin-top:4px;color:var(--p);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.lead-card{margin-top:8px;padding:11px;display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e8edf5;border-radius:8px;cursor:pointer}.lead-card:hover{border-color:#bdd2fa}.lead-title,.lead-meta{display:block}.lead-title{font-size:11px;font-weight:700}.lead-meta{margin-top:4px;color:#94a3b8;font-size:9px}.lead-status{padding:4px 8px;border-radius:12px;color:#2563eb;background:#edf4ff;font-size:9px}.drawer-actions{height:68px;padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)}.drawer-btn{height:40px;padding:0 20px;margin:0;border-radius:8px;font-size:12px;line-height:40px}.drawer-btn.danger{color:#dc2626;background:#fff;border:1px solid #fecaca}
.modal-mask{align-items:center;justify-content:center;padding:30px}.modal{max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(15,23,42,.22);overflow:hidden}.brand-modal{width:min(1040px,92vw)}.modal-head{min-height:76px;padding:18px 22px;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid var(--line)}.modal-title,.modal-sub{display:block}.modal-title{font-size:18px;font-weight:800}.modal-sub{margin-top:5px;color:#94a3b8;font-size:10px}.modal-body{flex:1;min-height:0;padding:18px 22px}.form-section{margin-bottom:20px}.form-section-title{display:block;margin-bottom:12px;padding-left:9px;border-left:3px solid var(--p);font-size:13px;font-weight:800}.form-section-head{display:flex;align-items:center;justify-content:space-between}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.form-item>text{display:block;margin-bottom:7px;color:#526078;font-size:11px;font-weight:700}.form-item.required>text::after{content:' *';color:#dc2626}.form-item.wide{grid-column:1/-1}.textarea{width:100%;min-height:76px;padding:10px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:12px}.pill-group,.choice-grid{display:flex;flex-wrap:wrap;gap:8px}.choice-pill{min-height:30px;padding:6px 11px;display:inline-flex;align-items:center;border:1px solid #dce4ef;border-radius:7px;background:#fff;color:#526078;font-size:10px;cursor:pointer}.choice-pill.active{color:#2563eb;border-color:#94b7fb;background:#edf4ff}.company-selector{max-height:230px;overflow-y:auto;border:1px solid #e4eaf2;border-radius:8px}.company-select-row{min-height:54px;padding:8px 11px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #edf1f6}.company-select-row:last-child{border-bottom:0}.company-select-row.selected{background:#f7faff}.company-check{width:18px;height:18px;flex:0 0 18px;display:flex;align-items:center;justify-content:center;border:1px solid #cbd5e1;border-radius:4px;color:#fff;background:#fff;cursor:pointer}.selected .company-check{border-color:var(--p);background:var(--p)}.company-info{flex:1;min-width:0;cursor:pointer}.company-name,.company-sub{display:block}.company-name{font-size:11px;font-weight:700}.company-sub{margin-top:3px;color:#94a3b8;font-size:9px}.relation-select{min-width:105px;padding:6px 9px;border:1px solid #dce4ef;border-radius:6px;color:#475569;font-size:9px}.resource-editor{display:grid;grid-template-columns:105px 145px 150px minmax(240px,1fr) 115px 38px;gap:8px;align-items:center;margin-bottom:8px}.type-select,.resource-editor .field{height:34px;line-height:34px;font-size:10px}.remove-link{color:#dc2626;font-size:10px;cursor:pointer}.modal-actions{height:68px;padding:12px 22px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line)}.modal-btn{height:40px;min-width:90px;padding:0 18px;margin:0;border-radius:8px;font-size:12px;line-height:40px}.modal-btn.ghost{color:#526078;background:#fff;border:1px solid #dce4ef}.loading-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);z-index:20;color:#64748b}@keyframes slideIn{from{transform:translateX(100%)}to{transform:none}}
@media(max-width:1400px){.summary-grid{grid-template-columns:repeat(2,1fr)}.filter-card{grid-template-columns:1.3fr .8fr .8fr 1.2fr}.filter-actions{grid-column:4;justify-self:end}.resource-editor{grid-template-columns:100px 130px 1fr 1fr 110px 35px}}
</style>
