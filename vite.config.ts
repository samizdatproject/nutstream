import { defineConfig } from 'vite';
// base './' so the build works from any path (GitHub Pages serves it under /nutstream/)
export default defineConfig({ base: './', build: { target: 'es2022' } });
