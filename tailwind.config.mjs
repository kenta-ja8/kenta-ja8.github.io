import { defineConfig } from "tailwindcss";

export default defineConfig({
	content: ["./src/**/*.{astro,html,js,jsx,ts,tsx,vue,svelte,mdx}"],
	theme: {
		extend: {
			colors: {
				accent: "var(--accent)",
				"accent-light": "var(--accent-light)",
				"accent-dark": "var(--accent-dark)",
			},
			keyframes: {
				"fade-in": {
					from: { opacity: "0", transform: "translateY(0.5rem)" },
					to: { opacity: "1", transform: "translateY(0)" },
				},
			},
			animation: {
				"fade-in": "fade-in 0.4s ease-out",
			},
		},
	},
	plugins: [],
});
