import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The DSH document and transport still come from the assembled sidecar.
// Only HeronAI's product widgets are loaded from Vite during host development.
export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1', strictPort: true, cors: { origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ } },
})
