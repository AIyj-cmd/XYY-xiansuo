<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';
import { loadTheme } from './utils/theme';

onLaunch(() => {
  loadTheme();
});
</script>

<template>
  <page-meta :page-style="''" />
</template>

<style>
/* 主题色默认值（经典蓝），只挂在 :root 上，不能设在 page 上
   ——uni-app H5 会将 page 编译为页面包裹层，CSS 变量从那里继承，
   会覆盖 html 的值导致 JS setProperty 修改 html 无效 */
:root {
  --p: #2b6cb0;
  --pd: #1e3a5f;
  --ps: rgba(43,108,176,0.4);
  --pl: #ebf4ff;
  /* CustomTabBar 高度(56px) + 中间凸起添加按钮上探量(20px)，
     贴底按钮/可滚动内容都要预留这块高度，否则会被 tab bar 或圆形加号按钮挡住 */
  --tabbar-safe-bottom: 76px;
}

page {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1a202c;
  background-color: #f5f7fa;
}

/* 全局工具类 */
.text-center { text-align: center; }
.text-primary { color: #2b6cb0; }
.text-danger { color: #e53e3e; }
.text-gray { color: #718096; }
.mt-8 { margin-top: 8px; }
.mt-16 { margin-top: 16px; }
</style>
