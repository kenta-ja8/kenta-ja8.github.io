import { visit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Code } from "mdast";
import type { Parent } from "unist";

export interface RemarkCodeTitleOptions {
	className?: string;
}

const remarkCodeTitles: Plugin<[RemarkCodeTitleOptions?]> = (options = {}) => {
	const className = options.className ?? "remark-code-title";

	return (tree) => {
		visit(
			tree,
			"code",
			(node: Code, index: number, parent: Parent | undefined) => {
				const nodeLang: string = node.lang || "";
				if (!nodeLang.includes(" ")) {
					return;
				}

				const [language, ...rest] = nodeLang.split(" ");
				const title = rest.join(" ").trim();
				if (!title) {
					return;
				}

				const titleNode = {
					type: "html",
					value: `<div class="${className}">${title}</div>`,
				};

				if (parent && Array.isArray(parent.children)) {
					parent.children.splice(index, 0, titleNode);
				}

				node.lang = language;
			},
		);
	};
};

export default remarkCodeTitles;
