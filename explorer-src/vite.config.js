import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// The explorer is served as "another html page" on the DFR repo, under
// /explorer/. On GitHub project Pages the real mount point is /DFR/explorer/,
// so asset URLs must be RELATIVE ('./') — an absolute '/explorer/' would 404
// because the project is served under /DFR/. Relative paths also keep the build
// portable to a root custom domain. We build into ../explorer (committed,
// prebuilt) so Pages "deploy from branch" serves it next to the main site.
export default defineConfig({
  base: './',
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
