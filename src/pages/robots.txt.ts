export function GET({ site }: { site: URL }) {
	const sitemap = new URL("sitemap-index.xml", site).href;
	return new Response(`User-agent: *\nAllow: /\nSitemap: ${sitemap}\n`, {
		headers: { "Content-Type": "text/plain" },
	});
}
