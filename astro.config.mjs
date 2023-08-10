import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://kenta-ja8.github.io',
  base: '/kenta-pages',
	integrations: [mdx(), sitemap()],
});