// 登录成功后预下载底部 tab 页面代码，避免用户首次点击某个 tab 时
// 出现"页面代码还在下载"的短暂空窗期（灰色图标 + 加号按钮消失）
export function prefetchTabPages() {
  import('../pages/dashboard/index.vue');
  import('../pages/pool/index.vue');
  import('../pages/mine/index.vue');
}
