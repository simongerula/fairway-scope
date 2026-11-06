import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

export default defineConfig({
  define: {
    // baked in at build time so the UI can show which build the phone runs
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TS__: JSON.stringify(Date.now())
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Home Launch Monitor',
        short_name: 'Launch',
        description:
          'Camera-based golf launch monitor. Estimates ball speed, launch angle and carry from your phone camera.',
        theme_color: '#0e1116',
        background_color: '#0e1116',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html'
      },
      devOptions: { enabled: true }
    })
  ]
});
