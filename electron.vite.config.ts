import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite bundles three targets. Main and preload are Node/Electron;
// the renderer is the React app rooted in frontend/.
export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      rollupOptions: {
        // Keep ws optional native-addon detection intact in Electron/Node.
        external: ['ws'],
        output: { entryFileNames: 'main.js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      rollupOptions: {
        output: { entryFileNames: 'preload.js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'frontend'),
    resolve: {
      alias: { '@': resolve(__dirname, 'frontend/src') },
    },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'frontend/index.html'),
      },
    },
    server: {
      port: 5273,
      strictPort: true,
    },
  },
});
