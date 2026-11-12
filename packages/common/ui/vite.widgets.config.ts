import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  base: '/heron-ai-acp/ui/',
  build: {
    outDir: '../../../.cache/ui', emptyOutDir: true, sourcemap: 'hidden',
    lib: { entry: fileURLToPath(new URL('./src/dsh-widgets.ts', import.meta.url)), formats: ['es'], fileName: () => 'widgets.js' },
    rollupOptions: { output: { assetFileNames: asset => asset.names?.some(name => name.endsWith('.css')) ? 'widgets.css' : 'assets/[name]-[hash][extname]' } },
    chunkSizeWarningLimit: 1800,
  },
})
