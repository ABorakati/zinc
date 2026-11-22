// Boots Zinc for a scenario: src/start.tsx, the start-up every build uses, on GPUI's headless test renderer with the core in this
// process (handleApi, no socket). Import it only after fences.ts and the environment are in place.
import { TestRenderer } from "@gpuix/solid/testing";
import { Ui } from "./driver";
import type { ScenarioOptions } from "./define";

export async function bootApp(options: ScenarioOptions, outDir: string): Promise<Ui> {
	const size = { width: options.width ?? 1440, height: options.height ?? 900 };
	const renderer = new TestRenderer(size);
	// an in-memory clipboard, which is also the first route the app tries
	let clipboard = "";
	Object.assign(renderer, {
		writeToClipboard: (text: string) => void (clipboard = text),
		readFromClipboard: () => clipboard,
	});

	const { start } = await import("../../src/start");
	const { startCore } = await import("../../src/core");
	const { registerFonts } = await import("../../src/fonts");
	const { setThemePrefs } = await import("../../src/shell/appearance");
	const { setNativeRenderer } = await import("../../src/shell/native");

	let ready!: () => void;
	const featuresIn = new Promise<void>((resolve) => (ready = resolve));
	const pump = setInterval(() => {
		renderer.dispatchNativeEvents();
		renderer.flush();
	}, 30);
	try {
		const failed = start({
			title: "Zinc UI test",
			window: size,
			renderer,
			init() {},
			prepare: () => setThemePrefs({ mode: options.mode ?? "dark" }),
			prefetch: () => false,
			registerFonts() {
				setNativeRenderer(renderer);
				registerFonts(renderer);
			},
			async connect() {
				if (!(await startCore())) throw new Error("the core did not start");
			},
			afterFeatures: () => ready(),
		}).then(() => featuresIn);
		const timeout = Bun.sleep(30_000).then(() => {
			throw new Error("the app did not finish starting in 30 s");
		});
		await Promise.race([failed, timeout]);
	} finally {
		clearInterval(pump);
	}

	const { store } = await import("../../src/store");
	const { apiFetch } = await import("../../src/api");
	const ui = new Ui(renderer, store, apiFetch, size, outDir);
	await ui.waitFor("the first page of the list", () => store.total() > 0 && !!store.peek(0));
	await ui.settle(700);
	return ui;
}
