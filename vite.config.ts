import { defineConfig, loadEnv } from 'vite';
import dyadComponentTagger from '@dyad-sh/react-vite-component-tagger';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { createApiPlugin } from './server/api';

export default defineConfig(({ mode }) => {
  // Load .env variables so the API plugin can use them in dev and preview.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    server: {
      host: '::',
      port: 8080,
    },
    preview: {
      host: '::',
      port: 8080,
    },
    plugins: [dyadComponentTagger(), react(), createApiPlugin(env)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});
