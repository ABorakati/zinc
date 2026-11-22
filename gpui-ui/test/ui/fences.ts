// What keeps a UI test away from the machine it runs on. Imported by worker.ts before any module of the app.
//
// Every scenario has its own user folders (run.ts redirects them). On top of that, here: no network, no child process, and none of the
// Win32 calls that reach the desktop (clipboard, shell open, OS drag, window icon). An attempt is recorded and fails the scenario.
import { plugin } from "bun";
import { readFile } from "node:fs/promises";

export const violations: string[] = [];

const refuse = (what: string): never => {
	violations.push(what);
	throw new Error(`UI test: ${what} is not allowed`);
};

/** The modules that call the desktop through user32: each already copes with a system that has no such library. */
const DESKTOP_MODULES =
	/[/\\]src[/\\](?:reader[/\\]core[/\\]sys|shell[/\\]clipboard-win|shell[/\\]dragout|shell[/\\]windowIcon|webview[/\\]win32)\.ts$/;

export function installFences(): void {
	plugin({
		name: "zinc-ui-test-fences",
		setup(build) {
			build.onLoad({ filter: DESKTOP_MODULES }, async ({ path }) => ({
				contents: (await readFile(path, "utf8")).replaceAll('"user32.dll"', '"zinc-ui-test-no-desktop.dll"'),
				loader: "ts",
			}));
		},
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (/^(?:data|blob|file):/i.test(url)) return realFetch(input, init);
			return refuse(`network request to ${url.slice(0, 120)}`);
		},
		{ preconnect: () => {} },
	) as typeof fetch;

	const spawnRefused = (cmd: unknown) => {
		const argv = Array.isArray(cmd) ? cmd : (cmd as { cmd?: string[] })?.cmd;
		return refuse(`starting a process (${String(argv?.[0] ?? cmd).slice(0, 120)})`);
	};
	Object.assign(Bun, { spawn: spawnRefused, spawnSync: spawnRefused });
}
