<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, patch, post } from '../../utils/request';
import { useUserStore } from '../../store/user';

interface UserRow {
  id: number;
  username: string;
  name: string;
  phone: string | null;
  role: 'admin' | 'member';
  is_active: number;
  created_at: string;
}

const store = useUserStore();
const loading = ref(false);
const users = ref<UserRow[]>([]);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const form = ref({ username: '', name: '', phone: '', password: '', role: 'member' as 'admin' | 'member', is_active: 1 });

async function load() {
  loading.value = true;
  try { users.value = await get<UserRow[]>('/api/users'); }
  finally { loading.value = false; }
}

function openCreate() {
  editingId.value = null;
  form.value = { username: '', name: '', phone: '', password: '', role: 'member', is_active: 1 };
  showForm.value = true;
}

function openEdit(item: UserRow) {
  editingId.value = item.id;
  form.value = { username: item.username, name: item.name, phone: item.phone || '', password: '', role: item.role, is_active: item.is_active };
  showForm.value = true;
}

async function save() {
  if (!form.value.name.trim()) { uni.showToast({ title: '请填写姓名', icon: 'none' }); return; }
  if (!editingId.value && !form.value.username.trim()) { uni.showToast({ title: '请填写用户名', icon: 'none' }); return; }
  if (!editingId.value && form.value.password.length < 6) { uni.showToast({ title: '密码至少6位', icon: 'none' }); return; }
  if (editingId.value) {
    await patch(`/api/users/${editingId.value}`, {
      name: form.value.name.trim(), phone: form.value.phone.trim() || undefined,
      role: form.value.role, is_active: form.value.is_active,
      password: form.value.password || undefined,
    });
  } else {
    await post('/api/users', {
      username: form.value.username.trim(), name: form.value.name.trim(), phone: form.value.phone.trim() || undefined,
      role: form.value.role, password: form.value.password,
    });
  }
  uni.showToast({ title: editingId.value ? '用户已更新' : '用户已创建', icon: 'success' });
  showForm.value = false;
  await load();
}

async function toggleActive(item: UserRow) {
  const target = item.is_active ? 0 : 1;
  uni.showModal({
    title: target ? '启用账号' : '停用账号',
    content: target ? `确认启用 ${item.name}？` : `确认停用 ${item.name}？该用户现有登录会失效。`,
    success: async (result) => {
      if (!result.confirm) return;
      await patch(`/api/users/${item.id}`, { is_active: target });
      await load();
    },
  });
}

onMounted(() => { if (store.isAdmin()) load(); });
defineExpose({ openCreate, refresh: load, setSearch: () => undefined });
</script>

<template>
  <view class="user-panel">
    <view v-if="!store.isAdmin()" class="forbidden">用户管理仅管理员可用。</view>
    <template v-else>
      <view class="overview"><view><text class="overview-title">账号与角色</text><text class="overview-copy">系统仅保留管理员和业务员两种角色。账号启停、角色变化与密码重置会在服务端立即生效。</text></view><button class="primary-btn" @click="openCreate">＋ 新增用户</button></view>
      <view class="table-card"><view class="tr th"><text class="td user">用户</text><text class="td username">登录名</text><text class="td phone">手机号</text><text class="td role">角色</text><text class="td status">状态</text><text class="td created">创建时间</text><text class="td actions">操作</text></view><view v-for="item in users" :key="item.id" class="tr"><view class="td user"><view class="avatar">{{ item.name.slice(0,1) }}</view><view><text class="name">{{ item.name }}</text><text v-if="item.id===store.userInfo?.id" class="self">当前账号</text></view></view><text class="td username">{{ item.username }}</text><text class="td phone">{{ item.phone||'-' }}</text><view class="td role"><text class="role-chip" :class="item.role">{{ item.role==='admin'?'管理员':'业务员' }}</text></view><view class="td status"><text class="status-chip" :class="item.is_active?'active':'inactive'">{{ item.is_active?'启用':'停用' }}</text></view><text class="td created">{{ item.created_at?.slice(0,16) }}</text><view class="td actions"><text class="action-link" @click="openEdit(item)">编辑</text><text class="action-link" :class="item.is_active?'danger':''" @click="toggleActive(item)">{{ item.is_active?'停用':'启用' }}</text></view></view><view v-if="!users.length&&!loading" class="empty">暂无用户</view></view>
    </template>

    <view v-if="showForm" class="modal-mask" @click.self="showForm=false"><view class="modal"><view class="modal-head"><text class="modal-title">{{ editingId?'编辑用户':'新增用户' }}</text><text class="close" @click="showForm=false">×</text></view><view class="modal-body"><label class="form-item required"><text>姓名</text><input v-model="form.name" class="field" /></label><label class="form-item required"><text>登录名</text><input v-model="form.username" class="field" :disabled="!!editingId" /></label><label class="form-item"><text>手机号</text><input v-model="form.phone" class="field" /></label><label class="form-item" :class="{required:!editingId}"><text>{{ editingId?'重置密码（不改请留空）':'初始密码' }}</text><input v-model="form.password" class="field" password /></label><label class="form-item"><text>角色</text><view class="choices"><text class="choice" :class="{active:form.role==='member'}" @click="form.role='member'">业务员</text><text class="choice" :class="{active:form.role==='admin'}" @click="form.role='admin'">管理员</text></view></label><label v-if="editingId" class="form-item"><text>账号状态</text><view class="choices"><text class="choice" :class="{active:form.is_active===1}" @click="form.is_active=1">启用</text><text class="choice danger-choice" :class="{active:form.is_active===0}" @click="form.is_active=0">停用</text></view></label></view><view class="modal-actions"><button class="ghost-btn" @click="showForm=false">取消</button><button class="primary-btn" @click="save">保存</button></view></view></view>
    <view v-if="loading" class="loading-layer">加载中...</view>
  </view>
</template>

<style scoped>
.user-panel{position:relative}.overview{min-height:88px;padding:18px 20px;margin-bottom:15px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(110deg,#fff,#f7faff);border:1px solid #dce7f7;border-radius:11px}.overview-title,.overview-copy{display:block}.overview-title{font-size:15px;font-weight:800}.overview-copy{margin-top:6px;color:#718096;font-size:10px}.primary-btn,.ghost-btn{height:38px;padding:0 16px;margin:0;border-radius:8px;font-size:11px;line-height:38px}.primary-btn{color:#fff;background:var(--p)}.ghost-btn{color:#526078;background:#fff;border:1px solid #dce4ef}.table-card{background:#fff;border:1px solid var(--line);border-radius:11px;overflow:hidden}.tr{min-height:62px;display:grid;grid-template-columns:210px 150px 150px 110px 100px 180px 130px;align-items:center;border-bottom:1px solid #edf1f6}.tr:not(.th):hover{background:#f8fbff}.tr.th{min-height:44px;background:#f8fafc;color:#536176;font-size:10px;font-weight:700}.td{padding:9px 14px;font-size:10px}.td.user{display:flex;align-items:center;gap:10px}.avatar{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:9px;color:#fff;background:linear-gradient(145deg,#60a5fa,#2563eb);font-weight:700}.name{font-size:11px;font-weight:700}.self{margin-left:7px;padding:3px 6px;border-radius:9px;color:#2563eb;background:#edf4ff;font-size:8px}.role-chip,.status-chip{padding:4px 8px;border-radius:11px;font-size:9px}.role-chip.admin{color:#7c3aed;background:#f3edff}.role-chip.member{color:#2563eb;background:#edf4ff}.status-chip.active{color:#15803d;background:#eaf8ef}.status-chip.inactive{color:#64748b;background:#f1f5f9}.actions{display:flex;gap:13px}.action-link{color:#2563eb;cursor:pointer}.action-link.danger{color:#dc2626}.empty,.forbidden{padding:60px;text-align:center;color:#94a3b8;background:#fff;border:1px solid var(--line);border-radius:11px}.modal-mask{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.28)}.modal{width:500px;background:#fff;border-radius:13px;box-shadow:0 20px 60px rgba(15,23,42,.2);overflow:hidden}.modal-head{height:68px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.modal-title{font-size:16px;font-weight:800}.close{font-size:26px;color:#64748b;cursor:pointer}.modal-body{padding:20px}.form-item{display:block;margin-bottom:15px}.form-item>text{display:block;margin-bottom:7px;color:#526078;font-size:10px;font-weight:700}.form-item.required>text::after{content:' *';color:#dc2626}.field{width:100%;height:39px;padding:0 11px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:11px}.choices{display:flex;gap:8px}.choice{padding:7px 12px;border:1px solid #dce4ef;border-radius:7px;color:#64748b;background:#fff;font-size:10px;cursor:pointer}.choice.active{color:#2563eb;border-color:#9ab9f7;background:#edf4ff}.danger-choice.active{color:#dc2626;border-color:#fca5a5;background:#fff0f0}.modal-actions{height:64px;padding:12px 20px;display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line)}.loading-layer{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);color:#64748b}
</style>
