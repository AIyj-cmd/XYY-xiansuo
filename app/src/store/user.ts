import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface UserInfo {
  id: number;
  username: string;
  name: string;
  role: 'admin' | 'member';
}

export const useUserStore = defineStore('user', () => {
  const userInfo = ref<UserInfo | null>(null);
  const token = ref<string>('');

  function init() {
    token.value = uni.getStorageSync('token') || '';
    const stored = uni.getStorageSync('userInfo');
    if (stored) {
      try { userInfo.value = JSON.parse(stored); } catch { /* ignore */ }
    }
  }

  function login(tok: string, info: UserInfo) {
    token.value = tok;
    userInfo.value = info;
    uni.setStorageSync('token', tok);
    uni.setStorageSync('userInfo', JSON.stringify(info));
  }

  function logout() {
    token.value = '';
    userInfo.value = null;
    uni.removeStorageSync('token');
    uni.removeStorageSync('userInfo');
  }

  const isAdmin = () => userInfo.value?.role === 'admin';
  const isLoggedIn = () => !!token.value;

  return { userInfo, token, init, login, logout, isAdmin, isLoggedIn };
});
