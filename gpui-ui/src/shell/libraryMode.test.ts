import { expect, test } from "bun:test";
import { isBrowserLibrary, setBrowserLibrary } from "./libraryMode";

test("the browser-library flag is off until the extension page sets it", () => {
	expect(isBrowserLibrary()).toBe(false);
	setBrowserLibrary(true);
	expect(isBrowserLibrary()).toBe(true);
	setBrowserLibrary(false);
	expect(isBrowserLibrary()).toBe(false);
});
