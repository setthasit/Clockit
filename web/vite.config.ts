import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// The backend serves /v1/... — dev calls same-origin /api/v1/... so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
