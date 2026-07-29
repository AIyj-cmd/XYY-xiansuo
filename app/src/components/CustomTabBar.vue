<script setup lang="ts">
defineProps<{ current: number }>();

const tabs = [
  { label: '线索',  icon: '/static/tabbar/leads.png',     activeIcon: '/static/tabbar/leads-active.png',     url: '/pages/leads/list' },
  { label: '工作台', icon: '/static/tabbar/dashboard.png', activeIcon: '/static/tabbar/dashboard-active.png', url: '/pages/dashboard/index' },
  { label: '线索池', icon: '/static/tabbar/pool.png',      activeIcon: '/static/tabbar/pool-active.png',      url: '/pages/pool/index' },
  { label: '我的',  icon: '/static/tabbar/mine.png',      activeIcon: '/static/tabbar/mine-active.png',      url: '/pages/mine/index' },
];

function switchTo(url: string) {
  uni.switchTab({ url });
}

function goAdd() {
  uni.navigateTo({ url: '/pages/leads/form' });
}
</script>

<template>
  <view class="tab-bar">
    <!-- 左两项 -->
    <view
      v-for="(tab, i) in tabs.slice(0, 2)"
      :key="tab.url"
      class="tab-item"
      @click="switchTo(tab.url)"
    >
      <image v-if="current !== i" class="tab-icon" :src="tab.icon" mode="aspectFit" />
      <view
        v-else
        class="tab-icon tab-icon-mask"
        :style="{ maskImage: `url(${tab.activeIcon})`, webkitMaskImage: `url(${tab.activeIcon})` }"
      ></view>
      <text class="tab-label" :class="current === i ? 'tab-active' : ''">{{ tab.label }}</text>
    </view>

    <!-- 中间凸起添加按钮 -->
    <view class="tab-add-wrap">
      <view class="tab-add" @click="goAdd">
        <text class="tab-add-icon">+</text>
      </view>
      <text class="tab-label tab-add-label">添加线索</text>
    </view>

    <!-- 右两项 -->
    <view
      v-for="(tab, i) in tabs.slice(2)"
      :key="tab.url"
      class="tab-item"
      @click="switchTo(tab.url)"
    >
      <image v-if="current !== (i + 2)" class="tab-icon" :src="tab.icon" mode="aspectFit" />
      <view
        v-else
        class="tab-icon tab-icon-mask"
        :style="{ maskImage: `url(${tab.activeIcon})`, webkitMaskImage: `url(${tab.activeIcon})` }"
      ></view>
      <text class="tab-label" :class="current === (i + 2) ? 'tab-active' : ''">{{ tab.label }}</text>
    </view>
  </view>
</template>

<style scoped>
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: #fff;
  border-top: 1px solid #eef0f3;
  display: flex;
  align-items: center;
  padding-bottom: env(safe-area-inset-bottom);
  z-index: 9999;
}

.tab-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding-top: 6px;
  height: 100%;
}

.tab-icon { width: 24px; height: 24px; }

/* 选中态图标改用 mask + 主题色，而不是写死颜色的 PNG，这样切换主题色时 tab 图标能跟着变 */
.tab-icon-mask {
  background-color: var(--p);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}

.tab-label {
  font-size: 10px;
  color: #909399;
  line-height: 1;
}
.tab-active { color: var(--p); }

/* 中间按钮区域 */
.tab-add-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 6px;
  gap: 3px;
}

.tab-add {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--p);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: -20px;
  box-shadow: 0 3px 10px var(--ps);
  position: relative;
  z-index: 10000;
}

.tab-add-icon {
  font-size: 26px;
  color: #fff;
  line-height: 1;
  font-weight: 300;
}

.tab-add-label {
  font-size: 10px;
  color: #909399;
}
</style>
