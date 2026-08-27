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
:root {
  --p: #2563eb;
  --pd: #1d4ed8;
  --ps: rgba(37, 99, 235, 0.18);
  --pl: #eff6ff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --text: #172033;
  --muted: #64748b;
  --line: #e5eaf2;
  --canvas: #f4f7fb;
  --card: #ffffff;
  --tabbar-safe-bottom: 76px;
}

html,
body,
#app {
  min-height: 100%;
  margin: 0;
  background: var(--canvas);
}

page {
  min-height: 100%;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  color: var(--text);
  background-color: var(--canvas);
}

view,
text,
input,
textarea,
button,
scroll-view {
  box-sizing: border-box;
}

button::after {
  border: 0;
}

input,
textarea {
  color: var(--text);
}

.text-center { text-align: center; }
.text-primary { color: var(--p); }
.text-danger { color: var(--danger); }
.text-gray { color: var(--muted); }
.mt-8 { margin-top: 8px; }
.mt-16 { margin-top: 16px; }

/* H5 桌面后台滚动条，克制一点，别让它像 2007 年的财务软件。 */
@media (min-width: 900px) {
  * {
    scrollbar-width: thin;
    scrollbar-color: #cbd5e1 transparent;
  }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
  *::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
}
</style>
