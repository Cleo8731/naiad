import { defineConfig } from 'vitest/config';
import { fileBridge } from './dev/bridge.ts';

// The same front end runs three ways: inside the Tauri desktop shell (which serves this
// build and gives it file access); in a browser from the app started as
// `naiad serve <file>`; and in a browser through `npm run dev`, where the file bridge
// in dev/bridge.ts stands in for the shell.
export default defineConfig({
  // The page asks for its own files relatively: `naiad serve` keeps them under a
  // folder named by its secret.
  base: './',
  plugins: process.env.VITEST ? [] : [fileBridge()],
  clearScreen: false,
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/**/*.test.ts'] },
});
