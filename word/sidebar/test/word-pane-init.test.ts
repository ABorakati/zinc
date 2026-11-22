// Settles whether the sidebar answers each RPC once after its window handle is recreated (what undocking or moving a task pane
// does to a WinForms control): the real PaneControl (WebView2 + the built sidebar) in the C# harness's off-screen window.
// It starts no Word and opens no library. Off by default: it starts a WebView2 (Edge) window.
//   pwsh word/build.ps1 -Harness          (or build into a scratch folder and set ZN_WORD_DIST to it)
//   ZN_PANE_E2E=1 bun test test/word-pane-init.test.ts
// Passes when one message is handled once after the handle was recreated. A failure here, with the harness log line
// "pane: init run 2, CoreWebView2 is the one already hooked", is the double subscription. Whether Word itself recreates the
// handle (undock, re-dock, a monitor with another DPI) is a separate question: count "pane: init run" in
// %LOCALAPPDATA%\ZoteroNextWord\addin.log after doing those things in a real Word.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_EXE, HarnessHost, SIDEBAR_DIR } from "./harness-host";

const ENABLED = process.env.ZN_PANE_E2E === "1";
const d = ENABLED ? describe : describe.skip;

d("sidebar pane after its handle is recreated", () => {
	let h: HarnessHost;

	beforeAll(async () => {
		if (!existsSync(HARNESS_EXE)) throw new Error("build the harness first: pwsh word/build.ps1 -Harness");
		if (!existsSync(join(SIDEBAR_DIR, "index.html"))) throw new Error("build the sidebar first: pwsh word/build.ps1 (or set ZN_WORD_DIST)");
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-pane-"));
		h = await HarnessHost.start({ db: join(tmp, "none.sqlite"), settings: join(tmp, "settings.json"), cache: join(tmp, "cache") });
		expect((await h.call<{ ready: boolean }>("h.pane")).ready).toBe(true);
	}, 90_000);

	afterAll(async () => {
		await h?.stop();
	}, 30_000);

	const send = async () => {
		await h.call("h.paneEval", { js: `window.chrome.webview.postMessage(JSON.stringify({ id: 1, method: "app.ping" })); 0` });
		await h.call("h.pump", { ms: 800 });
		return (await h.call<{ seen: number; initRuns: number }>("h.paneMessages")).seen;
	};

	test("a message is handled once before and after the handle is recreated", async () => {
		const s0 = await send();
		const s1 = await send();
		expect(s1 - s0).toBe(1);
		const r = await h.call<{ initRuns: number; ready: boolean; hasCore: boolean }>("h.paneRecreate");
		console.log("after RecreateHandle:", JSON.stringify(r));
		const s2 = await send();
		const s3 = await send();
		expect(s3 - s2).toBe(1);
	}, 60_000);
});
