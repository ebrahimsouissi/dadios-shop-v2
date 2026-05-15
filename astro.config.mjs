import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://thedadios.com',
  output: 'static',
  build: {
    inlineStylesheets: 'auto',
  },
});
