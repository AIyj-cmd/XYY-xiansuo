<script setup lang="ts">
import { computed, ref } from 'vue';
import { useUserStore } from '../store/user';

export type DesktopModule = 'dashboard' | 'my-leads' | 'all-leads' | 'brands' | 'companies' | 'types' | 'import' | 'users' | 'settings';

const props = withDefaults(defineProps<{
  active: DesktopModule;
  title: string;
  subtitle?: string;
  searchPlaceholder?: string;
  searchValue?: string;
  primaryText?: string;
  secondaryText?: string;
  primaryVisible?: boolean;
  secondaryVisible?: boolean;
  busy?: boolean;
}>(), {
  subtitle: '',
  searchPlaceholder: '搜索当前模块',
  searchValue: '',
  primaryText: '新增',
  secondaryText: '导入数据',
  primaryVisible: false,
  secondaryVisible: false,
  busy: false,
});

const emit = defineEmits<{
  switch: [module: DesktopModule];
  search: [value: string];
  primary: [];
  secondary: [];
  logout: [];
}>();

const store = useUserStore();
const collapsed = ref(false);
const localSearch = computed({
  get: () => props.searchValue,
  set: (value: string) => emit('search', value),
});

const menus = computed<Array<{ key: DesktopModule; label: string; icon: string; adminOnly?: boolean }>>(() => [
  { key: 'dashboard', label: '工作台', icon: '⌂' },
  { key: 'my-leads', label: '我的线索', icon: '◎' },
  { key: 'all-leads', label: '全部线索', icon: '▦' },
  { key: 'brands', label: '品牌管理', icon: '◇' },
  { key: 'companies', label: '工商主体', icon: '▤' },
  { key: 'types', label: '品牌分类', icon: '⌘' },
  { key: 'import', label: '导入导出', icon: '⇅' },
  { key: 'users', label: '用户管理', icon: '♙', adminOnly: true },
  { key: 'settings', label: '系统设置', icon: '⚙' },
].filter((item) => !item.adminOnly || store.isAdmin()));

function submitSearch() {
  emit('search', localSearch.value.trim());
}
</script>

<template>
  <view class="admin-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="sidebar">
      <view class="brand-block">
        <view class="brand-mark">线</view>
        <view v-if="!collapsed" class="brand-copy">
          <text class="brand-name">线索管理系统</text>
          <text class="brand-caption">BRAND CRM</text>
        </view>
      </view>

      <view class="menu-list">
        <view
          v-for="item in menus"
          :key="item.key"
          class="menu-item"
          :class="{ active: active === item.key }"
          :title="collapsed ? item.label : ''"
          @click="emit('switch', item.key)"
        >
          <text class="menu-icon">{{ item.icon }}</text>
          <text v-if="!collapsed" class="menu-label">{{ item.label }}</text>
        </view>
      </view>

      <view class="sidebar-footer" @click="collapsed = !collapsed">
        <text class="collapse-icon">{{ collapsed ? '›' : '‹' }}</text>
        <text v-if="!collapsed">收起菜单</text>
      </view>
    </aside>

    <view class="workspace">
      <header class="topbar">
        <view class="breadcrumb-wrap">
          <text class="hamburger" @click="collapsed = !collapsed">☰</text>
          <text class="breadcrumb-muted">系统后台</text>
          <text class="breadcrumb-sep">/</text>
          <text class="breadcrumb-current">{{ title }}</text>
        </view>

        <view class="top-search">
          <input
            v-model="localSearch"
            class="top-search-input"
            :placeholder="searchPlaceholder"
            confirm-type="search"
            @confirm="submitSearch"
          />
          <text class="top-search-icon" @click="submitSearch">⌕</text>
        </view>

        <view class="top-actions">
          <button v-if="primaryVisible" class="top-btn primary" :disabled="busy" @click="emit('primary')">
            <text class="btn-plus">＋</text>{{ primaryText }}
          </button>
          <button v-if="secondaryVisible" class="top-btn secondary" :disabled="busy" @click="emit('secondary')">
            ⇧ {{ secondaryText }}
          </button>
          <view class="notification-dot-wrap"><text class="bell">♢</text><view class="notification-dot" /></view>
          <view class="user-menu">
            <view class="avatar">{{ store.userInfo?.name?.slice(0, 1) || '用' }}</view>
            <view v-if="!collapsed" class="user-copy">
              <text class="user-name">{{ store.userInfo?.name || '用户' }}</text>
              <text class="user-role">{{ store.isAdmin() ? '管理员' : '业务员' }}</text>
            </view>
            <text class="logout-link" @click.stop="emit('logout')">退出</text>
          </view>
        </view>
      </header>

      <view class="page-heading">
        <view>
          <text class="page-title">{{ title }}</text>
          <text v-if="subtitle" class="page-subtitle">{{ subtitle }}</text>
        </view>
        <slot name="heading-actions" />
      </view>

      <scroll-view class="content-scroll" scroll-y>
        <main class="content-inner">
          <slot />
        </main>
      </scroll-view>
    </view>
  </view>
</template>

<style scoped>
.admin-shell {
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  display: flex;
  overflow: hidden;
  background: var(--canvas);
  color: var(--text);
}

.sidebar {
  width: 220px;
  flex: 0 0 220px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid var(--line);
  box-shadow: 4px 0 18px rgba(15, 23, 42, 0.025);
  transition: width .18s ease, flex-basis .18s ease;
  z-index: 20;
}

.is-collapsed .sidebar {
  width: 72px;
  flex-basis: 72px;
}

.brand-block {
  height: 72px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  border-bottom: 1px solid #f0f3f8;
  overflow: hidden;
}

.brand-mark {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  background: linear-gradient(145deg, #1d4ed8, #3b82f6);
  box-shadow: 0 8px 18px rgba(37, 99, 235, .25);
}

.brand-copy { display: flex; flex-direction: column; min-width: 0; }
.brand-name { font-size: 16px; font-weight: 800; white-space: nowrap; }
.brand-caption { margin-top: 2px; color: #94a3b8; font-size: 9px; letter-spacing: 1.5px; }

.menu-list { flex: 1; padding: 16px 10px; overflow-y: auto; }
.menu-item {
  min-height: 46px;
  margin-bottom: 5px;
  padding: 0 14px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 13px;
  color: #526078;
  cursor: pointer;
  transition: .15s ease;
}
.menu-item:hover { background: #f7f9fc; color: var(--p); }
.menu-item.active {
  color: var(--p);
  background: linear-gradient(90deg, #eaf2ff, #f2f7ff);
  font-weight: 700;
  box-shadow: inset 3px 0 0 var(--p);
}
.menu-icon { width: 22px; flex: 0 0 22px; text-align: center; font-size: 18px; }
.menu-label { white-space: nowrap; font-size: 14px; }
.is-collapsed .menu-item { justify-content: center; padding: 0; }

.sidebar-footer {
  height: 60px;
  flex: 0 0 60px;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #64748b;
  cursor: pointer;
}
.collapse-icon {
  width: 22px;
  height: 22px;
  border: 1px solid #cbd5e1;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.workspace { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; }
.topbar {
  height: 72px;
  flex: 0 0 72px;
  display: grid;
  grid-template-columns: minmax(230px, 1fr) minmax(320px, 540px) minmax(430px, 1fr);
  align-items: center;
  gap: 22px;
  padding: 0 24px;
  background: rgba(255,255,255,.96);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 3px 12px rgba(15,23,42,.035);
  z-index: 10;
}
.breadcrumb-wrap { display: flex; align-items: center; gap: 9px; min-width: 0; }
.hamburger { color: #64748b; font-size: 20px; cursor: pointer; margin-right: 8px; }
.breadcrumb-muted { color: #94a3b8; white-space: nowrap; }
.breadcrumb-sep { color: #cbd5e1; }
.breadcrumb-current { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.top-search { height: 40px; position: relative; }
.top-search-input {
  width: 100%; height: 40px; padding: 0 42px 0 15px;
  border: 1px solid #dfe5ee; border-radius: 9px; background: #fafcff;
  font-size: 13px;
}
.top-search-input:focus { border-color: #93b4fb; background: #fff; box-shadow: 0 0 0 3px var(--ps); }
.top-search-icon { position: absolute; right: 14px; top: 8px; font-size: 21px; color: #94a3b8; cursor: pointer; }

.top-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.top-btn { height: 38px; padding: 0 16px; border-radius: 8px; font-size: 13px; line-height: 38px; margin: 0; }
.top-btn.primary { color: #fff; background: var(--p); box-shadow: 0 7px 15px rgba(37,99,235,.18); }
.top-btn.primary:active { background: var(--pd); }
.top-btn.secondary { color: var(--p); background: #fff; border: 1px solid #d9e2f2; }
.btn-plus { margin-right: 4px; font-size: 16px; }
.notification-dot-wrap { width: 36px; height: 38px; position: relative; display: flex; align-items: center; justify-content: center; }
.bell { color: #536176; font-size: 21px; }
.notification-dot { width: 6px; height: 6px; position: absolute; right: 6px; top: 7px; border: 2px solid #fff; border-radius: 50%; background: #ef4444; }
.user-menu { min-width: 155px; display: flex; align-items: center; gap: 9px; padding-left: 8px; }
.avatar { width: 34px; height: 34px; flex: 0 0 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; background: linear-gradient(145deg,#60a5fa,#1d4ed8); }
.user-copy { display: flex; flex-direction: column; min-width: 0; }
.user-name { max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; font-size: 12px; }
.user-role { color: #94a3b8; font-size: 10px; margin-top: 1px; }
.logout-link { margin-left: auto; color: #94a3b8; font-size: 11px; cursor: pointer; }
.logout-link:hover { color: var(--danger); }

.page-heading {
  min-height: 88px;
  flex: 0 0 auto;
  padding: 20px 28px 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.page-title { display: block; font-size: 23px; line-height: 1.25; font-weight: 800; letter-spacing: -.2px; }
.page-subtitle { display: block; margin-top: 6px; color: #7b879a; font-size: 12px; }
.content-scroll { flex: 1; min-height: 0; }
.content-inner { width: 100%; min-width: 1000px; padding: 0 28px 32px; }

@media (max-width: 1180px) {
  .topbar { grid-template-columns: 210px minmax(250px, 1fr) auto; gap: 12px; padding: 0 16px; }
  .top-btn.secondary { display: none; }
  .user-menu { min-width: 100px; }
  .user-copy { display: none; }
}
</style>
