<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUserStore } from '../../store/user';
import { downloadFile, uploadImportFile } from '../../utils/file';

const store = useUserStore();
const importing = ref(false);
const report = ref<{
  success: number;
  skipped: number;
  skipped_details: Array<{ row: number; reason: string }>;
  warnings?: number;
  warning_details?: Array<{ row: number; reason: string }>;
} | null>(null);

onMounted(() => { store.init(); });

async function downloadTemplate() {
  // #ifdef H5
  try {
    await downloadFile('/api/import/template', 'leads_import_template.xlsx');
  } catch {
    uni.showToast({ title: '模板下载失败，请重试', icon: 'none' });
  }
  // #endif
  // #ifndef H5
  uni.showToast({ title: '请在 H5 环境下载模板', icon: 'none' });
  // #endif
}

function handleImport() {
  // #ifdef H5
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.csv';
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    importing.value = true;
    report.value = null;
    try {
      const json = await uploadImportFile(file);
      if (json.code === 0 && json.data) {
        report.value = json.data;
        uni.showToast({ title: `导入完成：${json.data.success}条`, icon: 'success' });
      } else {
        uni.showToast({ title: json.msg, icon: 'none' });
      }
    } catch {
      uni.showToast({ title: '导入失败', icon: 'none' });
    } finally {
      importing.value = false;
    }
  };
  input.click();
  // #endif
  // #ifndef H5
  uni.showToast({ title: '请在 H5 环境使用导入功能', icon: 'none' });
  // #endif
}
</script>

<template>
  <view class="import-page">
    <view class="info-card">
      <text class="info-title">导入说明</text>
      <text class="info-text">支持 .xlsx 和 .csv 格式文件。</text>
      <text class="info-text">如使用 .ods 文件，请先用 WPS 另存为 xlsx 格式再导入。</text>
      <text class="info-text">导入模板列：序号 | 年份 | 月份 | 线索日期 | 跟进人 | 线索来源 | 跟进情况 | 行业类型 | 联系人 | 手机 | 微信号 | 跟进记录 | 跟进状态</text>
    </view>

    <view class="action-section">
      <button class="btn-template" @click="downloadTemplate">下载导入模板</button>
      <button class="btn-import" :disabled="importing" @click="handleImport">
        {{ importing ? '导入中...' : '选择文件并导入' }}
      </button>
    </view>

    <!-- 导入报告 -->
    <view v-if="report" class="report-card">
      <text class="report-title">导入报告</text>
      <view class="report-stat">
        <view class="report-item success">
          <text class="stat-num">{{ report.success }}</text>
          <text class="stat-label">成功导入</text>
        </view>
        <view class="report-item warn">
          <text class="stat-num">{{ report.skipped }}</text>
          <text class="stat-label">跳过条数</text>
        </view>
      </view>

      <view v-if="report.skipped_details.length > 0" class="skip-list">
        <text class="skip-title">跳过详情：</text>
        <view v-for="d in report.skipped_details" :key="d.row" class="skip-item">
          <text>第 {{ d.row }} 行：{{ d.reason }}</text>
        </view>
      </view>

      <view v-if="report.warning_details && report.warning_details.length > 0" class="warn-list">
        <text class="warn-title">提醒（已导入，但请注意）：</text>
        <view v-for="d in report.warning_details" :key="d.row" class="warn-item">
          <text>第 {{ d.row }} 行：{{ d.reason }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style scoped>
.import-page { min-height: 100vh; background: #f5f7fa; padding: 12px; }
.info-card { background: #ebf4ff; border-radius: 12px; padding: 16px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; border-left: 4px solid #2b6cb0; }
.info-title { font-size: 14px; font-weight: 700; color: #2b6cb0; }
.info-text { font-size: 13px; color: #4a5568; line-height: 1.6; }
.action-section { display: flex; flex-direction: column; gap: 10px; }
.btn-template { height: 44px; background: #fff; border: 1.5px solid #2b6cb0; color: #2b6cb0; border-radius: 10px; font-size: 15px; font-weight: 600; }
.btn-import { height: 50px; background: #2b6cb0; color: #fff; border-radius: 10px; font-size: 16px; font-weight: 600; border: none; }
.btn-import[disabled] { opacity: 0.6; }
.report-card { background: #fff; border-radius: 12px; padding: 16px; margin-top: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.report-title { font-size: 14px; font-weight: 700; color: #1a202c; margin-bottom: 12px; display: block; }
.report-stat { display: flex; gap: 12px; margin-bottom: 14px; }
.report-item { flex: 1; background: #f7fafc; border-radius: 10px; padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 4px; }
.report-item.success { border-top: 3px solid #2f855a; }
.report-item.warn { border-top: 3px solid #dd6b20; }
.stat-num { font-size: 28px; font-weight: 800; color: #1a202c; }
.stat-label { font-size: 12px; color: #718096; }
.skip-list { background: #fffaf0; border-radius: 8px; padding: 12px; }
.skip-title { font-size: 13px; font-weight: 600; color: #dd6b20; margin-bottom: 8px; display: block; }
.skip-item { font-size: 12px; color: #4a5568; padding: 4px 0; border-bottom: 1px solid #feebc8; }
.skip-item:last-child { border-bottom: none; }
.warn-list { background: #f0fff4; border-radius: 8px; padding: 12px; margin-top: 10px; }
.warn-title { font-size: 13px; font-weight: 600; color: #276749; margin-bottom: 8px; display: block; }
.warn-item { font-size: 12px; color: #4a5568; padding: 4px 0; border-bottom: 1px solid #c6f6d5; }
.warn-item:last-child { border-bottom: none; }
</style>
