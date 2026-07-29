export interface Theme {
  id: string;
  name: string;
  primary: string;
  dark: string;
  shadow: string;
  light: string;
}

export const THEMES: Theme[] = [
  { id: 'blue',   name: '经典蓝', primary: '#2b6cb0', dark: '#1e3a5f', shadow: 'rgba(43,108,176,0.4)',  light: '#ebf4ff' },
  { id: 'green',  name: '翡翠绿', primary: '#059669', dark: '#064e3b', shadow: 'rgba(5,150,105,0.4)',    light: '#ecfdf5' },
  { id: 'rose',   name: '玫瑰红', primary: '#e11d48', dark: '#881337', shadow: 'rgba(225,29,72,0.4)',    light: '#fff1f2' },
  { id: 'violet', name: '紫罗兰', primary: '#7c3aed', dark: '#3b0764', shadow: 'rgba(124,58,237,0.4)',   light: '#f5f3ff' },
  { id: 'amber',  name: '橙金',   primary: '#d97706', dark: '#78350f', shadow: 'rgba(217,119,6,0.4)',    light: '#fffbeb' },
];

const KEY = 'app_theme';

export function applyTheme(themeId: string) {
  const theme = THEMES.find(t => t.id === themeId) ?? THEMES[0];
  // #ifdef H5
  // 同时设在 html 和 body 上，防止 uni-app H5 的 page 包裹层隔断继承链
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('--p', theme.primary);
    el.style.setProperty('--pd', theme.dark);
    el.style.setProperty('--ps', theme.shadow);
    el.style.setProperty('--pl', theme.light);
  }
  // #endif
  uni.setStorageSync(KEY, themeId);
}

export function loadTheme(): string {
  const id: string = uni.getStorageSync(KEY) || 'blue';
  applyTheme(id);
  return id;
}

export function getThemeId(): string {
  return uni.getStorageSync(KEY) || 'blue';
}
