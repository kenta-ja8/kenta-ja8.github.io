import type { APIContext } from "astro";
import satori from "satori";
import { html } from "satori-html";
import { getCollection, getEntryBySlug } from "astro:content";
import fs from "fs";
import sharp from "sharp";

const fontPath = "src/lib/NotoSansJP-SemiBold.ttf";
const accentColor = "#388e3c";
const subColor = "#8bc34a";
const surfaceColor = "white";

const height = 630;
const width = 1200;

export async function getStaticPaths() {
  return (await getCollection("blog")).map(
    (post) =>
    ({
      params: { slug: post.slug },
      props: { collection: "blog" },
    } as any)
  );
}

export async function get({ params, props }: APIContext) {
  const font = fs.readFileSync(fontPath);
  const iconBuffer = fs.readFileSync("public/my-icon.jpeg");
  const icon = `data:image/jpeg;base64,${iconBuffer.toString("base64")}`;

  const { slug } = params;
  const { collection } = props as { collection: "blog" };

  const post = await getEntryBySlug(collection, slug || "");
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

  let svg = await satori(out, {
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

  return {
    body: image,
  };
}
