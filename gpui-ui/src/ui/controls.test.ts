// bun test src/ui/controls.test.ts -- the keyboard activation shared by Button, Checkbox, Switch, Tabs and Select.
import { describe, expect, test } from "bun:test";
import { isActivateKey, onActivate } from "./controls";

const key = (k: string, extra: object = {}) => ({ key: k, elementId: 1, eventType: "keyDown", preventDefault() { (this as { prevented?: boolean }).prevented = true; }, stopPropagation() { (this as { stopped?: boolean }).stopped = true; }, ...extra }) as never;

describe("activation keys", () => {
	test("Enter and Space activate, other keys do not", () => {
		for (const k of ["enter", "Enter", "space", " "]) expect(isActivateKey({ key: k })).toBe(true);
		for (const k of ["tab", "escape", "a", "down", undefined]) expect(isActivateKey({ key: k as string | undefined })).toBe(false);
	});
	test("the handler runs the action once per press and swallows the key", () => {
		let n = 0;
		const h = onActivate(() => n++);
		const e = key("space");
		h(e);
		expect(n).toBe(1);
		expect((e as { prevented?: boolean; stopped?: boolean }).prevented).toBe(true);
		expect((e as { stopped?: boolean }).stopped).toBe(true);
		h(key("a"));
		expect(n).toBe(1);
		h(key("enter", { isHeld: true })); // key repeat does not re-fire
		expect(n).toBe(1);
	});
	test("a disabled control swallows the key but does nothing", () => {
		let n = 0;
		const h = onActivate(() => n++, () => true);
		h(key("enter"));
		expect(n).toBe(0);
	});
});
