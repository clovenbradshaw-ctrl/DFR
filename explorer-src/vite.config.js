import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// The explorer is served as "another html page" on the DFR repo at /explorer/.
// We build into ../explorer (committed, prebuilt) so GitHub Pages "deploy from
// branch" serves it alongside the untouched main site at /.
export default defineConfig({
  base: '/explorer/',
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
    outDir: '../explorer',
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
});
