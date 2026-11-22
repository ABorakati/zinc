// bun test src/ui/reconcile.test.tsx -- GPUIX's Solid renderer keeps the handlers of a node that a reconciliation moves.
//
// A node that is taken out and put back in the same batch was destroyed and created again under its own id; the list of destroyed ids
// that comes back from the batch then deleted the handlers just registered for it, and the element ignored every click from then on.
// The fake renderer below does what the native one does with a batch: it returns the ids it destroyed, descendants included.
import { describe, expect, test } from "bun:test";
import { createRoot } from "@gpuix/solid";
import { createSignal, type JSX } from "solid-js";

function fakeRenderer() {
	const children = new Map<number, number[]>();
	return {
		applyBatch(json: string): number[] {
			const destroyed: number[] = [];
			const drop = (id: number) => {
				destroyed.push(id);
				for (const c of children.get(id) ?? []) drop(c);
				children.delete(id);
				for (const list of children.values()) if (list.includes(id)) list.splice(list.indexOf(id), 1);
			};
			for (const [op, a, b] of JSON.parse(json) as [string, number, number][]) {
				if (op === "destroyElement") drop(a);
				else if (op === "appendChild" || op === "insertBefore") {
					for (const list of children.values()) if (list.includes(b)) list.splice(list.indexOf(b), 1);
					children.set(a, [...(children.get(a) ?? []), b]);
				}
			}
			return destroyed;
		},
	};
}

/** Mounts `before`, changes it to `after`, then clicks every row of `after`; returns the rows that heard it. */
async function clickAfter(before: string[], after: string[]): Promise<string[]> {
	const root = createRoot(fakeRenderer() as never);
	const nodes = new Map<string, { id: number }>();
	const heard: string[] = [];
	const made = new Map<string, JSX.Element>();
	const row = (name: string): JSX.Element => {
		if (!made.has(name))
			made.set(name, (<div ref={(el: { id: number }) => nodes.set(name, el)} onClick={() => heard.push(name)} />) as JSX.Element);
		return made.get(name)!;
	};
	let set!: (v: string[]) => void;
	root.render(() => {
		const [names, setNames] = createSignal(before);
		set = setNames;
		return (<div>{names().map(row) as never}</div>) as JSX.Element;
	});
	root.flush();
	set(after);
	await Promise.resolve();
	root.flush();
	for (const name of after) root.dispatch({ elementId: nodes.get(name)!.id, eventType: "click" } as never);
	root.unmount();
	return heard;
}

describe("a reconciliation that moves nodes", () => {
	test("rows between headers that were replaced still hear a click", async () => {
		const after = ["h26b", "item0", "h25b", "item1", "h24b", "item2"];
		expect(await clickAfter(["h26", "item0", "h25", "item1", "h24", "item2"], after)).toEqual(after);
	});

	test("every order of five rows still hears a click", async () => {
		const orders = (xs: string[]): string[][] => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
		const start = ["a", "b", "c", "d", "e"];
		const deaf: string[] = [];
		for (const after of orders(start)) if ((await clickAfter(start, after)).join() !== after.join()) deaf.push(after.join(""));
		expect(deaf).toEqual([]);
	});
});
