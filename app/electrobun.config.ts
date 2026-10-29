import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "zotero-next",
		identifier: "dev.zotero-next.app",
		version: "0.1.0",
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
