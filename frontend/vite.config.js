import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO, SITE_URL } from './src/landing.config.js';

// Fills the %SEO_*% / %SITE_URL% placeholders of landing.html from src/landing.config.js
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const seoTags = {
  name: 'landing-seo',
  // 'pre': before Vite parses the HTML (it decodes URLs in og:image / link href)
  transformIndexHtml: { order: 'pre', handler: (html) => html.replace(/%SEO_TITLE%/g, esc(SEO.title)).replace(/%SEO_DESCRIPTION%/g, esc(SEO.description))
      .replace(/%SEO_KEYWORDS%/g, esc(SEO.keywords)).replace(/%SEO_OG_IMAGE%/g, esc(SEO.ogImage)).replace(/%SITE_URL%/g, esc(SITE_URL.replace(/\/$/, ''))) },
};

const here = dirname(fileURLToPath(import.meta.url));

// Three pages: the panel (index.html), the public login/sign-up page (login.html) and the landing page (landing.html).
// During `npm run dev`, forward API + live socket to the backend on port 4000
export default defineConfig({
  plugins: [
    react(),
    seoTags,
    {
      name: 'login-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/login' || req.url === '/register') req.url = '/login.html';
          if (req.url === '/home') req.url = '/landing.html';
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
        landing: resolve(here, 'landing.html'),
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
