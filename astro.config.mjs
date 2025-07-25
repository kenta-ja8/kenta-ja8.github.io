import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import partytown from "@astrojs/partytown";

import sitemap from "@astrojs/sitemap";
import remarkCodeTitles from "remark-code-titles";

export default defineConfig({
	site: "https://blog.kenta-ja8.com",
	trailingSlash: "always",
	vite: { optimizeDeps: { exclude: ["@resvg/resvg-js"] } },
	integrations: [
		mdx(),
		sitemap(),
		partytown({
			config: {
				forward: ["dataLayer.push"],
			},
		}),
	],
	markdown: {
		remarkPlugins: [remarkCodeTitles],
		shikiConfig: {
			theme: "github-dark-dimmed",
		},
	},
});
