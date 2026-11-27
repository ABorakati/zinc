// Boots Zinc for a scenario: src/start.tsx, the start-up every build uses, on GPUI's test renderer with the core in this
// process (handleApi, no socket). Import it only after fences.ts and the environment are in place.
import { TestRenderer } from "@gpuix/solid/testing";
import { Ui } from "./driver";
import { InProcessBackend, RemoteBackend } from "./backend";
import { fitWindow } from "./background";
import { SMALL_WINDOW } from "./limits";
import type { ScenarioOptions } from "./define";

export async function bootApp(options: ScenarioOptions, outDir: string): Promise<Ui> {
	const size = { width: options.width ?? 1440, height: options.height ?? 881 };
	const renderer = new TestRenderer(size);
	fitWindow(size.width, size.height); // GPUI's test window takes its size from the display: give it the one the scenarios assume
	for (let i = 0; i < 5; i++) {
		renderer.dispatchNativeEvents();
		renderer.flush();
	}
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
	// macOS: the app installs its native menubar in platform.ts's settled(), which this start-up does not run, so the state stayed
	// "pending" and no menu was shown at all. The scenarios drive the in-window row, as on Windows.
	const { setNativeMenubarState } = await import("../../src/shell/menubarState");
	setNativeMenubarState("fallback");

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
	const ui = new Ui(new InProcessBackend(renderer, store as never, apiFetch, size), size, outDir);
	// every scenario's coordinates assume this size: a window of another size (a display too small for it) stops the run
	const root = (JSON.parse(renderer.getAutomationTree()) as { tree?: { bounds?: { width: number; height: number } } }).tree?.bounds;
	if (root && Math.round(root.width) !== size.width)
		throw new Error(
			`${SMALL_WINDOW}: ${Math.round(root.width)} x ${Math.round(root.height)}, not the ${size.width} x ${size.height} asked for. Is the display large enough?`,
		);
	await ui.waitFor("the first page of the list", () => store.total() > 0 && !!store.peek(0));
	await ui.settle(700);
	return ui;
}

/**
 * The packaged app, as it ships, on the background desktop: a process of its own, on this scenario's library and user folders
 * (src/automation.ts serves it). `exe` is zotero-next-gpui.exe of a package.
 */
export async function bootRemote(exe: string, options: ScenarioOptions, outDir: string, root: string, db: string): Promise<Ui> {
	const size = { width: options.width ?? 1440, height: options.height ?? 881 };
	const backend = await RemoteBackend.launch({ exe, root, db, size });
	const ui = new Ui(backend, backend.size, outDir);
	try {
		// every scenario's coordinates assume this size
		// (the app answers a query of the window's layout only once its first frame is drawn: ask until it does)
		let rootNode = null as Awaited<ReturnType<typeof backend.tree>>;
		for (const until = performance.now() + 40_000; ; await Bun.sleep(300)) {
			try {
				rootNode = await backend.tree();
				if (rootNode?.bounds) break;
			} catch (e) {
				if (performance.now() > until) throw e;
			}
			if (performance.now() > until) break;
		}
		const w = rootNode?.bounds?.width;
		if (w !== undefined && Math.round(w) !== size.width)
			throw new Error(`${SMALL_WINDOW}: ${Math.round(w)} x ${Math.round(rootNode!.bounds!.height)}, not the ${size.width} x ${size.height} asked for.`);
		await ui.waitFor("the first page of the list", async () => (await ui.store.total()) > 0 && !!(await ui.store.peek(0)), 30_000);
		await ui.settle(700);
	} catch (e) {
		await backend.close();
		throw e;
	}
	return ui;
}
