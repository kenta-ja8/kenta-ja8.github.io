import type { APIContext } from "astro";
import satori from "satori";
import { html } from "satori-html";
import type { CollectionEntry } from "astro:content";
import { getCollection } from "astro:content";
import fs from "node:fs";
import sharp from "sharp";

const fontPath = "src/lib/NotoSansJP-SemiBold.ttf";
const accentColor = "#388e3c";
const subColor = "#8bc34a";
const surfaceColor = "white";

const height = 630;
const width = 1200;

interface Params {
	slug: string;
}

interface Props {
	post: CollectionEntry<"blog">;
}

export async function getStaticPaths() {
	return (await getCollection("blog")).map(
		(post): { params: Params; props: Props } => ({
			params: { slug: post.slug },
			props: { post },
		}),
	);
}

export async function GET({ params, props }: APIContext) {
	const font = fs.readFileSync(fontPath);
	const iconBuffer = fs.readFileSync("public/my-icon.jpeg");
	const icon = `data:image/jpeg;base64,${iconBuffer.toString("base64")}`;

	const { post } = props;

	const out = html`<div
    style="display:flex; flex:1; background:linear-gradient(to bottom right, ${accentColor} 60%, ${subColor}); padding:50px;"
  >
    <div
      style="width:100%; padding:20px; background-color:${surfaceColor}; border-radius:10px; display:flex; flex-direction:column"
    >
      <div style="display:flex; padding:20px; flex:1;">
        <h1 style="font-size:50px; word-break:break-all;">
          ${post?.data.title}
        </h1>
      </div>
      <div style="display:flex; align-items:flex-end; padding: 20px ">
        <img width="80" height="80" src=${icon} />
        <span style="font-size:40px; margin-left:10px">Kenta</span>
      </div>
    </div>
  </div>`;

	const svg = await satori(out, {
		fonts: [
			{
				name: "NotoSansJapanese",
				data: Buffer.from(font),
				style: "normal",
			},
		],
		height,
		width,
	});
	const image = await sharp(Buffer.from(svg)).png().toBuffer();

	return new Response(image);
}
