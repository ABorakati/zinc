// bun test src/ui/clipboard.test.ts -- the plain-text clipboard's fallbacks per platform. The real clipboard is never touched: every
// source (the renderer, Win32, the helper programs) is a fake handed to makeClipboard.
import { describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off"; // clipboard.ts pulls in the store: never touch the user's saved list preferences

type Mod = typeof import("./clipboard");
let mod: Mod;
const load = async () => (mod ??= await import("./clipboard"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake machine: `has` lists the helper programs that exist; a run of any other program fails like a missing executable. */
function machine(platform: NodeJS.Platform, has: Record<string, { code?: number; out?: string }>) {
	const calls: { argv: string[]; stdin?: string }[] = [];
	const run: import("./clipboard").Run = async (argv, stdin) => {
		calls.push({ argv, stdin });
		const h = has[argv[0]!];
		if (!h) throw new Error(`Executable not found in $PATH: "${argv[0]}"`);
		return { code: h.code ?? 0, out: h.out ?? "" };
	};
	return { calls, run, platform };
}
const deps = (m: ReturnType<typeof machine>, extra: Partial<import("./clipboard").ClipDeps> = {}): import("./clipboard").ClipDeps => ({
	native: () => undefined,
	writeWin32: () => false,
	readWin32: () => null,
	...m,
	...extra,
});

describe("helper programs per platform", () => {
	test("macOS uses pbcopy / pbpaste, Linux tries Wayland then X11 tools, Windows uses PowerShell", async () => {
		const { clipboardHelpers } = await load();
		expect(clipboardHelpers("darwin").write.map((c) => c.argv[0])).toEqual(["pbcopy"]);
		expect(clipboardHelpers("darwin").read.map((c) => c.argv[0])).toEqual(["pbpaste"]);
		expect(clipboardHelpers("linux").write.map((c) => c.argv[0])).toEqual(["wl-copy", "xclip", "xsel"]);
		expect(clipboardHelpers("linux").read.map((c) => c.argv[0])).toEqual(["wl-paste", "xclip", "xsel"]);
		expect(clipboardHelpers("win32").write.map((c) => c.argv[0])).toEqual(["powershell"]);
		expect(clipboardHelpers("win32").read.map((c) => c.argv[0])).toEqual(["powershell"]);
	});
});

describe("writing text", () => {
	test("on Linux without wl-copy the next helper is used, and the text goes in on stdin", async () => {
		const { makeClipboard } = await load();
		const m = machine("linux", { xclip: {} });
		await makeClipboard(deps(m)).writeText("hello");
		expect(m.calls.map((c) => c.argv[0])).toEqual(["wl-copy", "xclip"]);
		expect(m.calls[1]!.stdin).toBe("hello");
	});
	test("a helper that fails (no display) hands over to the next one", async () => {
		const { makeClipboard } = await load();
		const m = machine("linux", { "wl-copy": { code: 1 }, xclip: {} });
		await makeClipboard(deps(m)).writeText("x");
		expect(m.calls.map((c) => c.argv[0])).toEqual(["wl-copy", "xclip"]);
	});
	test("macOS uses pbcopy", async () => {
		const { makeClipboard } = await load();
		const m = machine("darwin", { pbcopy: {} });
		await makeClipboard(deps(m)).writeText("x");
		expect(m.calls.map((c) => c.argv[0])).toEqual(["pbcopy"]);
	});
	test("the renderer's own method wins, then Win32, before any helper program", async () => {
		const { makeClipboard } = await load();
		const m = machine("win32", { powershell: {} });
		const put: string[] = [];
		await makeClipboard(deps(m, { native: () => ({ writeToClipboard: (s: string) => void put.push(s) }) })).writeText("a");
		expect(put).toEqual(["a"]);
		await makeClipboard(deps(m, { writeWin32: (s) => (put.push("w32:" + s), true) })).writeText("b");
		expect(put).toEqual(["a", "w32:b"]);
		expect(m.calls).toEqual([]);
	});
	test("no helper at all: the promise rejects, so an awaiting caller can tell", async () => {
		const { makeClipboard } = await load();
		const m = machine("linux", {});
		await expect(makeClipboard(deps(m)).writeText("x")).rejects.toThrow(/clipboard/i);
	});
	test("a caller that does not await (`void writeText(...)`) gets no unhandled rejection", async () => {
		const { makeClipboard } = await load();
		const seen: unknown[] = [];
		const on = (e: unknown) => void seen.push(e);
		process.on("unhandledRejection", on);
		try {
			void makeClipboard(deps(machine("linux", {}))).writeText("x");
			void makeClipboard(deps(machine("linux", {}))).readText();
			await sleep(50);
		} finally {
			process.off("unhandledRejection", on);
		}
		expect(seen).toEqual([]);
	});
});

describe("reading text", () => {
	test("pbpaste / xclip output is returned as it is", async () => {
		const { makeClipboard } = await load();
		const m = machine("linux", { "wl-paste": { code: 1 }, xclip: { out: "line\n" } });
		expect(await makeClipboard(deps(m)).readText()).toBe("line\n");
		expect(m.calls.map((c) => c.argv[0])).toEqual(["wl-paste", "xclip"]);
	});
	test("PowerShell's trailing line break is dropped", async () => {
		const { makeClipboard } = await load();
		const m = machine("win32", { powershell: { out: "text\r\n" } });
		expect(await makeClipboard(deps(m)).readText()).toBe("text");
	});
	test("an empty clipboard reads as an empty string, not as a failure", async () => {
		const { makeClipboard } = await load();
		const m = machine("darwin", { pbpaste: { out: "" } });
		expect(await makeClipboard(deps(m)).readText()).toBe("");
	});
});
