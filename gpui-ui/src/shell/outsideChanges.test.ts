import { afterEach, expect, test } from "bun:test";
import { setBaseUrl, setDirect } from "../api";
import { extMoved, startOutsideChangeWatch } from "./outsideChanges";

afterEach(() => setBaseUrl("http://127.0.0.1:23160"));

test("extMoved: the first answer is only the baseline", () => {
	expect(extMoved(null, 3)).toBe(false);
	expect(extMoved(3, 3)).toBe(false);
	expect(extMoved(3, 4)).toBe(true);
	expect(extMoved(4, 1)).toBe(true); // a restarted host counts from 1 again
	expect(extMoved(3, undefined)).toBe(false); // an older core without `ext`
});

test("calls onChange once per data_version change", async () => {
	let ext = 5;
	setDirect((r) => (new URL(r.url).pathname === "/api/ui/selection" ? Response.json({ selection: { kind: "library" }, rev: 1, ext }) : null));
	let changes = 0;
	const stop = startOutsideChangeWatch(() => changes++, 20);
	await Bun.sleep(60);
	expect(changes).toBe(0);
	ext = 6;
	await Bun.sleep(60);
	expect(changes).toBe(1);
	ext = 9;
	await Bun.sleep(60);
	stop();
	expect(changes).toBe(2);
});
