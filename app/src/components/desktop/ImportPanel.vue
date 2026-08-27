<script setup lang="ts">
import { ref } from 'vue';
import { downloadFile, uploadBrandImportFile, uploadImportFile } from '../../utils/file';
import { useUserStore } from '../../store/user';

const store = useUserStore();
const busy = ref(false);
const leadResult = ref<any>(null);
const brandResult = ref<any>(null);

function chooseFile(kind: 'lead' | 'brand') {
  // #ifdef H5
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.csv';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    busy.value = true;
    try {
      if (kind === 'lead') {
        const result = await uploadImportFile(file);
        leadResult.value = result.data;
      } else {
        const result = await uploadBrandImportFile(file);
        brandResult.value = result.data;
      }
      uni.showToast({ title: '导入完成', icon: 'success' });
    } catch (error) {
      uni.showToast({ title: error instanceof Error ? error.message : '导入失败', icon: 'none' });
    } finally { busy.value = false; }
  };
  input.click();
  // #endif
  // #ifndef H5
  uni.showToast({ title: '请在桌面浏览器中导入', icon: 'none' });
  // #endif
}

async function download(path: string, filename: string) {
  busy.value = true;
  try { await downloadFile(path, filename); }
  finally { busy.value = false; }
}

defineExpose({ openBrandImport: () => chooseFile('brand'), setSearch: () => undefined });
</script>

<template>
  <view class="import-panel">
    <view class="notice-card">
      <view class="notice-icon">i</view>
      <view><text class="notice-title">导入前先下载模板</text><text class="notice-copy">系统会校验重复手机号、品牌名称、工商主体名称和网址。数据不会因为一张列名随心所欲的表格而自动学会读心术。</text></view>
    </view>

    <view class="module-grid">
      <view class="module-card">
        <view class="module-head"><view class="module-icon blue">◎</view><view><text class="module-title">线索数据</text><text class="module-sub">沿用现有线索字段、状态与跟进规则</text></view></view>
        <view class="permission-note" :class="{ warning: !store.isAdmin() }">{{ store.isAdmin() ? '管理员可导入全量线索' : '业务员不可批量导入线索，可导出自己负责的数据' }}</view>
        <view class="action-list">
          <view class="action-row"><view><text class="action-name">下载线索导入模板</text><text class="action-copy">包含年份、日期、负责人、来源、联系人和跟进记录</text></view><button class="action-btn" :disabled="busy||!store.isAdmin()" @click="download('/api/import/template','leads_import_template.xlsx')">下载</button></view>
          <view class="action-row"><view><text class="action-name">导入线索 Excel / CSV</text><text class="action-copy">仅管理员可执行，重复手机号会跳过</text></view><button class="action-btn primary" :disabled="busy||!store.isAdmin()" @click="chooseFile('lead')">选择文件</button></view>
          <view class="action-row"><view><text class="action-name">导出线索与跟进记录</text><text class="action-copy">管理员导出全量，业务员仅导出本人数据</text></view><button class="action-btn" :disabled="busy" @click="download('/api/export',`leads_${new Date().toISOString().slice(0,10)}.xlsx`)">导出</button></view>
        </view>
        <view v-if="leadResult" class="result-box"><text class="result-title">最近一次线索导入</text><view class="result-stats"><text>成功 {{ leadResult.success }}</text><text>跳过 {{ leadResult.skipped }}</text><text>警告 {{ leadResult.warnings || 0 }}</text></view><view v-for="item in (leadResult.skipped_details || []).slice(0,8)" :key="`${item.row}-${item.reason}`" class="result-line">第 {{ item.row }} 行：{{ item.reason }}</view></view>
      </view>

      <view class="module-card">
        <view class="module-head"><view class="module-icon purple">◇</view><view><text class="module-title">品牌与工商数据</text><text class="module-sub">管理员和业务员均可导入、导出</text></view></view>
        <view class="permission-note success">品牌域为全公司共享数据，两种角色都可维护</view>
        <view class="action-list">
          <view class="action-row"><view><text class="action-name">下载品牌导入模板</text><text class="action-copy">包含品牌、分类、工商字段、官网、招聘和店铺链接</text></view><button class="action-btn" :disabled="busy" @click="download('/api/brand-domain/import-template','brand_domain_import_template.xlsx')">下载</button></view>
          <view class="action-row"><view><text class="action-name">导入品牌与工商数据</text><text class="action-copy">按品牌名、工商主体名和网址自动复用已有记录</text></view><button class="action-btn primary" :disabled="busy" @click="chooseFile('brand')">选择文件</button></view>
          <view class="action-row"><view><text class="action-name">导出品牌域数据</text><text class="action-copy">生成品牌、工商主体和网址资源三个工作表</text></view><button class="action-btn" :disabled="busy" @click="download('/api/brand-domain/export',`brand_domain_${new Date().toISOString().slice(0,10)}.xlsx`)">导出</button></view>
        </view>
        <view v-if="brandResult" class="result-box"><text class="result-title">最近一次品牌导入</text><view class="result-stats"><text>成功 {{ brandResult.success }}</text><text>失败 {{ brandResult.failed }}</text></view><view v-for="item in (brandResult.errors || []).slice(0,8)" :key="`${item.row}-${item.reason}`" class="result-line">第 {{ item.row }} 行：{{ item.reason }}</view></view>
      </view>
    </view>

    <view class="rules-card">
      <text class="rules-title">导入约束</text>
      <view class="rule-grid"><view class="rule"><text class="rule-index">1</text><view><text class="rule-name">线索查重</text><text class="rule-copy">手机号填写后全局唯一；手机号和微信号至少填写一项。</text></view></view><view class="rule"><text class="rule-index">2</text><view><text class="rule-name">品牌与主体查重</text><text class="rule-copy">品牌名、企业名采用忽略大小写的唯一约束，信用代码填写后唯一。</text></view></view><view class="rule"><text class="rule-index">3</text><view><text class="rule-name">网址共享</text><text class="rule-copy">同一网址可同时关联多个品牌或工商主体，不会重复制造数据。</text></view></view><view class="rule"><text class="rule-index">4</text><view><text class="rule-name">逐行事务</text><text class="rule-copy">单行失败只回滚该行，其余合法数据继续导入并生成错误报告。</text></view></view></view>
    </view>
    <view v-if="busy" class="loading-layer">处理中...</view>
  </view>
</template>

<style scoped>
.import-panel{position:relative}.notice-card{min-height:78px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:center;gap:14px;background:#f7faff;border:1px solid #dce7f7;border-radius:11px}.notice-icon{width:30px;height:30px;flex:0 0 30px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:#2563eb;background:#e6efff;font-weight:800}.notice-title,.notice-copy{display:block}.notice-title{font-size:13px;font-weight:800}.notice-copy{margin-top:5px;color:#718096;font-size:10px}.module-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}.module-card,.rules-card{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 14px rgba(15,23,42,.03);overflow:hidden}.module-head{height:82px;padding:0 20px;display:flex;align-items:center;gap:13px;border-bottom:1px solid var(--line)}.module-icon{width:42px;height:42px;display:flex;align-items:center;justify-content:center;border-radius:13px;font-size:21px;font-weight:800}.module-icon.blue{color:#2563eb;background:#eaf2ff}.module-icon.purple{color:#7c3aed;background:#f2edff}.module-title,.module-sub{display:block}.module-title{font-size:14px;font-weight:800}.module-sub{margin-top:4px;color:#94a3b8;font-size:9px}.permission-note{margin:14px 18px 0;padding:9px 11px;border-radius:7px;color:#526078;background:#f8fafc;font-size:9px}.permission-note.warning{color:#b45309;background:#fff7e6}.permission-note.success{color:#15803d;background:#eaf8ef}.action-list{padding:8px 18px 16px}.action-row{min-height:70px;display:flex;align-items:center;justify-content:space-between;gap:15px;border-bottom:1px solid #edf1f6}.action-row:last-child{border-bottom:0}.action-name,.action-copy{display:block}.action-name{font-size:11px;font-weight:700}.action-copy{margin-top:4px;color:#94a3b8;font-size:9px}.action-btn{height:34px;min-width:72px;padding:0 12px;margin:0;border:1px solid #dce4ef;border-radius:7px;color:#526078;background:#fff;font-size:10px;line-height:34px}.action-btn.primary{color:#fff;background:var(--p);border-color:var(--p)}.result-box{margin:0 18px 18px;padding:12px;border:1px solid #e1e8f1;border-radius:8px;background:#fbfcfe}.result-title{display:block;font-size:10px;font-weight:800}.result-stats{display:flex;gap:16px;margin:8px 0;color:#2563eb;font-size:10px}.result-line{padding:3px 0;color:#7b879a;font-size:8px}.rules-card{padding:20px}.rules-title{display:block;margin-bottom:16px;font-size:14px;font-weight:800}.rule-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}.rule{display:flex;gap:10px}.rule-index{width:23px;height:23px;flex:0 0 23px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:#2563eb;background:#edf4ff;font-size:10px;font-weight:800}.rule-name,.rule-copy{display:block}.rule-name{font-size:10px;font-weight:700}.rule-copy{margin-top:4px;color:#7b879a;font-size:9px;line-height:1.55}.loading-layer{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(244,247,251,.65);color:#64748b}
</style>
