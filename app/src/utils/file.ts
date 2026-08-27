// 文件下载/上传封装 - 走 uni.downloadFile/uni.uploadFile，禁止使用 fetch/axios
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

// 下载文件并触发浏览器保存，token 通过 header 传递，不拼在 URL 里
export function downloadFile(path: string, filename: string): Promise<void> {
  const token = uni.getStorageSync('token');
  return new Promise((resolve, reject) => {
    uni.downloadFile({
      url: BASE_URL + path,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        if (res.statusCode !== 200) {
          reject(new Error('下载失败'));
          return;
        }
        // #ifdef H5
        const a = document.createElement('a');
        a.href = res.tempFilePath;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // #endif
        resolve();
      },
      fail() {
        reject(new Error('下载失败，请检查网络'));
      },
    });
  });
}

export interface UploadResult<T = unknown> {
  code: number;
  msg: string;
  data: T | null;
}

export interface LeadImportData {
  success: number;
  skipped: number;
  skipped_details: Array<{ row: number; reason: string }>;
  warnings?: number;
  warning_details?: Array<{ row: number; reason: string }>;
}

export interface BrandImportData {
  success: number;
  failed: number;
  errors: Array<{ row: number; reason: string }>;
}

function uploadFile<T>(path: string, file: File): Promise<UploadResult<T>> {
  const token = uni.getStorageSync('token');
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: BASE_URL + path,
      file,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        try {
          const body = JSON.parse(res.data as string) as UploadResult<T>;
          if (res.statusCode >= 400 || body.code !== 0) {
            reject(new Error(body.msg || '导入失败'));
            return;
          }
          resolve(body);
        } catch {
          reject(new Error('导入失败，服务器返回格式异常'));
        }
      },
      fail() {
        reject(new Error('导入失败，请检查网络'));
      },
    });
  });
}

// H5 下浏览器 File 对象要传 file 字段（不是 filePath，filePath 是字符串路径）。
export function uploadImportFile(file: File): Promise<UploadResult<LeadImportData>> {
  return uploadFile<LeadImportData>('/api/import', file);
}

export function uploadBrandImportFile(file: File): Promise<UploadResult<BrandImportData>> {
  return uploadFile<BrandImportData>('/api/brand-domain/import', file);
}
