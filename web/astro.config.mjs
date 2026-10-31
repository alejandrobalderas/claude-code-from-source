import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import remarkMermaidRaw from './src/plugins/remark-mermaid-raw.mjs';

export default defineConfig({
  site: 'https://kywood.github.io',
  base: '/claude-code-from-source',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
    remarkPlugins: [remarkMermaidRaw],
  },
  output: 'static',
});
