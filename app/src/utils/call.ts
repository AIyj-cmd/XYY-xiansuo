// 拨打电话封装 - 处理 H5 与小程序差异
export function makeCall(phone: string): void {
  // #ifdef H5
  window.location.href = `tel:${phone}`;
  // #endif
  // #ifndef H5
  uni.makePhoneCall({
    phoneNumber: phone,
    fail() {
      uni.showToast({ title: '拨号失败', icon: 'none' });
    },
  });
  // #endif
}

// 复制文本到剪贴板
export function copyText(text: string, tip = '已复制'): void {
  uni.setClipboardData({
    data: text,
    success() {
      uni.showToast({ title: tip, icon: 'none' });
    },
  });
}
