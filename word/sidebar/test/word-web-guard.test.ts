// What the popup's WebView2 accepts (WebGuard.cs): its own page only, and DevTools only when asked for. The C# harness is
// started; no Word, no WebView2 page. Skipped when the harness is not built (pwsh word/build.ps1 -Harness, or ZN_WORD_DIST).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const d = existsSync(HARNESS_EXE) ? describe : describe.skip;

d("popup guard without Word", () => {
	let h: HarnessHost;
	const guard = (uris: (string | null)[], envs: (string | null)[] = []) =>
		h.call<{ popup: boolean[]; devtools: boolean[]; url: string }>("h.webGuard", { uris, envs });

	beforeAll(async () => {
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-guard-"));
		h = await HarnessHost.start({ db: join(tmp, "none.sqlite"), settings: join(tmp, "settings.json"), cache: join(tmp, "cache") });
	}, 30_000);

	afterAll(async () => {
		await h?.stop();
	}, 30_000);

	test("the popup's own page still loads, and is the page its messages come from", async () => {
		const r = await guard(["https://zn-sidebar.local/popup.html", "https://ZN-SIDEBAR.LOCAL/popup.html", "https://zn-sidebar.local/popup.html?x=1#y"]);
		expect(r.popup).toEqual([true, true, true]);
		// the address the popup is pointed at is one it accepts
		expect((await guard([r.url])).popup).toEqual([true]);
	});

	test("any other address is refused", async () => {
		const r = await guard([
			"https://example.com/popup.html",
			"https://zn-sidebar.local.example.com/popup.html",
			"http://zn-sidebar.local/popup.html",
			"https://zn-sidebar.local/index.html",
			"https://zn-sidebar.local/popup.html/../index.html",
			"https://zn-sidebar.local:8443/popup.html",
			"https://user@zn-sidebar.local/popup.html",
			"about:blank",
			"file:///C:/x/popup.html",
			"popup.html",
			"",
			null,
		]);
		expect(r.popup).toEqual(r.popup.map(() => false));
	});

	test("DevTools are off unless ZN_DEVTOOLS is set", async () => {
		const r = await guard([], [null, "", "1"]);
		expect(r.devtools).toEqual([false, false, true]);
	});
});
