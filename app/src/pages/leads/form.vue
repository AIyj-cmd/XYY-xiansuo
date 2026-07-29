<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { get, post, patch } from '../../utils/request';
import { useUserStore } from '../../store/user';

const store = useUserStore();
const isEdit = ref(false);
const leadId = ref<number | null>(null);
const loading = ref(false);
const submitting = ref(false);

const SOURCE_LIST = ['小红书', '抖音', '视频号', '知乎', '微信公众号', 'B站', '百度', '官网', '转介绍', '其他'];
const INDUSTRY_LIST = ['女装', '男装', '童装', '鞋类', '内衣', '其他'];
const INTENT_LIST = ['高', '中', '低', '未知'];

const form = ref({
  contact_name: '',
  phone: '',
  wechat: '',
  company_name: '',
  industry: '',
  industryCustom: '',
  source: '',
  sourceCustom: '',
  source_note: '',
  demand_note: '',
  intent_level: '未知',
  owner_id: 0,
  lead_date: '',
  next_follow_at: '',
});

const phoneError = ref('');
const dupLead = ref<{ id: number; company_name: string | null; contact_name: string; owner_name: string } | null>(null);
const canSubmit = computed(() => !dupLead.value && !phoneError.value);

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

onMounted(async () => {
  store.init();
  form.value.lead_date = todayStr();
  form.value.owner_id = store.userInfo?.id || 0;

  const pages = getCurrentPages();
  const cur = pages[pages.length - 1] as any;
  const options = cur.$page?.options || cur.options || {};

  if (options.id) {
    isEdit.value = true;
    leadId.value = Number(options.id);
    // 标题由自定义导航栏根据 isEdit 显示
    await loadLead();
  }
});

async function loadLead() {
  loading.value = true;
  try {
    const data = await get<any>(`/api/leads/${leadId.value}`);
    form.value = {
      contact_name: data.contact_name,
      phone: data.phone,
      wechat: data.wechat || '',
      company_name: data.company_name || '',
      industry: INDUSTRY_LIST.includes(data.industry) ? data.industry : (data.industry ? '其他' : ''),
      industryCustom: !INDUSTRY_LIST.includes(data.industry) ? data.industry || '' : '',
      source: SOURCE_LIST.includes(data.source) ? data.source : '其他',
      sourceCustom: !SOURCE_LIST.includes(data.source) ? data.source : '',
      source_note: data.source_note || '',
      demand_note: data.demand_note || '',
      intent_level: data.intent_level,
      owner_id: data.owner_id || store.userInfo?.id || 0,
      lead_date: data.lead_date,
      next_follow_at: data.next_follow_at || '',
    };
  } finally {
    loading.value = false;
  }
}

let phoneCheckTimer: ReturnType<typeof setTimeout> | null = null;

async function checkPhone() {
  const phone = form.value.phone.trim();
  phoneError.value = '';
  dupLead.value = null;
  if (!phone) return;
  if (!/^1\d{10}$/.test(phone)) {
    phoneError.value = '手机号格式错误（11位，1开头）';
    return;
  }
  try {
    const params: Record<string, any> = { phone };
    if (leadId.value) params.exclude_id = leadId.value;
    const dup = await get<any>('/api/leads/check-phone', params);
    if (dup) dupLead.value = dup;
  } catch { /* ignore */ }
}

function onPhoneInput() {
  if (phoneCheckTimer) clearTimeout(phoneCheckTimer);
  phoneCheckTimer = setTimeout(checkPhone, 500);
}

function onPhoneBlur() {
  if (phoneCheckTimer) clearTimeout(phoneCheckTimer);
  checkPhone();
}

function getSource() {
  return form.value.source === '其他' ? form.value.sourceCustom : form.value.source;
}

function getIndustry() {
  return form.value.industry === '其他' ? form.value.industryCustom : form.value.industry;
}

async function handleSubmit() {
  if (!form.value.contact_name.trim()) { uni.showToast({ title: '请填写联系人', icon: 'none' }); return; }
  if (!form.value.phone.trim() && !form.value.wechat.trim()) { uni.showToast({ title: '手机号和微信号至少填一项', icon: 'none' }); return; }
  if (!getSource()) { uni.showToast({ title: '请选择线索来源', icon: 'none' }); return; }
  if (!canSubmit.value) return;

  submitting.value = true;
  try {
    const payload = {
      contact_name: form.value.contact_name.trim(),
      phone: form.value.phone.trim() || undefined,
      wechat: form.value.wechat.trim() || undefined,
      company_name: form.value.company_name.trim() || undefined,
      industry: getIndustry() || undefined,
      source: getSource(),
      source_note: form.value.source_note.trim() || undefined,
      demand_note: form.value.demand_note.trim() || undefined,
      intent_level: form.value.intent_level,
      owner_id: form.value.owner_id || undefined,
      lead_date: form.value.lead_date,
      next_follow_at: form.value.next_follow_at || undefined,
    };

    if (isEdit.value) {
      await patch(`/api/leads/${leadId.value}`, payload);
      uni.showToast({ title: '保存成功', icon: 'success' });
    } else {
      await post('/api/leads', payload);
      uni.showToast({ title: '创建成功', icon: 'success' });
    }
    setTimeout(() => uni.navigateBack(), 500);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="form-page">
    <view class="form-nav">
      <view class="form-nav-back" @click="uni.navigateBack()">
        <text class="form-nav-arrow">‹</text>
      </view>
      <text class="form-nav-title">{{ isEdit ? '编辑线索' : '新增线索' }}</text>
      <view class="form-nav-placeholder" />
    </view>
    <scroll-view class="form-scroll" scroll-y>
      <view class="form-body">

        <view class="form-section">
          <view class="section-title">基本信息</view>

          <view class="form-item required">
            <text class="item-label">联系人</text>
            <input class="item-input" v-model="form.contact_name" placeholder="请输入联系人姓名" />
          </view>

          <view class="form-item">
            <text class="item-label">手机号</text>
            <input
              class="item-input"
              v-model="form.phone"
              placeholder="选填，与微信号至少填一项"
              type="number"
              maxlength="11"
              @input="onPhoneInput"
              @blur="onPhoneBlur"
            />
            <view v-if="phoneError" class="field-error">{{ phoneError }}</view>
            <view v-if="dupLead" class="dup-tip">
              <text>该手机号已存在：{{ dupLead.company_name || dupLead.contact_name }}，负责人 {{ dupLead.owner_name }}</text>
              <text class="dup-link" @click="uni.navigateTo({ url: `/pages/leads/detail?id=${dupLead.id}` })">查看该线索</text>
            </view>
          </view>

          <view class="form-item">
            <text class="item-label">微信号</text>
            <input class="item-input" v-model="form.wechat" placeholder="选填，与手机号至少填一项" />
          </view>

          <view class="form-item">
            <text class="item-label">公司/品牌名</text>
            <input class="item-input" v-model="form.company_name" placeholder="选填" />
          </view>
        </view>

        <view class="form-section">
          <view class="section-title">线索信息</view>

          <view class="form-item">
            <text class="item-label">行业类型</text>
            <view class="tag-select">
              <view
                v-for="i in INDUSTRY_LIST"
                :key="i"
                class="select-tag"
                :class="{ active: form.industry === i }"
                @click="form.industry = form.industry === i ? '' : i"
              >{{ i }}</view>
            </view>
            <input v-if="form.industry === '其他'" class="item-input mt-8" v-model="form.industryCustom" placeholder="请输入行业" />
          </view>

          <view class="form-item required">
            <text class="item-label">线索来源</text>
            <view class="tag-select">
              <view
                v-for="s in SOURCE_LIST"
                :key="s"
                class="select-tag"
                :class="{ active: form.source === s }"
                @click="form.source = form.source === s ? '' : s"
              >{{ s }}</view>
            </view>
            <input v-if="form.source === '其他'" class="item-input mt-8" v-model="form.sourceCustom" placeholder="请输入来源" />
          </view>

          <view class="form-item">
            <text class="item-label">来源细分</text>
            <input class="item-input" v-model="form.source_note" placeholder="来自哪篇内容/哪个关键词，方便统计效果" />
          </view>

          <view class="form-item">
            <text class="item-label">需求概况</text>
            <textarea class="item-textarea" v-model="form.demand_note" placeholder="仓储面积/SKU量/日单量等" :auto-height="true" />
          </view>

          <view class="form-item">
            <text class="item-label">意向等级</text>
            <view class="tag-select">
              <view
                v-for="i in INTENT_LIST"
                :key="i"
                class="select-tag"
                :class="{ active: form.intent_level === i }"
                @click="form.intent_level = i"
              >{{ i }}</view>
            </view>
          </view>
        </view>

        <view class="form-section">
          <view class="section-title">跟进设置</view>

          <view class="form-item">
            <text class="item-label">线索日期</text>
            <picker mode="date" :value="form.lead_date" @change="(e: any) => form.lead_date = e.detail.value">
              <view class="picker-field">
                <text>{{ form.lead_date || '请选择' }}</text>
                <text class="picker-arrow">▼</text>
              </view>
            </picker>
          </view>

          <view class="form-item">
            <text class="item-label">下次跟进日期</text>
            <picker mode="date" :value="form.next_follow_at" @change="(e: any) => form.next_follow_at = e.detail.value">
              <view class="picker-field">
                <text>{{ form.next_follow_at || '不设置' }}</text>
                <text class="picker-arrow">▼</text>
              </view>
            </picker>
          </view>
        </view>

      </view>
    </scroll-view>

    <view class="form-footer">
      <button
        class="submit-btn"
        :disabled="submitting || !canSubmit"
        :loading="submitting"
        @click="handleSubmit"
      >
        {{ submitting ? '保存中...' : (isEdit ? '保存修改' : '创建线索') }}
      </button>
    </view>
  </view>
</template>

<style scoped>
.form-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: #f5f7fa;
}

.form-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 4px 0 0;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.form-nav-back {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.form-nav-arrow {
  font-size: 28px;
  color: #2b6cb0;
  line-height: 1;
}
.form-nav-title {
  font-size: 16px;
  font-weight: 600;
  color: #1a202c;
}
.form-nav-placeholder { width: 48px; }

.form-scroll { flex: 1; min-height: 0; overflow: hidden; padding-bottom: calc(84px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.form-body { padding-bottom: 20px; }

.form-section {
  background: #fff;
  margin: 12px;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}

.section-title {
  font-size: 14px;
  font-weight: 700;
  color: #2b6cb0;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebf4ff;
}

.form-item {
  margin-bottom: 16px;
}

.form-item:last-child { margin-bottom: 0; }

.item-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #4a5568;
  margin-bottom: 8px;
}

.required .item-label::after {
  content: ' *';
  color: #e53e3e;
}

.item-input {
  width: 100%;
  height: 44px;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  padding: 0 12px;
  font-size: 14px;
  background: #f7fafc;
  box-sizing: border-box;
}

.item-textarea {
  width: 100%;
  min-height: 80px;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  background: #f7fafc;
  box-sizing: border-box;
}

.field-error {
  font-size: 12px;
  color: #e53e3e;
  margin-top: 4px;
  padding: 6px 10px;
  background: #fff5f5;
  border-radius: 6px;
}

.dup-tip {
  font-size: 12px;
  color: #e53e3e;
  background: #fff5f5;
  border: 1px solid #fed7d7;
  border-radius: 8px;
  padding: 8px 12px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dup-link {
  color: #2b6cb0;
  text-decoration: underline;
  font-weight: 600;
}

.tag-select {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.select-tag {
  padding: 6px 14px;
  border: 1.5px solid #e2e8f0;
  border-radius: 20px;
  font-size: 13px;
  color: #4a5568;
}

.select-tag.active {
  background: #ebf4ff;
  border-color: #2b6cb0;
  color: #2b6cb0;
  font-weight: 600;
}

.picker-field {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 44px;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  padding: 0 12px;
  background: #f7fafc;
  font-size: 14px;
  color: #1a202c;
}

.picker-arrow { font-size: 11px; color: #a0aec0; }

.mt-8 { margin-top: 8px; }

.form-footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  padding: 12px 16px;
  background: #fff;
  border-top: 1px solid #e2e8f0;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
}

.submit-btn {
  width: 100%;
  height: 50px;
  background: var(--p);
  color: #fff;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 600;
  border: none;
}

.submit-btn[disabled] {
  opacity: 0.5;
  background: #90cdf4;
}
</style>
