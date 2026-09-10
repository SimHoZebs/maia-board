import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: process.env.MAIA_BUILD_DIR || 'dist',
    emptyOutDir: true,
  },
});
