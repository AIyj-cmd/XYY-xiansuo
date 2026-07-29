// 统一请求封装 - 禁止使用 fetch/axios，只用 uni.request
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  data?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  showError?: boolean;
  headers?: Record<string, string>;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  let url = BASE_URL + path;
  if (params) {
    const search = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (search) url += `?${search}`;
  }
  return url;
}

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', data, params, showError = true, headers = {} } = options;
  const token = uni.getStorageSync('token');

  return new Promise<T>((resolve, reject) => {
    uni.request({
      url: buildUrl(path, params),
      method,
      data: data as any,
      header: {
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      success(res) {
        const body = res.data as ApiResponse<T>;

        if (res.statusCode === 401) {
          uni.removeStorageSync('token');
          uni.removeStorageSync('userInfo');
          uni.reLaunch({ url: '/pages/login/index' });
          reject(new Error('登录已过期'));
          return;
        }

        if (res.statusCode === 403) {
          if (showError) uni.showToast({ title: '无权限操作', icon: 'none' });
          reject(new Error('无权限'));
          return;
        }

        if (res.statusCode >= 400) {
          const msg = body?.msg || '请求失败';
          if (showError) uni.showToast({ title: msg, icon: 'none', duration: 2500 });
          reject(new Error(msg));
          return;
        }

        if (body.code !== 0) {
          if (showError) uni.showToast({ title: body.msg, icon: 'none', duration: 2500 });
          reject(new Error(body.msg));
          return;
        }

        resolve(body.data);
      },
      fail(err) {
        if (showError) uni.showToast({ title: '网络异常，请检查连接', icon: 'none' });
        reject(err);
      },
    });
  });
}

export function get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  return request<T>(path, { method: 'GET', params });
}

export function post<T = unknown>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', data });
}

export function patch<T = unknown>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', data });
}

export function put<T = unknown>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', data });
}

export function del<T = unknown>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}
