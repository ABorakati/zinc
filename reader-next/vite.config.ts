import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "./",
	plugins: [tailwindcss(), solid()],
	resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
	build: { outDir: "dist", target: "chrome120", sourcemap: false, chunkSizeWarningLimit: 2000 },
	server: {
		port: 5174,
		proxy: { "/api": "http://127.0.0.1:23121" },
	},
});
