import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      },
      output: {
        // three.js changes far less often than app code, so give it its own
        // long-cached chunk.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        }
      }
    },
    // three.js alone is ~560 kB minified; that chunk size is expected.
    chunkSizeWarningLimit: 650
  }
});
