import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist/web', target: 'safari14', cssTarget: 'safari14' },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
})
