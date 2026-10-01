import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev`, forward API + live socket to the backend on port 4000
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/socket.io': { target: 'http://127.0.0.1:4000', ws: true },
    },
  },
});
