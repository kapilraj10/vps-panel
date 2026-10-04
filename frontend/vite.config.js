import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Two pages: the panel (index.html) and the public login page (login.html).
// During `npm run dev`, forward API + live socket to the backend on port 4000
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'login-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/login') req.url = '/login.html';
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        login: resolve(here, 'login.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/socket.io': { target: 'http://127.0.0.1:4000', ws: true },
    },
  },
});
