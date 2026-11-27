import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { productionApiBaseUrl } from './src/api.ts';

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && !['development', 'test'].includes(mode)) {
    productionApiBaseUrl(loadEnv(mode, '.', 'VITE_').VITE_API_BASE_URL);
  }
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173, strictPort: true },
  };
});
