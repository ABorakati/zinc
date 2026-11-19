// Shared gesture state keeps pane docking separate from item drops.
import { afterEach, expect, test } from "bun:test";
import { dragging, dragLabel, dragPoint, dragSource, endDrag, moveDrag, setDragHook, startDrag, type DragPayload } from "./dnd";

afterEach(() => {
	setDragHook(undefined);
	endDrag();
});

test("item payloads keep their keys when the selection changes", () => {
	const keys = ["A", "B"];
	startDrag({ kind: "items", keys });
	keys.pop();
	expect(dragging()).toEqual({ kind: "items", keys: ["A", "B"] });
	expect(dragLabel()).toBe("2 items");
	endDrag();
	startDrag({ kind: "items", keys: [] });
	expect(dragging()).toBeNull();
});

test("pane payloads share the pointer and drag lifecycle", () => {
	const started: DragPayload[] = [];
	let ended = 0;
	setDragHook({ start: (p) => { started.push(p); }, end: () => { ended++; } });
	startDrag({ kind: "pane", id: "section:tags" });
	moveDrag(42, 80);
	expect(dragging()).toEqual({ kind: "pane", id: "section:tags" });
	expect(started).toEqual([{ kind: "pane", id: "section:tags" }]);
	expect(dragPoint()).toEqual({ x: 42, y: 80 });
	endDrag();
	expect(dragging()).toBeNull();
	expect(dragPoint()).toBeNull();
	expect(ended).toBe(1);
});

test("item sources neither move nor end a pane drag", () => {
	const source = dragSource(() => ["A"]);
	startDrag({ kind: "pane", id: "item" });
	moveDrag(10, 20);
	source.onMouseMove({ x: 90, y: 95 });
	source.onMouseUp();
	expect(dragging()).toEqual({ kind: "pane", id: "item" });
	expect(dragPoint()).toEqual({ x: 10, y: 20 });
});

test("item gestures retain their threshold and trailing-click guard", () => {
	const source = dragSource(() => ["A"]);
	source.onMouseDown({ x: 10, y: 10, button: 0 });
	source.onMouseMove({ x: 13, y: 10, pressedButton: 0 });
	expect(dragging()).toBeNull();
	source.onMouseMove({ x: 16, y: 10, pressedButton: 0 });
	expect(dragging()).toEqual({ kind: "items", keys: ["A"] });
	source.onMouseUp();
	expect(dragging()).toBeNull();
	expect(source.wasDrag()).toBe(true);
	expect(source.wasDrag()).toBe(false);
});
