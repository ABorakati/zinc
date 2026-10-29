// Build only the References dev page: from ui/, `bun --bun x vite build --config src/references/vite.config.ts`
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const uiRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
	root: uiRoot,
	base: "./",
	plugins: [tailwindcss(), solid()],
	resolve: { alias: { "~": fileURLToPath(new URL("..", import.meta.url)) } },
	build: {
		outDir: "dist-references",
		emptyOutDir: true,
		target: "chrome120",
		rollupOptions: { input: fileURLToPath(new URL("./dev.html", import.meta.url)) },
	},
});
