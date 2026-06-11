import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // assets load relative → the bundle works mounted at any subpath
});
