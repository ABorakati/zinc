// WebView2 life cycle without a GPUI window. Creating a view opens (hidden) native windows, so this runs only when asked for:
//   ZN_WEBVIEW_TESTS=1 bun test src/webview/host.test.ts
import { describe, expect, test } from "bun:test";
import { WebHost } from "./host";

const wanted = process.platform === "win32" && process.env.ZN_WEBVIEW_TESTS === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!wanted)("WebHost", () => {
	test("a view created right after another was released still gets its window", async () => {
		process.env.ZN_WEBVIEW_HEADLESS = "1";
		const host = new WebHost({ init: "" });
		for (let round = 0; round < 3; round++) {
			host.load("data:text/html,<h1>probe</h1>");
			for (let i = 0; (i < 100 && host.state() === "starting") || host.state() === "idle"; i++) await sleep(50);
			expect(host.error()).toBe("");
			expect(host.state()).toBe("ready");
			host.release(0);
			await sleep(60); // the release timer runs, teardown destroys the view and stops the message pump
			expect(host.alive).toBe(false);
		}
	});
});
