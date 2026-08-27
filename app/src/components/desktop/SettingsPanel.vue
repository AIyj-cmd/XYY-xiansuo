<script setup lang="ts">
import { useUserStore } from '../../store/user';

const emit = defineEmits<{ logout: [] }>();
const store = useUserStore();
defineExpose({ setSearch: () => undefined });
</script>

<template>
  <view class="settings-panel">
    <view class="settings-grid">
      <view class="settings-card profile-card">
        <view class="avatar">{{ store.userInfo?.name?.slice(0,1) || '用' }}</view>
        <text class="profile-name">{{ store.userInfo?.name }}</text>
        <text class="profile-role">{{ store.isAdmin() ? '管理员' : '业务员' }}</text>
        <view class="profile-fields"><view><text class="field-label">用户名</text><text class="field-value">{{ store.userInfo?.username }}</text></view><view><text class="field-label">手机号</text><text class="field-value">{{ store.userInfo?.phone || '未填写' }}</text></view></view>
        <button class="logout-btn" @click="emit('logout')">退出当前账号</button>
      </view>

      <view class="settings-card">
        <text class="card-title">系统能力</text>
        <view class="setting-row"><view><text class="setting-name">桌面管理后台</text><text class="setting-copy">PC 表格、筛选、抽屉详情与批量操作</text></view><text class="state active">已启用</text></view>
        <view class="setting-row"><view><text class="setting-name">持久化 SQLite</text><text class="setting-copy">WAL、外键、完整性检查与每日备份</text></view><text class="state active">已启用</text></view>
        <view class="setting-row"><view><text class="setting-name">品牌与工商模块</text><text class="setting-copy">品牌、主体、分类、网址和线索多对多关系</text></view><text class="state active">已启用</text></view>
        <view class="setting-row"><view><text class="setting-name">公海认领</text><text class="setting-copy">最终状态由服务端环境变量控制</text></view><text class="state neutral">按配置</text></view>
        <view class="setting-row"><view><text class="setting-name">AI 与通知实验功能</text><text class="setting-copy">沿用原项目开关，默认关闭</text></view><text class="state neutral">按配置</text></view>
      </view>

      <view class="settings-card wide">
        <text class="card-title">角色权限摘要</text>
        <view class="permission-table"><view class="permission-row head"><text>功能</text><text>管理员</text><text>业务员</text></view><view class="permission-row"><text>品牌、工商、分类、网址增删改查</text><text class="yes">允许</text><text class="yes">允许</text></view><view class="permission-row"><text>本人线索编辑、删除、跟进与转移</text><text class="yes">允许</text><text class="yes">允许</text></view><view class="permission-row"><text>他人线索修改</text><text class="yes">允许</text><text class="no">禁止</text></view><view class="permission-row"><text>线索批量导入</text><text class="yes">允许</text><text class="no">禁止</text></view><view class="permission-row"><text>用户与角色管理</text><text class="yes">允许</text><text class="no">禁止</text></view></view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:360px 1fr;gap:16px;align-items:start}.settings-card{padding:22px;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 14px rgba(15,23,42,.03)}.profile-card{text-align:center}.avatar{width:68px;height:68px;margin:2px auto 12px;display:flex;align-items:center;justify-content:center;border-radius:20px;color:#fff;background:linear-gradient(145deg,#60a5fa,#2563eb);font-size:25px;font-weight:800;box-shadow:0 12px 24px rgba(37,99,235,.2)}.profile-name,.profile-role{display:block}.profile-name{font-size:16px;font-weight:800}.profile-role{margin-top:5px;color:#64748b;font-size:10px}.profile-fields{margin:20px 0;padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:10px;background:#f8fafc;border-radius:9px}.field-label,.field-value{display:block}.field-label{color:#94a3b8;font-size:9px}.field-value{margin-top:5px;font-size:10px;font-weight:700}.logout-btn{height:38px;width:100%;margin:0;color:#dc2626;background:#fff;border:1px solid #fecaca;border-radius:8px;font-size:11px;line-height:38px}.card-title{display:block;margin-bottom:12px;font-size:14px;font-weight:800}.setting-row{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #edf1f6}.setting-row:last-child{border-bottom:0}.setting-name,.setting-copy{display:block}.setting-name{font-size:11px;font-weight:700}.setting-copy{margin-top:4px;color:#94a3b8;font-size:9px}.state{padding:4px 8px;border-radius:11px;font-size:9px}.state.active{color:#15803d;background:#eaf8ef}.state.neutral{color:#64748b;background:#f1f5f9}.settings-card.wide{grid-column:1/-1}.permission-table{border:1px solid #e5eaf2;border-radius:9px;overflow:hidden}.permission-row{min-height:46px;padding:0 15px;display:grid;grid-template-columns:1.7fr .6fr .6fr;align-items:center;border-bottom:1px solid #edf1f6;font-size:10px}.permission-row:last-child{border-bottom:0}.permission-row.head{background:#f8fafc;color:#526078;font-weight:700}.yes{color:#15803d}.no{color:#dc2626}
</style>
