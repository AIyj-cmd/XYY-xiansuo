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

interface ImportResult {
  code: number;
  msg: string;
  data: {
    success: number;
    skipped: number;
    skipped_details: Array<{ row: number; reason: string }>;
    warnings?: number;
    warning_details?: Array<{ row: number; reason: string }>;
  } | null;
}

// 上传导入文件：H5 下浏览器 File 对象要传 file 字段（不是 filePath，filePath 是字符串路径）
export function uploadImportFile(file: File): Promise<ImportResult> {
  const token = uni.getStorageSync('token');
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: BASE_URL + '/api/import',
      file,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(res) {
        try {
          resolve(JSON.parse(res.data as string));
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
