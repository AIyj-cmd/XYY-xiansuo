<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import DesktopShell from '../../components/DesktopShellFixed.vue';
import DashboardPanel from '../../components/desktop/DashboardPanel.vue';
import LeadPanel from '../../components/desktop/LeadPanel.vue';
import BrandPanel from '../../components/desktop/BrandPanel.vue';
import CompanyPanel from '../../components/desktop/CompanyPanel.vue';
import TypePanel from '../../components/desktop/TypePanel.vue';
import ImportPanel from '../../components/desktop/ImportPanel.vue';
import UserPanel from '../../components/desktop/UserPanel.vue';
import SettingsPanel from '../../components/desktop/SettingsPanel.vue';
import { useUserStore } from '../../store/user';
import type { DesktopModule } from '../../types/desktop';

interface PanelRef {
  openCreate?: () => void;
  openBrandImport?: () => void;
  openLead?: (id: number) => Promise<void> | void;
  setSearch?: (value: string) => void;
  refresh?: () => Promise<void> | void;
}

const store = useUserStore();
const active = ref<DesktopModule>('dashboard');
const searchValue = ref('');
const dashboardRef = ref<PanelRef | null>(null);
const myLeadRef = ref<PanelRef | null>(null);
const allLeadRef = ref<PanelRef | null>(null);
const brandRef = ref<PanelRef | null>(null);
const companyRef = ref<PanelRef | null>(null);
const typeRef = ref<PanelRef | null>(null);
const importRef = ref<PanelRef | null>(null);
const userRef = ref<PanelRef | null>(null);

const meta: Record<DesktopModule, { title: string; subtitle: string; search: string; primary?: string; secondary?: string }> = {
  dashboard: { title: '工作台', subtitle: '汇总待跟进、逾期、线索漏斗与品牌数据', search: '搜索功能或数据' },
  'my-leads': { title: '我的线索', subtitle: '管理本人负责的线索、跟进计划与客户关系', search: '搜索公司 / 联系人 / 手机号', primary: '新增线索' },
  'all-leads': { title: '全部线索', subtitle: '查看全公司线索、公海状态和负责人分布', search: '搜索公司 / 联系人 / 手机号', primary: '新增线索' },
  brands: { title: '品牌管理', subtitle: '管理品牌、工商主体、官网、招聘信息与电商平台店铺', search: '搜索品牌名称 / 官网 / 店铺链接', primary: '新增品牌', secondary: '导入数据' },
  companies: { title: '工商主体', subtitle: '维护法定代表人、注册资本、注册地址与经营信息', search: '搜索企业名称 / 信用代码 / 法人', primary: '新增工商主体', secondary: '导入数据' },
  types: { title: '品牌分类', subtitle: '维护多级分类，一个品牌可以关联多个类型', search: '分类名称', primary: '新增分类' },
  import: { title: '导入导出', subtitle: '集中处理线索、品牌、工商主体与网址资源文件', search: '当前页面无需搜索' },
  users: { title: '用户管理', subtitle: '管理管理员和业务员账号、角色与启停状态', search: '用户姓名 / 登录名', primary: '新增用户' },
  settings: { title: '系统设置', subtitle: '查看当前账号、角色权限和系统能力状态', search: '当前页面无需搜索' },
};

const currentMeta = computed(() => meta[active.value]);
const activePanel = computed<PanelRef | null>(() => ({
  dashboard: dashboardRef.value,
  'my-leads': myLeadRef.value,
  'all-leads': allLeadRef.value,
  brands: brandRef.value,
  companies: companyRef.value,
  types: typeRef.value,
  import: importRef.value,
  users: userRef.value,
  settings: null,
}[active.value] || null));

function switchModule(module: DesktopModule) {
  if (module === 'users' && !store.isAdmin()) return;
  active.value = module;
  searchValue.value = '';
}
function handleSearch(value: string) { searchValue.value = value; activePanel.value?.setSearch?.(value); }
function handlePrimary() { activePanel.value?.openCreate?.(); }
async function handleSecondary() {
  if (active.value !== 'brands' && active.value !== 'companies') return;
  active.value = 'import';
  searchValue.value = '';
  await nextTick();
  importRef.value?.openBrandImport?.();
}
async function openLead(id: number) {
  active.value = 'all-leads';
  searchValue.value = '';
  await nextTick();
  allLeadRef.value?.openLead?.(id);
}
function logout() { store.logout(); uni.reLaunch({ url: '/pages/login/index' }); }

onMounted(() => {
  store.init();
  if (!store.isLoggedIn()) { uni.reLaunch({ url: '/pages/login/index' }); return; }
  const pages = getCurrentPages();
  const current = pages[pages.length - 1] as any;
  const options = current.$page?.options || current.options || {};
  const requested = options.module as DesktopModule | undefined;
  if (requested && meta[requested] && (requested !== 'users' || store.isAdmin())) active.value = requested;
});
</script>

<template>
  <DesktopShell :active="active" :title="currentMeta.title" :subtitle="currentMeta.subtitle" :search-placeholder="currentMeta.search" :search-value="searchValue" :primary-visible="!!currentMeta.primary" :secondary-visible="!!currentMeta.secondary" :primary-text="currentMeta.primary || '新增'" :secondary-text="currentMeta.secondary || '导入数据'" @switch="switchModule" @search="handleSearch" @primary="handlePrimary" @secondary="handleSecondary" @logout="logout">
    <DashboardPanel v-if="active==='dashboard'" ref="dashboardRef" @open-lead="openLead" @open-module="switchModule"/>
    <LeadPanel v-else-if="active==='my-leads'" ref="myLeadRef" scope="mine"/>
    <LeadPanel v-else-if="active==='all-leads'" ref="allLeadRef" scope="all"/>
    <BrandPanel v-else-if="active==='brands'" ref="brandRef" @request-import="switchModule('import')" @open-lead="openLead"/>
    <CompanyPanel v-else-if="active==='companies'" ref="companyRef" @request-import="switchModule('import')" @open-lead="openLead"/>
    <TypePanel v-else-if="active==='types'" ref="typeRef"/>
    <ImportPanel v-else-if="active==='import'" ref="importRef"/>
    <UserPanel v-else-if="active==='users'" ref="userRef"/>
    <SettingsPanel v-else @logout="logout"/>
  </DesktopShell>
</template>
