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
		// Prebuilt by `bun --bun x vite build` (ui/), reader-host/build.sh and note-host/build.sh.
		copy: {
			"../ui/dist": "views/app",
			"../reader-host/dist": "views/reader-host",
			"../note-host/dist": "views/note-host",
			// Full-text extraction runs this in a Bun worker (it can't be bundled into main).
			"../core/src/extract/pdf-worker.ts": "bun/pdf-worker.ts",
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
