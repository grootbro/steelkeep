import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

const apiPort=process.env.STEELKEEP_DEV_API_PORT??'4311'
if(!/^\d{4,5}$/.test(apiPort)||Number(apiPort)>65535)throw new Error('Use a valid local development API port.')
const apiTarget=`http://127.0.0.1:${apiPort}`

export default defineConfig({
  plugins: [tanstackStart({ spa: { enabled: true } }), react()],
  server: {
    host: '127.0.0.1',
    port: 4310,
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/mcp': apiTarget,
      '/openapi': apiTarget
    }
  }
})
