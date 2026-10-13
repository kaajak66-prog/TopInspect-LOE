import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // dev 时前端在 5173、后端在 8000：把 /api 转发到后端。
    // 生产由 FastAPI 同源托管 dist，API_BASE='' 直接同源，无需代理。
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // SSE 进度流(/api/jobs/{id}/progress)：关闭代理缓冲，事件才能实时透传
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache'
            }
          })
        },
      },
    },
  },
})
