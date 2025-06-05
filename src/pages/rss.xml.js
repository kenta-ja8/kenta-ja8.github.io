import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { SITE_TITLE } from "../consts";

export async function GET(context) {
	const posts = await getCollection("blog", ({ data }) => !data.draft);
	return rss({
		title: SITE_TITLE,
		description: SITE_TITLE,
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.createdAt,
			link: `/blog/${post.slug}/`,
		})),
	});
}
