import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

export default defineConfig({
  plugins: [uni()],
  server: {
    // 当前 uni-app 版本严格依赖 Vite 5.2.8。开发服务器只监听本机，
    // 避免将含已知 dev-server 风险的版本暴露到局域网或公网。
    host: '127.0.0.1',
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
