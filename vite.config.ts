import { defineConfig } from 'vitest/config';
import { fileBridge } from './dev/bridge.ts';

// The same front end runs two ways: inside the Tauri desktop shell (which serves this
// build and gives it file access), and in a browser through `npm run dev`, where the
// file bridge in dev/bridge.ts stands in for the shell.
export default defineConfig({
  plugins: process.env.VITEST ? [] : [fileBridge()],
  clearScreen: false,
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'] },
});
