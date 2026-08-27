<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { del, get, patch, post } from '../../utils/request';

interface BrandType {
  id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  brand_count: number;
  children?: BrandType[];
}

const loading = ref(false);
const list = ref<BrandType[]>([]);
const tree = ref<BrandType[]>([]);
const showForm = ref(false);
const editingId = ref<number | null>(null);
const form = ref({ name: '', parent_id: '' as string | number, sort_order: 0 });
const flattenedTree = computed(() => {
  const result: Array<BrandType & { depth: number; path: string }> = [];
  const walk = (nodes: BrandType[], depth: number, prefix: string) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix} / ${node.name}` : node.name;
      result.push({ ...node, depth, path });
      walk(node.children || [], depth + 1, path);
    }
  };
  walk(tree.value, 0, '');
  return result;
});

async function load() {
  loading.value = true;
  try {
    const data = await get<{ list: BrandType[]; tree: BrandType[] }>('/api/brand-types');
    list.value = data.list || [];
    tree.value = data.tree || [];
  } finally { loading.value = false; }
}

function openCreate(parentId?: number) {
  editingId.value = null;
  form.value = { name: '', parent_id: parentId || '', sort_order: 0 };
  showForm.value = true;
}

function openEdit(item: BrandType) {
  editingId.value = item.id;
  form.value = { name: item.name, parent_id: item.parent_id || '', sort_order: item.sort_order || 0 };
  showForm.value = true;
}

async function save() {
  if (!form.value.name.trim()) { uni.showToast({ title: '请填写分类名称', icon: 'none' }); return; }
  const payload = {
    name: form.value.name.trim(),
    parent_id: form.value.parent_id ? Number(form.value.parent_id) : null,
    sort_order: Number(form.value.sort_order || 0),
  };
  if (editingId.value) await patch(`/api/brand-types/${editingId.value}`, payload);
  else await post('/api/brand-types', payload);
  uni.showToast({ title: editingId.value ? '分类已更新' : '分类已创建', icon: 'success' });
  showForm.value = false;
  await load();
}

function remove(item: BrandType) {
  uni.showModal({
    title: '删除分类', content: `确认删除“${item.name}”？存在子分类或仍被品牌使用时，系统会拒绝删除。`,
    success: async (result) => {
      if (!result.confirm) return;
      await del(`/api/brand-types/${item.id}`);
      uni.showToast({ title: '分类已删除', icon: 'success' });
      await load();
    },
  });
}

function setParent(event: { detail: { value: string } }) {
  const index = Number(event.detail.value);
  form.value.parent_id = index === 0 ? '' : list.value.filter((item) => item.id !== editingId.value)[index - 1]?.id || '';
}

onMounted(load);
defineExpose({ openCreate, refresh: load, setSearch: () => undefined });
</script>

<template>
  <view class="type-panel">
    <view class="intro-card">
      <view><text class="intro-title">多级品牌分类</text><text class="intro-sub">品牌可以关联多个分类，分类本身支持父子层级。不会再用逗号分隔的字符串假装数据库关系。</text></view>
      <button class="primary-btn" @click="openCreate()">＋ 新增分类</button>
    </view>

    <view class="content-grid">
      <view class="tree-card">
        <view class="card-head"><text class="card-title">分类树</text><text class="card-count">{{ list.length }} 个分类</text></view>
        <view v-if="!flattenedTree.length && !loading" class="empty">暂无分类</view>
        <view v-for="item in flattenedTree" :key="item.id" class="tree-row" :style="{ paddingLeft: `${18 + item.depth * 24}px` }">
          <text class="tree-connector">{{ item.depth ? '└' : '●' }}</text>
          <view class="tree-main"><text class="tree-name">{{ item.name }}</text><text class="tree-path">{{ item.path }}</text></view>
          <text class="brand-count">{{ item.brand_count || 0 }} 个品牌</text>
          <view class="row-actions"><text @click="openCreate(item.id)">加子类</text><text @click="openEdit(item)">编辑</text><text class="danger" @click="remove(item)">删除</text></view>
        </view>
      </view>

      <view class="guide-card">
        <text class="guide-title">使用建议</text>
        <view class="guide-item"><text class="guide-index">1</text><view><text class="guide-name">先建立稳定大类</text><text class="guide-copy">例如“消费品 / 服装 / 女装”，避免把活动名称当分类。</text></view></view>
        <view class="guide-item"><text class="guide-index">2</text><view><text class="guide-name">品牌可多选</text><text class="guide-copy">一个品牌可以同时属于“女装”“电商品牌”“设计师品牌”。</text></view></view>
        <view class="guide-item"><text class="guide-index">3</text><view><text class="guide-name">删除有保护</text><text class="guide-copy">仍有子分类或品牌引用时，后台会拒绝删除，省得分类树突然少一截。</text></view></view>
      </view>
    </view>

    <view v-if="showForm" class="modal-mask" @click.self="showForm=false">
      <view class="modal">
        <view class="modal-head"><text class="modal-title">{{ editingId ? '编辑分类' : '新增分类' }}</text><text class="close" @click="showForm=false">×</text></view>
        <view class="modal-body">
          <label class="form-item required"><text>分类名称</text><input v-model="form.name" class="field" placeholder="请输入分类名称" /></label>
          <label class="form-item"><text>父级分类</text><picker :range="['作为顶级分类', ...list.filter(item => item.id !== editingId).map(item => item.name)]" @change="setParent"><view class="field select">{{ form.parent_id ? list.find(item => item.id === Number(form.parent_id))?.name || '请选择' : '作为顶级分类' }}<text>⌄</text></view></picker></label>
          <label class="form-item"><text>排序值</text><input v-model.number="form.sort_order" class="field" type="number" placeholder="数字越小越靠前" /></label>
        </view>
        <view class="modal-actions"><button class="ghost-btn" @click="showForm=false">取消</button><button class="primary-btn" @click="save">保存</button></view>
      </view>
    </view>
    <view v-if="loading" class="loading-layer">加载中...</view>
  </view>
</template>

<style scoped>
.type-panel{position:relative}.intro-card{min-height:92px;padding:20px 22px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(115deg,#fff,#f5f9ff);border:1px solid #dce7f7;border-radius:12px}.intro-title,.intro-sub{display:block}.intro-title{font-size:16px;font-weight:800}.intro-sub{margin-top:7px;color:#718096;font-size:11px}.primary-btn,.ghost-btn{height:38px;padding:0 16px;margin:0;border-radius:8px;font-size:12px;line-height:38px}.primary-btn{color:#fff;background:var(--p)}.ghost-btn{color:#526078;background:#fff;border:1px solid #dce4ef}.content-grid{display:grid;grid-template-columns:minmax(650px,1.5fr) minmax(300px,.65fr);gap:16px;align-items:start}.tree-card,.guide-card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}.card-head{height:62px;padding:0 19px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.card-title{font-size:14px;font-weight:800}.card-count{color:#94a3b8;font-size:10px}.tree-row{min-height:58px;padding-right:16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #edf1f6}.tree-row:last-child{border-bottom:0}.tree-row:hover{background:#f8fbff}.tree-connector{width:18px;color:#93b4fb;font-size:14px}.tree-main{flex:1;min-width:0}.tree-name,.tree-path{display:block}.tree-name{font-size:12px;font-weight:700}.tree-path{margin-top:3px;color:#94a3b8;font-size:9px}.brand-count{padding:4px 8px;border-radius:12px;color:#64748b;background:#f1f5f9;font-size:9px}.row-actions{display:flex;gap:12px;color:var(--p);font-size:10px;cursor:pointer}.row-actions .danger{color:#dc2626}.guide-card{padding:20px}.guide-title{display:block;margin-bottom:18px;font-size:14px;font-weight:800}.guide-item{display:flex;gap:12px;margin-bottom:20px}.guide-index{width:24px;height:24px;flex:0 0 24px;display:flex;align-items:center;justify-content:center;border-radius:7px;color:#2563eb;background:#edf4ff;font-size:11px;font-weight:800}.guide-name,.guide-copy{display:block}.guide-name{font-size:11px;font-weight:700}.guide-copy{margin-top:5px;color:#7b879a;font-size:10px;line-height:1.6}.empty{padding:50px;text-align:center;color:#94a3b8}.modal-mask{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.28)}.modal{width:480px;background:#fff;border-radius:13px;box-shadow:0 20px 60px rgba(15,23,42,.2);overflow:hidden}.modal-head{height:68px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.modal-title{font-size:16px;font-weight:800}.close{font-size:26px;color:#64748b;cursor:pointer}.modal-body{padding:20px}.form-item{display:block;margin-bottom:16px}.form-item>text{display:block;margin-bottom:7px;color:#526078;font-size:11px;font-weight:700}.form-item.required>text::after{content:' *';color:#dc2626}.field{width:100%;height:40px;padding:0 11px;border:1px solid #dde4ee;border-radius:7px;background:#fbfcfe;font-size:12px}.field.select{display:flex;align-items:center;justify-content:space-between;line-height:40px}.modal-actions{height:64px;padding:12px 20px;display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line)}.loading-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.55);z-index:20;color:#64748b}
</style>
