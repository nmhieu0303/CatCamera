import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const vendorByRegion: Record<string, string> = {
    sg: 'https://openapi-sg.easy4ip.com',
    fk: 'https://openapi-fk.easy4ip.com',
    or: 'https://openapi-or.easy4ip.com',
  };
  const vendorTarget = vendorByRegion[env.IMOU_REGION || 'sg'];
  if (!vendorTarget) throw new Error('IMOU_REGION must be sg, fk or or');

  return {
    plugins: [react()],

    server: {
      host: '127.0.0.1',

      proxy: {
        '/api': 'http://127.0.0.1:3001',

        // These are the only vendor calls made by the browser SDK. Keep this
        // allowlist narrow; this is not a general OpenAPI proxy.
        '^/openapi/(getBuryConfig|getEncryptKitStreamUrl|getDeviceEncryptKey|reportBuryLog)$': {
          target: vendorTarget,
          changeOrigin: true,
          secure: true,
        },
      },

      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  };
});
