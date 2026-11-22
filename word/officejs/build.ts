// Bundle the Office.js task pane into word/officejs/dist/ (Bun only).
// ZN_OFFICEJS_DIST=<dir> builds into <dir> instead of word/officejs/dist (used by tests so scratch builds stay isolated).
//   bun build.ts          minified build
//   bun build.ts --dev    unminified build
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ICON_SIZES, renderZincIconPng } from "./src/entry/icons";

export const OFFICE_JS_URL = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";
export const DIST_ENV = "ZN_OFFICEJS_DIST";

export interface BuildOptions {
	outDir?: string;
	minify?: boolean;
}

export function buildTaskPaneHtml(sidebarHtml: string): string {
	const officeTag = `<script src="${OFFICE_JS_URL}"></script>`;
	const bundleRe = /<script\s+type="module"\s+src="main\.js"\s*><\/script>/;
	if (!bundleRe.test(sidebarHtml)) {
		throw new Error('word/sidebar/index.html no longer contains <script type="module" src="main.js"></script>');
	}
	if (!sidebarHtml.includes("</head>")) {
		throw new Error("word/sidebar/index.html is missing </head>");
	}
	return sidebarHtml.replace("</head>", `\t\t${officeTag}\n\t</head>`);
}

export async function buildTaskPane(opts: BuildOptions = {}): Promise<{ outDir: string }> {
	const here = import.meta.dir;
	const sidebarDir = join(here, "..", "sidebar");
	const manifestDir = join(here, "manifest");
	const outDir = opts.outDir || process.env[DIST_ENV] || join(here, "dist");
	const minify = opts.minify ?? !process.argv.includes("--dev");

	mkdirSync(outDir, { recursive: true });

	const result = await Bun.build({
		entrypoints: [join(here, "src", "entry", "main.ts")],
		outdir: outDir,
		target: "browser",
		format: "esm",
		splitting: false,
		minify,
		sourcemap: "none",
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("Bun.build failed for word/officejs");
	}

	const sidebarHtml = readFileSync(join(sidebarDir, "index.html"), "utf8");
	writeFileSync(join(outDir, "taskpane.html"), buildTaskPaneHtml(sidebarHtml), "utf8");
	cpSync(join(sidebarDir, "style.css"), join(outDir, "style.css"));

	for (const size of ICON_SIZES) {
		const name = `icon-${size}.png`;
		const srcIcon = join(manifestDir, name);
		const dstIcon = join(outDir, name);
		if (existsSync(srcIcon)) cpSync(srcIcon, dstIcon);
		else writeFileSync(dstIcon, renderZincIconPng(size));
	}

	return { outDir };
}

if (import.meta.main) {
	try {
		const { outDir } = await buildTaskPane();
		console.log(`officejs taskpane built -> ${outDir}`);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
